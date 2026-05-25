import { Kysely } from 'kysely';
import { AlbumUserRole } from 'src/enum';
import { AlbumContainerRepository } from 'src/repositories/album-container.repository';
import { AlbumRepository } from 'src/repositories/album.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { DB } from 'src/schema';
import { BaseService } from 'src/services/base.service';
import { newMediumService } from 'test/medium.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(AlbumContainerRepository) };
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
});
