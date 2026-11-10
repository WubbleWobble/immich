import { Kysely } from 'kysely';
import { AlbumKind, AssetStatus, JobName } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LockRepository } from 'src/repositories/lock.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { TrashRepository } from 'src/repositories/trash.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetService } from 'src/services/asset.service.js';
import { BaseService } from 'src/services/base.service.js';
import { TrashService } from 'src/services/trash.service.js';
import { upsertTags } from 'src/utils/tag.js';
import { MediumTestContext, newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const result = newMediumService(TrashService, {
    database: db || defaultDatabase,
    real: [AccessRepository, AlbumRepository, AssetRepository, LockRepository, TrashRepository],
    mock: [EventRepository, JobRepository, LoggingRepository],
  });
  result.ctx.getMock(EventRepository).emit.mockResolvedValue();
  result.ctx.getMock(JobRepository).queue.mockResolvedValue();
  result.ctx.getMock(JobRepository).queueAll.mockResolvedValue();
  return result;
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

type Ctx = MediumTestContext<typeof TrashService>;

/** An owner with two trashed assets: one in a locked album (hidden outside elevation) and one visible. */
const newTrashedLibrary = async (ctx: Ctx, { lock = true } = {}) => {
  const { user } = await ctx.newUser();
  const { asset: hidden } = await ctx.newAsset({
    ownerId: user.id,
    status: AssetStatus.Trashed,
    deletedAt: new Date(),
  });
  const { asset: visible } = await ctx.newAsset({
    ownerId: user.id,
    status: AssetStatus.Trashed,
    deletedAt: new Date(),
  });
  const { album } = await ctx.newAlbum({ ownerId: user.id }, [hidden.id]);
  if (lock) {
    await ctx.get(LockRepository).lockAlbum(user.id, album.id);
  }
  return { user, hidden, visible, album };
};

const statusOf = async (ctx: Ctx, id: string) => {
  const row = await ctx.database
    .selectFrom('asset')
    .select(['status', 'deletedAt'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return row;
};

/**
 * R79: an owner whose tagged photo `hidden` is protected ONLY by a locked smart album on the tag (no regular album).
 * The owner trashes it through an elevated session (the real AssetService.deleteAll); `visible` is an ordinary trashed
 * photo. With `rescue`, an unlocked smart album on the same tag also matches `hidden`.
 */
const newSmartLockedTrash = async (ctx: Ctx, { lock = true, rescue = false } = {}) => {
  const { user } = await ctx.newUser();
  const { asset: hidden } = await ctx.newAsset({ ownerId: user.id });
  const { asset: visible } = await ctx.newAsset({
    ownerId: user.id,
    status: AssetStatus.Trashed,
    deletedAt: new Date(),
  });
  const [tag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['private'] });
  await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [hidden.id] });
  const { album: lockedSmart } = await ctx.newAlbum({
    ownerId: user.id,
    kind: AlbumKind.Smart,
    filter: { tagIds: [tag.id] } as any,
  });
  if (lock) {
    await ctx.get(LockRepository).lockAlbum(user.id, lockedSmart.id);
  }
  if (rescue) {
    await ctx.newAlbum({ ownerId: user.id, kind: AlbumKind.Smart, filter: { tagIds: [tag.id] } as any });
  }
  const ordinary = factory.auth({ user });
  const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });
  await BaseService.create(AssetService, ctx.sut).deleteAll(elevated, { ids: [hidden.id] });
  return { user, hidden, visible, lockedSmart, ordinary, elevated };
};

/**
 * Fork (ruling R65): outside elevation the bulk trash operations act only on trashed assets NOT hidden for the owner
 * (the same own-lock rule as the explicit `restoreAssets` path); hidden rows are skipped silently and are not
 * counted. Elevated sessions keep the all-rows behaviour.
 */
