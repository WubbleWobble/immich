import { Kysely } from 'kysely';
import { SyncEntityType, SyncRequestType } from 'src/enum.js';
import { LockRepository } from 'src/repositories/lock.repository.js';
import { DB } from 'src/schema/index.js';
import { SyncTestContext } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB, wait } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = async (db?: Kysely<DB>) => {
  const ctx = new SyncTestContext(db || defaultDatabase);
  const { auth, user, session } = await ctx.newSyncAuthUser();
  return { auth, user, session, ctx };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

/** A partner library with one hidden asset (in a locked album), one visible asset, exif rows and two stacks. */
const newLockedPartnerLibrary = async (ctx: SyncTestContext) => {
  const { user: partner } = await ctx.newUser();
  const newAssetWithExif = async (make: string) => {
    const { asset } = await ctx.newAsset({ ownerId: partner.id });
    await ctx.newExif({ assetId: asset.id, make });
    return asset;
  };
  const hidden = await newAssetWithExif('Hidden');
  const visible = await newAssetWithExif('Visible');
  const stackedVisible = await newAssetWithExif('StackedVisible');
  const otherVisible = await newAssetWithExif('OtherVisible');
  const { album } = await ctx.newAlbum({ ownerId: partner.id }, [hidden.id]);
  await ctx.get(LockRepository).lockAlbum(partner.id, album.id);
  // the primary is visible, but a hidden member still makes the stack hidden content
  const { stack: hiddenStack } = await ctx.newStack({ ownerId: partner.id }, [stackedVisible.id, hidden.id]);
  const { stack: visibleStack } = await ctx.newStack({ ownerId: partner.id }, [visible.id, otherVisible.id]);
  return { partner, album, hidden, visible, stackedVisible, otherVisible, hiddenStack, visibleStack };
};

const ids = (response: Array<{ type: string; data: unknown }>, type: SyncEntityType, key: 'id' | 'assetId') =>
  response
    .filter((item) => item.type === type)
    .map((item) => (item.data as Record<string, string>)[key])
    .toSorted();

/**
 * Fork (lock spec §7, final fix wave F1): the PARTNER streams follow the partner's own locks, so a partner's
 * effectively-hidden asset, its exif row and any stack holding it never reach the viewer's device. The owner's own
 * streams stay unfiltered (spec §13).
 */
describe('partner sync streams honour the partner owner locks', () => {
  it('upserts omit the hidden asset, its exif row and its stack', async () => {
    const { auth, ctx } = await setup();
    const library = await newLockedPartnerLibrary(ctx);
    await ctx.newPartner({ sharedById: library.partner.id, sharedWithId: auth.user.id });

    const assets = await ctx.syncStream(auth, [SyncRequestType.PartnerAssetsV2]);
    expect(ids(assets, SyncEntityType.PartnerAssetV2, 'id')).toEqual(
      [library.visible.id, library.stackedVisible.id, library.otherVisible.id].toSorted(),
    );

    const exifs = await ctx.syncStream(auth, [SyncRequestType.PartnerAssetExifsV1]);
    expect(ids(exifs, SyncEntityType.PartnerAssetExifV1, 'assetId')).toEqual(
      [library.visible.id, library.stackedVisible.id, library.otherVisible.id].toSorted(),
    );

    const stacks = await ctx.syncStream(auth, [SyncRequestType.PartnerStacksV1]);
    expect(ids(stacks, SyncEntityType.PartnerStackV1, 'id')).toEqual([library.visibleStack.id]);
  });

  it('backfill omits the hidden asset, its exif row and its stack', async () => {
    const { auth, ctx } = await setup();
    // the late partner's library predates the checkpoint, so it arrives through backfill
    const library = await newLockedPartnerLibrary(ctx);
    await wait(2);
    const { user: firstPartner } = await ctx.newUser();
    const { asset: firstAsset } = await ctx.newAsset({ ownerId: firstPartner.id });
    await ctx.newExif({ assetId: firstAsset.id, make: 'First' });
    const { stack: firstStack } = await ctx.newStack({ ownerId: firstPartner.id }, [firstAsset.id]);
    await ctx.newPartner({ sharedById: firstPartner.id, sharedWithId: auth.user.id });

    const types = [
      SyncRequestType.PartnerAssetsV2,
      SyncRequestType.PartnerAssetExifsV1,
      SyncRequestType.PartnerStacksV1,
    ];
    const initial = await ctx.syncStream(auth, types);
    expect(ids(initial, SyncEntityType.PartnerAssetV2, 'id')).toEqual([firstAsset.id]);
    expect(ids(initial, SyncEntityType.PartnerAssetExifV1, 'assetId')).toEqual([firstAsset.id]);
    expect(ids(initial, SyncEntityType.PartnerStackV1, 'id')).toEqual([firstStack.id]);
    await ctx.syncAckAll(auth, initial);

    await ctx.newPartner({ sharedById: library.partner.id, sharedWithId: auth.user.id });
    const backfill = await ctx.syncStream(auth, types);
    const visibleIds = [library.visible.id, library.stackedVisible.id, library.otherVisible.id].toSorted();
    expect(ids(backfill, SyncEntityType.PartnerAssetBackfillV2, 'id')).toEqual(visibleIds);
    expect(ids(backfill, SyncEntityType.PartnerAssetExifBackfillV1, 'assetId')).toEqual(visibleIds);
    expect(ids(backfill, SyncEntityType.PartnerStackBackfillV1, 'id')).toEqual([library.visibleStack.id]);
    expect(JSON.stringify(backfill)).not.toContain(library.hidden.id);

    await ctx.syncAckAll(auth, backfill);
    await ctx.assertSyncIsComplete(auth, types);
  });

  it('still streams everything when the partner hides nothing', async () => {
    const { auth, ctx } = await setup();
    const library = await newLockedPartnerLibrary(ctx);
    await ctx.get(LockRepository).unlockAlbum(library.partner.id, library.album.id);
    await ctx.newPartner({ sharedById: library.partner.id, sharedWithId: auth.user.id });

    const response = await ctx.syncStream(auth, [
      SyncRequestType.PartnerAssetsV2,
      SyncRequestType.PartnerAssetExifsV1,
      SyncRequestType.PartnerStacksV1,
    ]);
    const all = [library.hidden.id, library.visible.id, library.stackedVisible.id, library.otherVisible.id].toSorted();
    expect(ids(response, SyncEntityType.PartnerAssetV2, 'id')).toEqual(all);
    expect(ids(response, SyncEntityType.PartnerAssetExifV1, 'assetId')).toEqual(all);
    expect(ids(response, SyncEntityType.PartnerStackV1, 'id')).toEqual(
      [library.hiddenStack.id, library.visibleStack.id].toSorted(),
    );
  });

  it("leaves the owner's own streams unfiltered", async () => {
    const { ctx } = await setup();
    const library = await newLockedPartnerLibrary(ctx);
    const { session } = await ctx.newSession({ userId: library.partner.id });
    const ownerAuth = factory.auth({ session, user: { id: library.partner.id } });

    const response = await ctx.syncStream(ownerAuth, [
      SyncRequestType.AssetsV2,
      SyncRequestType.AssetExifsV1,
      SyncRequestType.StacksV1,
    ]);
    const all = [library.hidden.id, library.visible.id, library.stackedVisible.id, library.otherVisible.id].toSorted();
    expect(ids(response, SyncEntityType.AssetV2, 'id')).toEqual(all);
    expect(ids(response, SyncEntityType.AssetExifV1, 'assetId')).toEqual(all);
    expect(ids(response, SyncEntityType.StackV1, 'id')).toEqual(
      [library.hiddenStack.id, library.visibleStack.id].toSorted(),
    );
  });
});
