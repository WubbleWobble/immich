import { Kysely } from 'kysely';
import { StorageCore } from 'src/cores/storage.core.js';
import { AlbumKind, AlbumUserRole } from 'src/enum.js';
import { AlbumContainerRepository } from 'src/repositories/album-container.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LockRepository } from 'src/repositories/lock.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { UserService } from 'src/services/user.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(AlbumContainerRepository) };
};

const countOf = async (query: { executeTakeFirstOrThrow: () => Promise<{ count: string | number | bigint }> }) => {
  const row = await query.executeTakeFirstOrThrow();
  return Number(row.count);
};

const getClosureRows = (db: Kysely<DB>, containerIds: string[]) =>
  db
    .selectFrom('album_container_closure')
    .selectAll()
    .where('id_ancestor', 'in', containerIds)
    .where('id_descendant', 'in', containerIds)
    .orderBy('id_ancestor')
    .orderBy('id_descendant')
    .orderBy('depth')
    .execute();

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AlbumContainerRepository.name, () => {
  describe('create', () => {
    it('creates a single self-closure row when inserting at root', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      const root = await sut.create({ ownerId: user.id, name: 'Root', parentId: null });

      const rows = await getClosureRows(ctx.database, [root.id]);
      expect(rows).toEqual([{ id_ancestor: root.id, id_descendant: root.id, depth: 0 }]);
    });

    it('creates self-row plus inherited ancestor rows when inserting under a parent', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      const a = await sut.create({ ownerId: user.id, name: 'A', parentId: null });
      const b = await sut.create({ ownerId: user.id, name: 'B', parentId: a.id });

      const rows = await getClosureRows(ctx.database, [a.id, b.id]);
      expect(rows).toEqual(
        expect.arrayContaining([
          { id_ancestor: a.id, id_descendant: a.id, depth: 0 },
          { id_ancestor: a.id, id_descendant: b.id, depth: 1 },
          { id_ancestor: b.id, id_descendant: b.id, depth: 0 },
        ]),
      );
      expect(rows).toHaveLength(3);
    });

    it('records the correct depth for a deep tree (A->B->C)', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      const a = await sut.create({ ownerId: user.id, name: 'A', parentId: null });
      const b = await sut.create({ ownerId: user.id, name: 'B', parentId: a.id });
      const c = await sut.create({ ownerId: user.id, name: 'C', parentId: b.id });

      const rows = await getClosureRows(ctx.database, [a.id, b.id, c.id]);
      expect(rows).toEqual(
        expect.arrayContaining([
          { id_ancestor: a.id, id_descendant: a.id, depth: 0 },
          { id_ancestor: a.id, id_descendant: b.id, depth: 1 },
          { id_ancestor: a.id, id_descendant: c.id, depth: 2 },
          { id_ancestor: b.id, id_descendant: b.id, depth: 0 },
          { id_ancestor: b.id, id_descendant: c.id, depth: 1 },
          { id_ancestor: c.id, id_descendant: c.id, depth: 0 },
        ]),
      );
      expect(rows).toHaveLength(6);
    });
  });

  describe('move', () => {
    it('moves a subtree (B->C) from under A to under D and updates closure', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      const a = await sut.create({ ownerId: user.id, name: 'A', parentId: null });
      const b = await sut.create({ ownerId: user.id, name: 'B', parentId: a.id });
      const c = await sut.create({ ownerId: user.id, name: 'C', parentId: b.id });
      const d = await sut.create({ ownerId: user.id, name: 'D', parentId: null });

      await sut.move(b.id, d.id);

      const rows = await getClosureRows(ctx.database, [a.id, b.id, c.id, d.id]);

      // Old links from A into the moved subtree must be gone.
      expect(rows).not.toContainEqual({ id_ancestor: a.id, id_descendant: b.id, depth: expect.anything() });
      expect(rows).not.toContainEqual({ id_ancestor: a.id, id_descendant: c.id, depth: expect.anything() });

      // New links from D into the moved subtree must be present.
      expect(rows).toContainEqual({ id_ancestor: d.id, id_descendant: b.id, depth: 1 });
      expect(rows).toContainEqual({ id_ancestor: d.id, id_descendant: c.id, depth: 2 });

      // Internal subtree closure (B->C) is preserved.
      expect(rows).toContainEqual({ id_ancestor: b.id, id_descendant: c.id, depth: 1 });

      // Self rows are still present for every node.
      expect(rows).toContainEqual({ id_ancestor: a.id, id_descendant: a.id, depth: 0 });
      expect(rows).toContainEqual({ id_ancestor: b.id, id_descendant: b.id, depth: 0 });
      expect(rows).toContainEqual({ id_ancestor: c.id, id_descendant: c.id, depth: 0 });
      expect(rows).toContainEqual({ id_ancestor: d.id, id_descendant: d.id, depth: 0 });
    });
  });

  describe('delete', () => {
    it('cascades to closure rows when an ancestor is deleted', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      const a = await sut.create({ ownerId: user.id, name: 'A', parentId: null });
      const b = await sut.create({ ownerId: user.id, name: 'B', parentId: a.id });

      await sut.delete(a.id);

      const rows = await ctx.database
        .selectFrom('album_container_closure')
        .selectAll()
        .where((eb) => eb.or([eb('id_ancestor', 'in', [a.id, b.id]), eb('id_descendant', 'in', [a.id, b.id])]))
        .execute();
      expect(rows).toEqual([]);

      const stillThere = await ctx.database
        .selectFrom('album_container')
        .selectAll()
        .where('id', 'in', [a.id, b.id])
        .execute();
      expect(stillThere).toEqual([]);
    });
  });

  describe('isDescendantOf', () => {
    it('returns true when an ancestor-descendant pair exists with depth > 0', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      const a = await sut.create({ ownerId: user.id, name: 'A', parentId: null });
      const b = await sut.create({ ownerId: user.id, name: 'B', parentId: a.id });

      await expect(sut.isDescendantOf(b.id, a.id)).resolves.toBe(true);
      await expect(sut.isDescendantOf(a.id, b.id)).resolves.toBe(false);
      // self should not count as descendant
      await expect(sut.isDescendantOf(a.id, a.id)).resolves.toBe(false);
    });
  });

  describe('getDepth', () => {
    it('returns the maximum depth from any ancestor to the container', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      const a = await sut.create({ ownerId: user.id, name: 'A', parentId: null });
      const b = await sut.create({ ownerId: user.id, name: 'B', parentId: a.id });
      const c = await sut.create({ ownerId: user.id, name: 'C', parentId: b.id });

      await expect(sut.getDepth(a.id)).resolves.toBe(0);
      await expect(sut.getDepth(b.id)).resolves.toBe(1);
      await expect(sut.getDepth(c.id)).resolves.toBe(2);
    });
  });

  describe('getHeight', () => {
    it('returns the maximum depth from the container to any descendant', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      const a = await sut.create({ ownerId: user.id, name: 'A', parentId: null });
      const b = await sut.create({ ownerId: user.id, name: 'B', parentId: a.id });
      const c = await sut.create({ ownerId: user.id, name: 'C', parentId: b.id });

      // A is the root: deepest descendant is C, distance 2.
      await expect(sut.getHeight(a.id)).resolves.toBe(2);
      // B has one descendant C, distance 1.
      await expect(sut.getHeight(b.id)).resolves.toBe(1);
      // C is a leaf.
      await expect(sut.getHeight(c.id)).resolves.toBe(0);
    });
  });

  describe('getThumbnailAssetIdsForContainers', () => {
    it('returns an empty map when no container ids are given', async () => {
      const { sut } = setup();
      const result = await sut.getThumbnailAssetIdsForContainers([]);
      expect(result.size).toBe(0);
    });

    it('returns recent asset ids from albums under the container subtree', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      const parent = await sut.create({ ownerId: user.id, name: 'Parent', parentId: null });
      const child = await sut.create({ ownerId: user.id, name: 'Child', parentId: parent.id });

      const olderAsset = await ctx.newAsset({
        ownerId: user.id,
        fileCreatedAt: new Date('2020-01-01T00:00:00Z'),
      });
      const newerAsset = await ctx.newAsset({
        ownerId: user.id,
        fileCreatedAt: new Date('2024-01-01T00:00:00Z'),
      });

      const { album: parentAlbum } = await ctx.newAlbum({ ownerId: user.id, containerId: parent.id });
      const { album: childAlbum } = await ctx.newAlbum({ ownerId: user.id, containerId: child.id });

      await ctx.newAlbumAsset({ albumId: parentAlbum.id, assetId: olderAsset.result.id });
      await ctx.newAlbumAsset({ albumId: childAlbum.id, assetId: newerAsset.result.id });

      const result = await sut.getThumbnailAssetIdsForContainers([parent.id, child.id]);

      // Parent surfaces both (newest first).
      expect(result.get(parent.id)).toEqual([newerAsset.result.id, olderAsset.result.id]);
      // Child only surfaces its own.
      expect(result.get(child.id)).toEqual([newerAsset.result.id]);
    });

    it('dedupes the same asset across multiple albums under the same folder', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      const folder = await sut.create({ ownerId: user.id, name: 'Folder', parentId: null });

      const asset = await ctx.newAsset({
        ownerId: user.id,
        fileCreatedAt: new Date('2024-01-01T00:00:00Z'),
      });

      const { album: a } = await ctx.newAlbum({ ownerId: user.id, containerId: folder.id });
      const { album: b } = await ctx.newAlbum({ ownerId: user.id, containerId: folder.id });
      await ctx.newAlbumAsset({ albumId: a.id, assetId: asset.result.id });
      await ctx.newAlbumAsset({ albumId: b.id, assetId: asset.result.id });

      const result = await sut.getThumbnailAssetIdsForContainers([folder.id]);
      expect(result.get(folder.id)).toEqual([asset.result.id]);
    });

    it('caps at 4 asset ids per container', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      const folder = await sut.create({ ownerId: user.id, name: 'Folder', parentId: null });
      const { album } = await ctx.newAlbum({ ownerId: user.id, containerId: folder.id });

      const assets = await Promise.all(
        [1, 2, 3, 4, 5, 6].map((i) =>
          ctx.newAsset({
            ownerId: user.id,
            fileCreatedAt: new Date(`2024-01-0${i}T00:00:00Z`),
          }),
        ),
      );
      for (const asset of assets) {
        await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.result.id });
      }

      const result = await sut.getThumbnailAssetIdsForContainers([folder.id]);
      expect(result.get(folder.id)).toHaveLength(4);
    });
  });

  describe('hasAccess', () => {
    it('returns true for the owner', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();

      const folder = await sut.create({ ownerId: owner.id, name: 'Owned', parentId: null });

      await expect(sut.hasAccess(folder.id, owner.id)).resolves.toBe(true);
    });

    it('returns true for a user directly shared on the folder', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: viewer } = await ctx.newUser();

      const folder = await sut.create({ ownerId: owner.id, name: 'Shared', parentId: null });
      await sut.addUser(folder.id, viewer.id, AlbumUserRole.Viewer);

      await expect(sut.hasAccess(folder.id, viewer.id)).resolves.toBe(true);
    });

    it('returns true for a user shared on an ancestor folder (cascade)', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: viewer } = await ctx.newUser();

      const family = await sut.create({ ownerId: owner.id, name: 'Family', parentId: null });
      const andi = await sut.create({ ownerId: owner.id, name: 'Andi', parentId: family.id });
      await sut.addUser(family.id, viewer.id, AlbumUserRole.Viewer);

      await expect(sut.hasAccess(andi.id, viewer.id)).resolves.toBe(true);
    });

    it('returns false for an unrelated user', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: outsider } = await ctx.newUser();

      const folder = await sut.create({ ownerId: owner.id, name: 'Private', parentId: null });

      await expect(sut.hasAccess(folder.id, outsider.id)).resolves.toBe(false);
    });
  });

  describe('cascade album access', () => {
    it('grants album access to a user shared on an ancestor folder', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: viewer } = await ctx.newUser();

      const folder = await sut.create({ ownerId: owner.id, name: 'Family', parentId: null });
      const { album } = await ctx.newAlbum({ ownerId: owner.id, containerId: folder.id });
      await sut.addUser(folder.id, viewer.id, AlbumUserRole.Editor);

      const albumRepo = ctx.get(AlbumRepository);
      const sharedAlbums = await albumRepo.getAll(viewer.id, { isShared: true });

      expect(sharedAlbums.map((a) => a.id)).toContain(album.id);
    });

    it('does not grant access without a folder share', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: viewer } = await ctx.newUser();

      const folder = await sut.create({ ownerId: owner.id, name: 'Family', parentId: null });
      const { album } = await ctx.newAlbum({ ownerId: owner.id, containerId: folder.id });

      const albumRepo = ctx.get(AlbumRepository);
      const sharedAlbums = await albumRepo.getAll(viewer.id, { isShared: true });

      expect(sharedAlbums.map((a) => a.id)).not.toContain(album.id);
    });

    it('grants cascade access through a nested folder hierarchy', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: viewer } = await ctx.newUser();

      const family = await sut.create({ ownerId: owner.id, name: 'Family', parentId: null });
      const andi = await sut.create({ ownerId: owner.id, name: 'Andi', parentId: family.id });
      const { album } = await ctx.newAlbum({ ownerId: owner.id, containerId: andi.id });
      await sut.addUser(family.id, viewer.id, AlbumUserRole.Viewer);

      const albumRepo = ctx.get(AlbumRepository);
      const sharedAlbums = await albumRepo.getAll(viewer.id, { isShared: true });

      expect(sharedAlbums.map((a) => a.id)).toContain(album.id);
    });
  });

  describe('owner deletion', () => {
    it('owner deletion cascades albums without orphaning folders or lock rows', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: sharee } = await ctx.newUser();
      const lockRepo = ctx.get(LockRepository);

      const folder = await sut.create({ ownerId: owner.id, name: 'F', parentId: null });
      const child = await sut.create({ ownerId: owner.id, name: 'F child', parentId: folder.id });
      const { album: smart } = await ctx.newAlbum({
        ownerId: owner.id,
        kind: AlbumKind.Smart,
        filter: { personIds: [] } as any,
      });
      const { album: regular } = await ctx.newAlbum({ ownerId: owner.id, containerId: child.id });
      await sut.addUser(folder.id, sharee.id, AlbumUserRole.Viewer);
      await lockRepo.lockContainer(owner.id, folder.id);
      await lockRepo.lockAlbum(owner.id, smart.id);
      await lockRepo.lockAlbum(sharee.id, regular.id);
      await lockRepo.lockContainer(sharee.id, folder.id);

      const albumIds = [smart.id, regular.id];
      const containerIds = [folder.id, child.id];
      const countRows = async () => {
        const db = ctx.database;
        return {
          albums: await countOf(
            db
              .selectFrom('album')
              .select((eb) => eb.fn.countAll().as('count'))
              .where('id', 'in', albumIds),
          ),
          containers: await countOf(
            db
              .selectFrom('album_container')
              .select((eb) => eb.fn.countAll().as('count'))
              .where('id', 'in', containerIds),
          ),
          containerUsers: await countOf(
            db
              .selectFrom('album_container_user')
              .select((eb) => eb.fn.countAll().as('count'))
              .where((eb) => eb.or([eb('albumContainerId', 'in', containerIds), eb('userId', '=', owner.id)])),
          ),
          closure: await countOf(
            db
              .selectFrom('album_container_closure')
              .select((eb) => eb.fn.countAll().as('count'))
              .where((eb) => eb.or([eb('id_ancestor', 'in', containerIds), eb('id_descendant', 'in', containerIds)])),
          ),
          lockedAlbums: await countOf(
            db
              .selectFrom('locked_album')
              .select((eb) => eb.fn.countAll().as('count'))
              .where((eb) => eb.or([eb('albumId', 'in', albumIds), eb('userId', '=', owner.id)])),
          ),
          lockedContainers: await countOf(
            db
              .selectFrom('locked_container')
              .select((eb) => eb.fn.countAll().as('count'))
              .where((eb) => eb.or([eb('containerId', 'in', containerIds), eb('userId', '=', owner.id)])),
          ),
        };
      };

      // Guard against a vacuous pass: every table must actually hold rows before the delete.
      const before = await countRows();
      expect(before).toEqual({
        albums: 2,
        containers: 2,
        containerUsers: 1,
        closure: 3,
        lockedAlbums: 2,
        lockedContainers: 2,
      });

      // handleUserDelete resolves per-user storage folders; the (mocked) storage repository never touches disk.
      StorageCore.setMediaLocation('/path/to/media');

      // The real job path: UserService.handleUserDelete -> AlbumRepository.deleteAll -> UserRepository.delete(user, true).
      const { sut: userService, ctx: userCtx } = newMediumService(UserService, {
        database: ctx.database,
        real: [AlbumRepository, ConfigRepository, CryptoRepository, SystemMetadataRepository, UserRepository],
        mock: [EventRepository, LoggingRepository, StorageRepository],
      });
      userCtx.getMock(StorageRepository).unlinkDir.mockResolvedValue(void 0);
      userCtx.getMock(EventRepository).emit.mockResolvedValue(void 0);
      await expect(userService.handleUserDelete({ id: owner.id, force: true })).resolves.toBeUndefined();
      expect(userCtx.getMock(EventRepository).emit).toHaveBeenCalledWith(
        'UserDelete',
        expect.objectContaining({ id: owner.id }),
      );

      await expect(countRows()).resolves.toEqual({
        albums: 0,
        containers: 0,
        containerUsers: 0,
        closure: 0,
        lockedAlbums: 0,
        lockedContainers: 0,
      });
      await expect(
        ctx.database.selectFrom('user').select('id').where('id', '=', owner.id).executeTakeFirst(),
      ).resolves.toBeUndefined();
      // The sharee is untouched.
      await expect(
        ctx.database.selectFrom('user').select('id').where('id', '=', sharee.id).executeTakeFirst(),
      ).resolves.toBeDefined();
    });
  });
});