describe(TrashService.name, () => {
  describe('restore (all) under locks', () => {
    it('ordinary session: restores only the visible trashed asset and counts only it', async () => {
      const { sut, ctx } = setup();
      const { user, hidden, visible } = await newTrashedLibrary(ctx);

      await expect(sut.restore(factory.auth({ user }))).resolves.toEqual({ count: 1 });

      await expect(statusOf(ctx, visible.id)).resolves.toEqual({ status: AssetStatus.Active, deletedAt: null });
      await expect(statusOf(ctx, hidden.id)).resolves.toEqual({
        status: AssetStatus.Trashed,
        deletedAt: expect.any(Date),
      });
    });

    it('elevated session: restores every trashed asset', async () => {
      const { sut, ctx } = setup();
      const { user, hidden, visible } = await newTrashedLibrary(ctx);
      const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });

      await expect(sut.restore(elevated)).resolves.toEqual({ count: 2 });

      await expect(statusOf(ctx, visible.id)).resolves.toEqual({ status: AssetStatus.Active, deletedAt: null });
      await expect(statusOf(ctx, hidden.id)).resolves.toEqual({ status: AssetStatus.Active, deletedAt: null });
    });

    it('a user without locks is unchanged: every trashed asset is restored', async () => {
      const { sut, ctx } = setup();
      const { user, hidden, visible } = await newTrashedLibrary(ctx, { lock: false });

      await expect(sut.restore(factory.auth({ user }))).resolves.toEqual({ count: 2 });

      await expect(statusOf(ctx, visible.id)).resolves.toEqual({ status: AssetStatus.Active, deletedAt: null });
      await expect(statusOf(ctx, hidden.id)).resolves.toEqual({ status: AssetStatus.Active, deletedAt: null });
    });
  });

  describe('empty under locks', () => {
    it('ordinary session: marks only the visible trashed asset deleted; the hidden one stays trashed and is not queued', async () => {
      const { sut, ctx } = setup();
      const { user, hidden, visible } = await newTrashedLibrary(ctx);

      await expect(sut.empty(factory.auth({ user }))).resolves.toEqual({ count: 1 });

      await expect(statusOf(ctx, visible.id)).resolves.toEqual({
        status: AssetStatus.Deleted,
        deletedAt: expect.any(Date),
      });
      await expect(statusOf(ctx, hidden.id)).resolves.toEqual({
        status: AssetStatus.Trashed,
        deletedAt: expect.any(Date),
      });
      expect(ctx.getMock(JobRepository).queue).toHaveBeenCalledWith({ name: JobName.AssetEmptyTrash, data: {} });

      // the queued background sweep only picks up rows marked deleted: the hidden asset is never scheduled
      await sut.handleEmptyTrash();
      const queued = ctx
        .getMock(JobRepository)
        .queueAll.mock.calls.flatMap(([jobs]) => jobs)
        .filter((job) => job.name === JobName.AssetDelete)
        .map((job) => (job.data as { id: string }).id);
      expect(queued).toContain(visible.id);
      expect(queued).not.toContain(hidden.id);
    });

    it('ordinary session with only hidden trash: nothing changes and no sweep is queued', async () => {
      const { sut, ctx } = setup();
      const { user, hidden, visible } = await newTrashedLibrary(ctx);
      await ctx.database.deleteFrom('asset').where('id', '=', visible.id).execute();

      await expect(sut.empty(factory.auth({ user }))).resolves.toEqual({ count: 0 });

      await expect(statusOf(ctx, hidden.id)).resolves.toEqual({
        status: AssetStatus.Trashed,
        deletedAt: expect.any(Date),
      });
      expect(ctx.getMock(JobRepository).queue).not.toHaveBeenCalled();
    });

    it('elevated session: marks every trashed asset deleted', async () => {
      const { sut, ctx } = setup();
      const { user, hidden, visible } = await newTrashedLibrary(ctx);
      const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });

      await expect(sut.empty(elevated)).resolves.toEqual({ count: 2 });

      await expect(statusOf(ctx, visible.id)).resolves.toMatchObject({ status: AssetStatus.Deleted });
      await expect(statusOf(ctx, hidden.id)).resolves.toMatchObject({ status: AssetStatus.Deleted });
    });

    it('a user without locks is unchanged: every trashed asset is marked deleted', async () => {
      const { sut, ctx } = setup();
      const { user, hidden, visible } = await newTrashedLibrary(ctx, { lock: false });

      await expect(sut.empty(factory.auth({ user }))).resolves.toEqual({ count: 2 });

      await expect(statusOf(ctx, visible.id)).resolves.toMatchObject({ status: AssetStatus.Deleted });
      await expect(statusOf(ctx, hidden.id)).resolves.toMatchObject({ status: AssetStatus.Deleted });
    });
  });
  /**
   * Fork (ruling R79): privacy judgment does not depend on trash state, so a trashed photo hidden only by a locked smart
   * album stays hidden for the R65 bulk operations; an elevated session still acts on it.
   */
  describe('trashed photos hidden only by a locked smart album (R79)', () => {
    it('ordinary empty skips it (not marked deleted, not queued); elevated empty deletes it', async () => {
      const { sut, ctx } = setup();
      const { hidden, visible, ordinary, elevated } = await newSmartLockedTrash(ctx);

      await expect(sut.empty(ordinary)).resolves.toEqual({ count: 1 });
      await expect(statusOf(ctx, visible.id)).resolves.toMatchObject({ status: AssetStatus.Deleted });
      await expect(statusOf(ctx, hidden.id)).resolves.toMatchObject({ status: AssetStatus.Trashed });
      await sut.handleEmptyTrash();
      const queued = ctx
        .getMock(JobRepository)
        .queueAll.mock.calls.flatMap(([jobs]) => jobs)
        .map((job) => (job.data as { id: string }).id);
      expect(queued).not.toContain(hidden.id);

      await expect(sut.empty(elevated)).resolves.toEqual({ count: 1 });
      await expect(statusOf(ctx, hidden.id)).resolves.toMatchObject({ status: AssetStatus.Deleted });
    });

    it('ordinary restore-all and restore-by-id skip it; the elevated session restores it', async () => {
      const { sut, ctx } = setup();
      const { hidden, visible, ordinary, elevated } = await newSmartLockedTrash(ctx);

      await expect(sut.restore(ordinary)).resolves.toEqual({ count: 1 });
      await expect(statusOf(ctx, visible.id)).resolves.toEqual({ status: AssetStatus.Active, deletedAt: null });
      await expect(statusOf(ctx, hidden.id)).resolves.toMatchObject({ status: AssetStatus.Trashed });
      await expect(sut.restoreAssets(ordinary, { ids: [hidden.id] })).rejects.toThrow();
      await expect(statusOf(ctx, hidden.id)).resolves.toMatchObject({ status: AssetStatus.Trashed });

      await expect(sut.restoreAssets(elevated, { ids: [hidden.id] })).resolves.toEqual({ count: 1 });
      await expect(statusOf(ctx, hidden.id)).resolves.toEqual({ status: AssetStatus.Active, deletedAt: null });
    });

    it('rescue: also matched by an unlocked smart album, it stays visible after trash and ordinary empty deletes it', async () => {
      const { sut, ctx } = setup();
      const { hidden, ordinary } = await newSmartLockedTrash(ctx, { rescue: true });

      await expect(sut.empty(ordinary)).resolves.toEqual({ count: 2 });
      await expect(statusOf(ctx, hidden.id)).resolves.toMatchObject({ status: AssetStatus.Deleted });
    });

    it('a user without locks is unchanged: ordinary empty deletes it', async () => {
      const { sut, ctx } = setup();
      const { hidden, ordinary } = await newSmartLockedTrash(ctx, { lock: false });

      await expect(sut.empty(ordinary)).resolves.toEqual({ count: 2 });
      await expect(statusOf(ctx, hidden.id)).resolves.toMatchObject({ status: AssetStatus.Deleted });
    });
  });
});
