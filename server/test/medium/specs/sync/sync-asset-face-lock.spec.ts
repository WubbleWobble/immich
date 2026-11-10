import { Kysely } from 'kysely';
import { AlbumKind, AssetStatus, SyncEntityType, SyncRequestType } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LockRepository } from 'src/repositories/lock.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { SyncRepository } from 'src/repositories/sync.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { DB } from 'src/schema/index.js';
import { upsertTags } from 'src/utils/tag.js';
import { SyncTestContext } from 'test/medium.factory.js';
import { factory, newUuidV7 } from 'test/small.factory.js';
import { getKyselyDB, wait } from 'test/utils.js';

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

/** A cluster peer whose photo is hidden by a lock on an album the peer is a SHAREE of (kept by admin soft-delete). */
const setupShareeLock = async () => {
  const ctx = new SyncTestContext(defaultDatabase);
  const { auth, user } = await ctx.newSyncAuthUser();
  const { user: peer } = await ctx.newUser({ clusterGroupId: user.clusterGroupId });
  const { user: albumOwner } = await ctx.newUser();
  const { asset: hidden } = await ctx.newAsset({ ownerId: peer.id });
  const { asset: visible } = await ctx.newAsset({ ownerId: peer.id });
  const { assetFace: hiddenFace } = await ctx.newAssetFace({ assetId: hidden.id });
  const { assetFace: visibleFace } = await ctx.newAssetFace({ assetId: visible.id });
  const { album } = await ctx.newAlbum({ ownerId: albumOwner.id }, [hidden.id]);
  await ctx.newAlbumUser({ albumId: album.id, userId: peer.id });
  await ctx.get(LockRepository).lockAlbum(peer.id, album.id);
  return { ctx, auth, user, peer, hidden, hiddenFace, visibleFace };
};

const softDelete = (ctx: SyncTestContext, userId: string) =>
  ctx.database.updateTable('user').set({ deletedAt: new Date() }).where('id', '=', userId).execute();

/**
 * Fork (F3 fix round 1): the V3 streams only carry rows of owners that were judged - the requester and the peers the
 * lock entries were computed from. A soft-deleted peer is still a peer (judged by their own locks during the grace
 * period, so their visible faces keep streaming as upstream did); an owner outside the judged list never streams.
 */
describe('AssetFacesV3 only streams judged owners', () => {
  it("withholds a soft-deleted peer's lock-hidden face and its deletion record", async () => {
    const { ctx, auth, peer, hiddenFace, visibleFace } = await setupShareeLock();
    await softDelete(ctx, peer.id);

    const upserts = await ctx.syncStream(auth, [SyncRequestType.AssetFacesV3]);
    expect(JSON.stringify(upserts)).not.toContain(hiddenFace.id);
    await ctx.syncAckAll(auth, upserts);

    await ctx.get(PersonRepository).deleteAssetFace(hiddenFace.id);
    await ctx.get(PersonRepository).deleteAssetFace(visibleFace.id);
    const deletes = await ctx.syncStream(auth, [SyncRequestType.AssetFacesV3]);
    expect(deletedFaceIds(deletes)).toEqual([visibleFace.id]);
    expect(JSON.stringify(deletes)).not.toContain(hiddenFace.id);
  });

  it("keeps streaming a soft-deleted peer's visible faces, judged by the peer's locks", async () => {
    const { ctx, auth, peer, visibleFace } = await setupShareeLock();
    await softDelete(ctx, peer.id);

    const response = await ctx.syncStream(auth, [SyncRequestType.AssetFacesV3]);
    expect(faceIds(response)).toEqual([visibleFace.id]);
  });

  it('does not stream a peer that joined after the owner list was judged', async () => {
    const { ctx, user, hiddenFace, visibleFace } = await setupShareeLock();
    const { asset: own } = await ctx.newAsset({ ownerId: user.id });
    const { assetFace: ownFace } = await ctx.newAssetFace({ assetId: own.id });
    await ctx.get(PersonRepository).deleteAssetFace(visibleFace.id);
    await wait(2);

    // the judged list predates the peer: only the requester was judged
    const options = { nowId: newUuidV7(), userId: user.id };
    const judged = { ownerIds: [user.id], lockVisibility: [] };
    const sync = ctx.get(SyncRepository).assetFace;
    const upserts = [];
    for await (const row of sync.getUpsertsV3(options, judged)) {
      upserts.push(row.id);
    }
    const deletes = [];
    for await (const row of sync.getDeletesV3(options, judged)) {
      deletes.push(row.assetFaceId);
    }
    expect(upserts).toEqual([ownFace.id]);
    expect(deletes).toEqual([]);
    expect([...upserts, ...deletes]).not.toContain(hiddenFace.id);
  });

  it('leaves own rows and live peers unchanged', async () => {
    const { ctx, auth, user, visibleFace } = await setupShareeLock();
    const { asset: own } = await ctx.newAsset({ ownerId: user.id });
    const { assetFace: ownFace } = await ctx.newAssetFace({ assetId: own.id });

    const response = await ctx.syncStream(auth, [SyncRequestType.AssetFacesV3]);
    expect(faceIds(response)).toEqual([ownFace.id, visibleFace.id].toSorted());
  });
});

