import { Kysely } from 'kysely';
import { SyncEntityType, SyncRequestType } from 'src/enum.js';
import { LockRepository } from 'src/repositories/lock.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { DB } from 'src/schema/index.js';
import { SyncTestContext } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

const faceIds = (response: Array<{ type: string; data: unknown }>) =>
  response
    .filter((item) => item.type === SyncEntityType.AssetFaceV3)
    .map((item) => (item.data as { id: string }).id)
    .toSorted();

const deletedFaceIds = (response: Array<{ type: string; data: unknown }>) =>
  response
    .filter((item) => item.type === SyncEntityType.AssetFaceDeleteV1)
    .map((item) => (item.data as { assetFaceId: string }).assetFaceId)
    .toSorted();

/**
 * A viewer and a cluster peer (same recognition cluster). The peer has one photo in a locked regular album and one
 * visible photo, each with a face.
 */
const setup = async () => {
  const ctx = new SyncTestContext(defaultDatabase);
  const { auth, user, session } = await ctx.newSyncAuthUser();
  const { user: peer } = await ctx.newUser({ clusterGroupId: user.clusterGroupId });
  const { person } = await ctx.newPerson({ ownerId: peer.id });
  const { asset: hidden } = await ctx.newAsset({ ownerId: peer.id });
  const { asset: visible } = await ctx.newAsset({ ownerId: peer.id });
  const { assetFace: hiddenFace } = await ctx.newAssetFace({ assetId: hidden.id, personGroupId: person.personGroupId });
  const { assetFace: visibleFace } = await ctx.newAssetFace({
    assetId: visible.id,
    personGroupId: person.personGroupId,
  });
  const { album } = await ctx.newAlbum({ ownerId: peer.id }, [hidden.id]);
  await ctx.get(LockRepository).lockAlbum(peer.id, album.id);
  return { ctx, auth, user, session, peer, person, hidden, visible, hiddenFace, visibleFace, album };
};

/**
 * Fork (F3): AssetFacesV3 streams the faces of every cluster member's photos. A FOREIGN owner's photo that is hidden by
 * that owner's own locks (no reveal, never the viewer's elevation) must not reach the viewer's device, neither as a face
 * upsert nor as a face deletion record. The requester's own rows stay unfiltered (R43 own-device deferral).
 */
describe('AssetFacesV3 honours foreign cluster owners locks', () => {
  it("omits a foreign owner's lock-hidden photo faces on a fresh device and still streams the visible ones", async () => {
    const { ctx, auth, visibleFace, hidden } = await setup();

    const response = await ctx.syncStream(auth, [SyncRequestType.AssetFacesV3]);
    expect(faceIds(response)).toEqual([visibleFace.id]);
    expect(JSON.stringify(response)).not.toContain(hidden.id);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetFacesV3]);
  });

  it("ignores the viewer's elevation and reveal for a foreign owner's locks", async () => {
    const { ctx, user, session, album, visibleFace } = await setup();
    const elevated = factory.auth({ session: { id: session.id, hasElevatedPermission: true }, user: { id: user.id } });
    elevated.revealedLocks = { albumIds: [album.id], containerIds: [] };

    const response = await ctx.syncStream(elevated, [SyncRequestType.AssetFacesV3]);
    expect(faceIds(response)).toEqual([visibleFace.id]);
  });

  it("does not stream a face deletion from a foreign owner's still-live lock-hidden photo", async () => {
    const { ctx, auth, hiddenFace, visibleFace } = await setup();
    const personRepo = ctx.get(PersonRepository);
    await personRepo.deleteAssetFace(hiddenFace.id);
    await personRepo.deleteAssetFace(visibleFace.id);

    const response = await ctx.syncStream(auth, [SyncRequestType.AssetFacesV3]);
    expect(deletedFaceIds(response)).toEqual([visibleFace.id]);
    expect(JSON.stringify(response)).not.toContain(hiddenFace.id);
  });

  it("does not stream face deletions of a foreign owner's photo deleted while hidden", async () => {
    const { ctx, auth, hidden, hiddenFace } = await setup();
    await ctx.database.deleteFrom('asset').where('id', '=', hidden.id).execute();
    await ctx.database.updateTable('asset_audit').set({ ownerHidden: true }).where('assetId', '=', hidden.id).execute();

    const response = await ctx.syncStream(auth, [SyncRequestType.AssetFacesV3]);
    expect(JSON.stringify(response)).not.toContain(hiddenFace.id);
  });

  it("streams the foreign faces again once the owner unlocks, and the owner's own stream stays unfiltered", async () => {
    const { ctx, peer, album, hiddenFace, visibleFace } = await setup();

    // the owner's own device: no filtering of their own rows (R43)
    const { session } = await ctx.newSession({ userId: peer.id });
    const ownerAuth = factory.auth({ session, user: { id: peer.id } });
    const own = await ctx.syncStream(ownerAuth, [SyncRequestType.AssetFacesV3]);
    expect(faceIds(own)).toEqual([hiddenFace.id, visibleFace.id].toSorted());

    // a second viewer in the cluster sees everything once nothing is hidden any more
    const { user: other } = await ctx.newUser({ clusterGroupId: peer.clusterGroupId });
    const { session: otherSession } = await ctx.newSession({ userId: other.id });
    const otherAuth = factory.auth({ session: otherSession, user: { id: other.id } });
    await ctx.get(LockRepository).unlockAlbum(peer.id, album.id);
    const response = await ctx.syncStream(otherAuth, [SyncRequestType.AssetFacesV3]);
    expect(faceIds(response)).toEqual([hiddenFace.id, visibleFace.id].toSorted());
  });

  it("keeps the viewer's own lock-hidden faces in the viewer's own stream", async () => {
    const { ctx, auth, user, visibleFace } = await setup();
    const { asset: ownHidden } = await ctx.newAsset({ ownerId: user.id });
    const { assetFace: ownFace } = await ctx.newAssetFace({ assetId: ownHidden.id });
    const { album: ownAlbum } = await ctx.newAlbum({ ownerId: user.id }, [ownHidden.id]);
    await ctx.get(LockRepository).lockAlbum(user.id, ownAlbum.id);

    const response = await ctx.syncStream(auth, [SyncRequestType.AssetFacesV3]);
    expect(faceIds(response)).toEqual([ownFace.id, visibleFace.id].toSorted());
  });

  it('gives an outsider none of the cluster faces', async () => {
    const { ctx, hiddenFace, visibleFace } = await setup();
    const { auth: outsider } = await ctx.newSyncAuthUser();

    const response = await ctx.syncStream(outsider, [SyncRequestType.AssetFacesV3]);
    expect(JSON.stringify(response)).not.toContain(hiddenFace.id);
    expect(JSON.stringify(response)).not.toContain(visibleFace.id);
  });
});
