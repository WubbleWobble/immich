import { Kysely } from 'kysely';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  AlbumKind,
  AssetStatus,
  AssetType,
  AssetVisibility,
  JobStatus,
  SyncEntityType,
  SyncRequestType,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LockRepository } from 'src/repositories/lock.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SharedLinkAssetRepository } from 'src/repositories/shared-link-asset.repository.js';
import { StackRepository } from 'src/repositories/stack.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetService } from 'src/services/asset.service.js';
import { LibraryService } from 'src/services/library.service.js';
import { StackService } from 'src/services/stack.service.js';
import { upsertTags } from 'src/utils/tag.js';
import { SyncTestContext, newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

/** The partner's library: a hidden asset (in a locked album) stacked with a visible one, plus a visible stack. */
const newLockedPartnerLibrary = async (ctx: SyncTestContext, viewer: AuthDto) => {
  const { user: owner } = await ctx.newUser();
  const newAsset = async () => {
    const { asset } = await ctx.newAsset({ ownerId: owner.id });
    return asset;
  };
  const hidden = await newAsset();
  const visible = await newAsset();
  const stackedVisible = await newAsset();
  const otherVisible = await newAsset();
  const anotherVisible = await newAsset();
  const { album } = await ctx.newAlbum({ ownerId: owner.id }, [hidden.id]);
  await ctx.get(LockRepository).lockAlbum(owner.id, album.id);
  // the primary is visible, but a hidden member makes the stack hidden content for partners (noHiddenMember)
  const { stack: hiddenStack } = await ctx.newStack({ ownerId: owner.id }, [stackedVisible.id, hidden.id]);
  const { stack: visibleStack } = await ctx.newStack({ ownerId: owner.id }, [otherVisible.id, anotherVisible.id]);
  await ctx.newPartner({ sharedById: owner.id, sharedWithId: viewer.user.id });
  const elevatedOwner = factory.auth({ user: { id: owner.id }, session: { hasElevatedPermission: true } });
  return { owner, elevatedOwner, hidden, visible, stackedVisible, otherVisible, hiddenStack, visibleStack };
};

const assetService = (database: Kysely<DB>) => {
  const { sut, ctx } = newMediumService(AssetService, {
    database,
    real: [
      LockRepository,
      AssetRepository,
      AssetEditRepository,
      AssetJobRepository,
      AlbumRepository,
      AccessRepository,
      SharedLinkAssetRepository,
      SessionRepository,
      StackRepository,
      UserRepository,
    ],
    mock: [EventRepository, LoggingRepository, JobRepository, StorageRepository, WebsocketRepository],
  });
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  ctx.getMock(JobRepository).queue.mockResolvedValue();
  return sut;
};

const stackService = (database: Kysely<DB>) => {
  const { sut, ctx } = newMediumService(StackService, {
    database,
    real: [AccessRepository, AlbumRepository, AssetRepository, LockRepository, StackRepository],
    mock: [EventRepository, LoggingRepository],
  });
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  return sut;
};

const deletedIds = (response: Array<{ type: string; data: unknown }>, type: SyncEntityType) =>
  response
    .filter((item) => item.type === type)
    .map((item) => {
      const data = item.data as { assetId?: string; stackId?: string };
      return data.assetId ?? data.stackId!;
    })
    .toSorted();

const setup = async () => {
  const ctx = new SyncTestContext(defaultDatabase);
  const { auth, user } = await ctx.newSyncAuthUser();
  const library = await newLockedPartnerLibrary(ctx, auth);
  // a second device of the viewer with no delivery history
  const { session } = await ctx.newSession({ userId: user.id });
  const freshDevice = factory.auth({ session, user: { id: user.id, name: user.name, email: user.email } });
  return { ctx, auth, freshDevice, ...library };
};

/**
 * Fork (ruling R66): the partner delete streams read the pre-delete lock verdict persisted on the audit row
 * (`ownerHidden`), so a partner never learns the id of a hidden asset or stack it was never sent. The owner's own
 * streams stay unfiltered (R43); legacy audit rows without a verdict stream as before.
 */
describe('partner delete streams honour the pre-delete lock verdict (R66)', () => {
  it("a hidden asset's deletion (and the stack it dissolves) never reaches the partner; a visible one does", async () => {
    const { ctx, auth, freshDevice, hidden, visible, hiddenStack } = await setup();
    const assets = assetService(ctx.database);

    await assets.handleAssetDeletion({ id: hidden.id, deleteOnDisk: false });
    await assets.handleAssetDeletion({ id: visible.id, deleteOnDisk: false });

    for (const viewer of [auth, freshDevice]) {
      const assetStream = await ctx.syncStream(viewer, [SyncRequestType.PartnerAssetsV2]);
      expect(deletedIds(assetStream, SyncEntityType.PartnerAssetDeleteV1)).toEqual([visible.id]);
      expect(JSON.stringify(assetStream)).not.toContain(hidden.id);

      // the hidden asset's removal left one member: the stack was dissolved, and it was hidden content too
      const stackStream = await ctx.syncStream(viewer, [SyncRequestType.PartnerStacksV1]);
      expect(deletedIds(stackStream, SyncEntityType.PartnerStackDeleteV1)).toEqual([]);
      expect(JSON.stringify(stackStream)).not.toContain(hiddenStack.id);
    }
  });

  it("a hidden stack's deletion by its elevated owner never reaches the partner; a visible stack's does", async () => {
    const { ctx, auth, freshDevice, elevatedOwner, hiddenStack, visibleStack } = await setup();
    const stacks = stackService(ctx.database);

    await stacks.delete(elevatedOwner, hiddenStack.id);
    await stacks.delete(elevatedOwner, visibleStack.id);

    for (const viewer of [auth, freshDevice]) {
      const response = await ctx.syncStream(viewer, [SyncRequestType.PartnerStacksV1]);
      expect(deletedIds(response, SyncEntityType.PartnerStackDeleteV1)).toEqual([visibleStack.id]);
      expect(JSON.stringify(response)).not.toContain(hiddenStack.id);
    }
  });

  it('a bulk stack delete flags only the hidden stacks', async () => {
    const { ctx, auth, elevatedOwner, hiddenStack, visibleStack } = await setup();
    const stacks = stackService(ctx.database);

    await stacks.deleteAll(elevatedOwner, { ids: [hiddenStack.id, visibleStack.id] });

    const response = await ctx.syncStream(auth, [SyncRequestType.PartnerStacksV1]);
    expect(deletedIds(response, SyncEntityType.PartnerStackDeleteV1)).toEqual([visibleStack.id]);
  });

  it('a stack dissolved by merging into a new stack (elevated stack create) is flagged when it was hidden', async () => {
    const { ctx, auth, elevatedOwner, stackedVisible, otherVisible, hiddenStack, visibleStack } = await setup();
    const stacks = stackService(ctx.database);

    // both existing stacks are merged into the new one (their primaries are the requested assets)
    await stacks.create(elevatedOwner, { assetIds: [stackedVisible.id, otherVisible.id] });

    const response = await ctx.syncStream(auth, [SyncRequestType.PartnerStacksV1]);
    expect(deletedIds(response, SyncEntityType.PartnerStackDeleteV1)).toEqual([visibleStack.id]);
    expect(JSON.stringify(response)).not.toContain(hiddenStack.id);
  });

  it('a source stack dissolved by an asset copy is flagged when it was hidden', async () => {
    const { ctx, auth, elevatedOwner, stackedVisible, otherVisible, hiddenStack, visibleStack } = await setup();
    const assets = assetService(ctx.database);

    // the hidden stack's members move into the visible stack and the hidden stack is deleted
    await assets.copy(elevatedOwner, {
      sourceId: stackedVisible.id,
      targetId: otherVisible.id,
      albums: false,
      sidecar: false,
      sharedLinks: false,
      stack: true,
      favorite: false,
    });

    const response = await ctx.syncStream(auth, [SyncRequestType.PartnerStacksV1]);
    expect(deletedIds(response, SyncEntityType.PartnerStackDeleteV1)).toEqual([]);
    expect(JSON.stringify(response)).not.toContain(hiddenStack.id);
    // the surviving stack now holds a hidden member and is withheld as a live row too
    expect(JSON.stringify(response)).not.toContain(visibleStack.id);
  });

  it("the owner's own streams still carry every deletion", async () => {
    const { ctx, owner, elevatedOwner, hidden, visible, hiddenStack, visibleStack } = await setup();
    const assets = assetService(ctx.database);
    const stacks = stackService(ctx.database);
    await stacks.delete(elevatedOwner, hiddenStack.id);
    await stacks.delete(elevatedOwner, visibleStack.id);
    await assets.handleAssetDeletion({ id: hidden.id, deleteOnDisk: false });
    await assets.handleAssetDeletion({ id: visible.id, deleteOnDisk: false });
    const { session } = await ctx.newSession({ userId: owner.id });
    const ownerAuth = factory.auth({ session, user: { id: owner.id } });

    const response = await ctx.syncStream(ownerAuth, [SyncRequestType.AssetsV2, SyncRequestType.StacksV1]);
    expect(deletedIds(response, SyncEntityType.AssetDeleteV1)).toEqual([hidden.id, visible.id].toSorted());
    expect(deletedIds(response, SyncEntityType.StackDeleteV1)).toEqual([hiddenStack.id, visibleStack.id].toSorted());
  });

  it('legacy audit rows without a verdict stream as before', async () => {
    const { ctx, auth, hidden, hiddenStack } = await setup();

    // the raw repository deletes carry no verdict (as every audit row written before this release)
    await ctx.get(StackRepository).delete(hiddenStack.id);
    await ctx.get(AssetRepository).remove(hidden);

    const assetStream = await ctx.syncStream(auth, [SyncRequestType.PartnerAssetsV2]);
    expect(deletedIds(assetStream, SyncEntityType.PartnerAssetDeleteV1)).toEqual([hidden.id]);
    const stackStream = await ctx.syncStream(auth, [SyncRequestType.PartnerStacksV1]);
    expect(deletedIds(stackStream, SyncEntityType.PartnerStackDeleteV1)).toEqual([hiddenStack.id]);
  });
});

const libraryService = (database: Kysely<DB>) => {
  const { sut } = newMediumService(LibraryService, {
    database,
    real: [AccessRepository, AssetRepository, LibraryRepository, LockRepository],
    mock: [EventRepository, JobRepository, LoggingRepository],
  });
  return sut;
};

/** An external-library Live Photo of the partner: the still is in an album (locked unless `locked: false`). */
const setupLivePhoto = async ({ locked }: { locked: boolean }) => {
  const ctx = new SyncTestContext(defaultDatabase);
  const { auth, user } = await ctx.newSyncAuthUser();
  const { user: owner } = await ctx.newUser();
  const library = await ctx.get(LibraryRepository).create({
    ownerId: owner.id,
    name: 'External',
    importPaths: ['/external'],
    exclusionPatterns: [],
  });
  const { asset: motion } = await ctx.newAsset({
    ownerId: owner.id,
    libraryId: library.id,
    type: AssetType.Video,
    visibility: AssetVisibility.Hidden,
    originalPath: '/external/IMG_0001.mov',
  });
  const { asset: still } = await ctx.newAsset({
    ownerId: owner.id,
    libraryId: library.id,
    livePhotoVideoId: motion.id,
    originalPath: '/external/IMG_0001.heic',
  });
  const { album } = await ctx.newAlbum({ ownerId: owner.id }, [still.id]);
  if (locked) {
    await ctx.get(LockRepository).lockAlbum(owner.id, album.id);
  }
  await ctx.newPartner({ sharedById: owner.id, sharedWithId: user.id });
  const { session } = await ctx.newSession({ userId: user.id });
  const freshDevice = factory.auth({ session, user: { id: user.id, name: user.name, email: user.email } });

  // the file watcher queues one LibraryRemoveAsset job per unlinked file
  const sut = libraryService(ctx.database);
  const unlink = async (...assets: Array<{ originalPath: string }>) => {
    for (const { originalPath } of assets) {
      await expect(sut.handleAssetRemoval({ libraryId: library.id, paths: [originalPath] })).resolves.toBe(
        JobStatus.Success,
      );
    }
  };

  return { ctx, auth, freshDevice, owner, still, motion, unlink };
};

/**
 * Fork (ruling R68): the file watcher removes a Live Photo's still and motion part in separate jobs. Whichever goes
 * first, the stranded-motion rule of the shared deletion verdict keeps both ids out of the partner delete stream.
 */
describe('file-watcher removal of a hidden Live Photo (R68)', () => {
  for (const order of ['still first', 'motion first'] as const) {
    it(`never names either part to the partner (${order})`, async () => {
      const { ctx, auth, freshDevice, owner, still, motion, unlink } = await setupLivePhoto({ locked: true });

      await (order === 'still first' ? unlink(still, motion) : unlink(motion, still));

      for (const viewer of [auth, freshDevice]) {
        const response = await ctx.syncStream(viewer, [SyncRequestType.PartnerAssetsV2]);
        expect(deletedIds(response, SyncEntityType.PartnerAssetDeleteV1)).toEqual([]);
        expect(JSON.stringify(response)).not.toContain(still.id);
        expect(JSON.stringify(response)).not.toContain(motion.id);
      }

      // the owner's own stream is unchanged (R43)
      const { session } = await ctx.newSession({ userId: owner.id });
      const ownerAuth = factory.auth({ session, user: { id: owner.id } });
      const ownStream = await ctx.syncStream(ownerAuth, [SyncRequestType.AssetsV2]);
      expect(deletedIds(ownStream, SyncEntityType.AssetDeleteV1)).toEqual([still.id, motion.id].toSorted());
    });
  }

  it('streams both parts for an owner without locks', async () => {
    const { ctx, auth, freshDevice, still, motion, unlink } = await setupLivePhoto({ locked: false });

    await unlink(still, motion);

    for (const viewer of [auth, freshDevice]) {
      const response = await ctx.syncStream(viewer, [SyncRequestType.PartnerAssetsV2]);
      expect(deletedIds(response, SyncEntityType.PartnerAssetDeleteV1)).toEqual([still.id, motion.id].toSorted());
    }
  });
});

/** R79: the partner's tagged photo is protected ONLY by the partner's locked smart album on the tag. */
const setupSmartLocked = async ({ locked }: { locked: boolean }) => {
  const ctx = new SyncTestContext(defaultDatabase);
  const { auth, user } = await ctx.newSyncAuthUser();
  const { user: owner } = await ctx.newUser();
  const { asset: hidden } = await ctx.newAsset({ ownerId: owner.id });
  const [tag] = await upsertTags(ctx.get(TagRepository), { userId: owner.id, tags: ['private'] });
  await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [hidden.id] });
  const { album } = await ctx.newAlbum({
    ownerId: owner.id,
    kind: AlbumKind.Smart,
    filter: { tagIds: [tag.id] } as any,
  });
  if (locked) {
    await ctx.get(LockRepository).lockAlbum(owner.id, album.id);
  }
  await ctx.newPartner({ sharedById: owner.id, sharedWithId: user.id });
  const freshDevice = async () => {
    const { session } = await ctx.newSession({ userId: user.id });
    return factory.auth({ session, user: { id: user.id, name: user.name, email: user.email } });
  };
  return { ctx, auth, owner, hidden, freshDevice };
};