type SmartCriterion = 'tag' | 'person' | 'favorite';

/**
 * R79: a cluster peer's photo protected ONLY by the peer's locked smart album on `criterion` (no regular album), plus
 * a visible photo. Both carry a face of the peer's person.
 */
const setupSmartLocked = async (criterion: SmartCriterion) => {
  const ctx = new SyncTestContext(defaultDatabase);
  const { user } = await ctx.newSyncAuthUser();
  const { user: peer } = await ctx.newUser({ clusterGroupId: user.clusterGroupId });
  const { person } = await ctx.newPerson({ ownerId: peer.id });
  const { asset: hidden } = await ctx.newAsset({ ownerId: peer.id, isFavorite: criterion === 'favorite' });
  const { asset: visible } = await ctx.newAsset({ ownerId: peer.id });
  const { assetFace: hiddenFace } = await ctx.newAssetFace({ assetId: hidden.id, personGroupId: person.personGroupId });
  const { assetFace: visibleFace } = await ctx.newAssetFace({
    assetId: visible.id,
    personGroupId: person.personGroupId,
  });
  // the visible photo is in an unlocked regular album, which rescues it from a criterion it may share
  await ctx.newAlbum({ ownerId: peer.id }, [visible.id]);
  let filter: object;
  switch (criterion) {
    case 'tag': {
      const [tag] = await upsertTags(ctx.get(TagRepository), { userId: peer.id, tags: ['private'] });
      await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [hidden.id] });
      filter = { tagIds: [tag.id] };
      break;
    }
    case 'person': {
      filter = { personIds: [person.personGroupId] };
      break;
    }
    case 'favorite': {
      filter = { isFavorite: true };
      break;
    }
  }
  const { album: lockedSmart } = await ctx.newAlbum({ ownerId: peer.id, kind: AlbumKind.Smart, filter: filter as any });
  await ctx.get(LockRepository).lockAlbum(peer.id, lockedSmart.id);
  /** A fresh device of the viewer: no delivery history. */
  const freshDevice = async () => {
    const { session } = await ctx.newSession({ userId: user.id });
    return factory.auth({ session, user: { id: user.id, name: user.name, email: user.email } });
  };
  /** The owner's trash write (AssetService.deleteAll without force, after its access check). */
  const trash = (assetId: string) =>
    ctx.get(AssetRepository).updateAll([assetId], { deletedAt: new Date(), status: AssetStatus.Trashed });
  return { ctx, user, peer, person, hidden, visible, hiddenFace, visibleFace, filter, lockedSmart, freshDevice, trash };
};

/**
 * Fork (ruling R79): privacy judgment does not depend on trash state. A foreign photo hidden only by its owner's
 * locked smart album stays hidden from AssetFacesV3 once the owner trashes it, and a photo an unlocked smart album
 * rescues stays visible.
 */
describe('AssetFacesV3 keeps a trashed photo smart-lock verdict (R79)', () => {
  for (const criterion of ['tag', 'person', 'favorite'] as const) {
    it(`a locked smart album on a ${criterion} keeps a trashed foreign photo out of a fresh face sync`, async () => {
      const { ctx, hidden, hiddenFace, visibleFace, freshDevice, trash } = await setupSmartLocked(criterion);

      const before = await ctx.syncStream(await freshDevice(), [SyncRequestType.AssetFacesV3]);
      expect(faceIds(before)).toEqual([visibleFace.id]);

      await trash(hidden.id);
      const after = await ctx.syncStream(await freshDevice(), [SyncRequestType.AssetFacesV3]);
      expect(faceIds(after)).toEqual([visibleFace.id]);
      expect(JSON.stringify(after)).not.toContain(hidden.id);
      expect(JSON.stringify(after)).not.toContain(hiddenFace.id);
    });
  }

  it('rescue: a photo matched by a locked and an unlocked smart album streams before and after trash', async () => {
    const { ctx, peer, hidden, hiddenFace, visibleFace, filter, freshDevice, trash } = await setupSmartLocked('tag');
    await ctx.newAlbum({ ownerId: peer.id, kind: AlbumKind.Smart, filter: filter as any });
    const expected = [hiddenFace.id, visibleFace.id].toSorted();

    expect(faceIds(await ctx.syncStream(await freshDevice(), [SyncRequestType.AssetFacesV3]))).toEqual(expected);
    await trash(hidden.id);
    expect(faceIds(await ctx.syncStream(await freshDevice(), [SyncRequestType.AssetFacesV3]))).toEqual(expected);
  });

  it('control: a locked regular album keeps a trashed foreign photo out of a fresh face sync', async () => {
    const { ctx, auth, hidden, hiddenFace, visibleFace } = await setup();
    await ctx.get(AssetRepository).updateAll([hidden.id], { deletedAt: new Date(), status: AssetStatus.Trashed });

    const response = await ctx.syncStream(auth, [SyncRequestType.AssetFacesV3]);
    expect(faceIds(response)).toEqual([visibleFace.id]);
    expect(JSON.stringify(response)).not.toContain(hidden.id);
    expect(JSON.stringify(response)).not.toContain(hiddenFace.id);
  });
});