const ownerHiddenOf = async (ctx: SyncTestContext, assetId: string) => {
  const row = await ctx.database
    .selectFrom('asset_audit')
    .select('ownerHidden')
    .where('assetId', '=', assetId)
    .executeTakeFirstOrThrow();
  return row.ownerHidden;
};

/**
 * Fork (ruling R79): privacy judgment does not depend on trash state. A photo hidden only by its owner's locked smart
 * album stays hidden once trashed: the partner stream does not send the trashed row, and the AssetDelete job's
 * pre-delete verdict marks its audit row `ownerHidden`, so the partner delete stream never names it.
 */
describe('a trashed photo hidden only by a locked smart album (R79)', () => {
  it('is neither streamed to the partner while trashed nor named when deleted', async () => {
    const { ctx, auth, hidden, freshDevice } = await setupSmartLocked({ locked: true });
    await ctx.get(AssetRepository).updateAll([hidden.id], { deletedAt: new Date(), status: AssetStatus.Trashed });

    const trashed = await ctx.syncStream(await freshDevice(), [SyncRequestType.PartnerAssetsV2]);
    expect(JSON.stringify(trashed)).not.toContain(hidden.id);

    await assetService(ctx.database).handleAssetDeletion({ id: hidden.id, deleteOnDisk: false });
    await expect(ownerHiddenOf(ctx, hidden.id)).resolves.toBe(true);
    for (const viewer of [auth, await freshDevice()]) {
      const response = await ctx.syncStream(viewer, [SyncRequestType.PartnerAssetsV2]);
      expect(deletedIds(response, SyncEntityType.PartnerAssetDeleteV1)).toEqual([]);
      expect(JSON.stringify(response)).not.toContain(hidden.id);
    }
  });

  it('an owner without locks is unchanged: the deletion streams to the partner', async () => {
    const { ctx, auth, hidden } = await setupSmartLocked({ locked: false });
    await ctx.get(AssetRepository).updateAll([hidden.id], { deletedAt: new Date(), status: AssetStatus.Trashed });

    await assetService(ctx.database).handleAssetDeletion({ id: hidden.id, deleteOnDisk: false });
    await expect(ownerHiddenOf(ctx, hidden.id)).resolves.not.toBe(true);
    const response = await ctx.syncStream(auth, [SyncRequestType.PartnerAssetsV2]);
    expect(deletedIds(response, SyncEntityType.PartnerAssetDeleteV1)).toEqual([hidden.id]);
  });
});
