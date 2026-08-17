import { Kysely } from 'kysely';
import { AlbumKind } from 'src/enum';
import { AlbumRepository } from 'src/repositories/album.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { DB } from 'src/schema';
import { BaseService } from 'src/services/base.service';
import { newMediumService } from 'test/medium.factory';
import { newUuid } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(AlbumRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AlbumRepository.name, () => {
  describe('prunePersonIdsFromSmartAlbums', () => {
    it('splices a deleted person id out of filter.personIds and bumps cacheInvalidatedAt', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const deadId = newUuid();
      const liveId = newUuid();

      await ctx.newAlbum({
        ownerId: user.id,
        kind: AlbumKind.Smart,
        filter: { personIds: [deadId, liveId] } as any,
      });

      const before = await ctx.database.selectFrom('album').selectAll().execute();
      expect(before).toHaveLength(1);

      const affected = await sut.prunePersonIdsFromSmartAlbums([deadId]);
      expect(affected).toHaveLength(1);

      const after = await ctx.database
        .selectFrom('album')
        .select(['filter', 'cacheInvalidatedAt'])
        .where('id', '=', affected[0])
        .executeTakeFirstOrThrow();

      expect((after.filter as any).personIds).toEqual([liveId]);
      expect(after.cacheInvalidatedAt).not.toBeNull();
    });

    it('removes the personIds key entirely when the spliced array would be empty', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const deadId = newUuid();

      const { album } = await ctx.newAlbum({
        ownerId: user.id,
        kind: AlbumKind.Smart,
        filter: { personIds: [deadId] } as any,
      });

      const affected = await sut.prunePersonIdsFromSmartAlbums([deadId]);
      expect(affected).toEqual([album.id]);

      const after = await ctx.database
        .selectFrom('album')
        .select('filter')
        .where('id', '=', album.id)
        .executeTakeFirstOrThrow();

      expect(after.filter).not.toBeNull();
      expect((after.filter as any).personIds).toBeUndefined();
    });

    it('leaves filters that do not reference the deleted ids untouched', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const otherId = newUuid();

      const { album } = await ctx.newAlbum({
        ownerId: user.id,
        kind: AlbumKind.Smart,
        filter: { personIds: [otherId] } as any,
      });

      const affected = await sut.prunePersonIdsFromSmartAlbums([newUuid(), newUuid()]);
      expect(affected).toEqual([]);

      const after = await ctx.database
        .selectFrom('album')
        .select(['filter', 'cacheInvalidatedAt'])
        .where('id', '=', album.id)
        .executeTakeFirstOrThrow();

      expect((after.filter as any).personIds).toEqual([otherId]);
      expect(after.cacheInvalidatedAt).toBeNull();
    });

    it('skips soft-deleted smart albums', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const deadId = newUuid();

      const { album } = await ctx.newAlbum({
        ownerId: user.id,
        kind: AlbumKind.Smart,
        filter: { personIds: [deadId] } as any,
      });
      await ctx.softDeleteAlbum(album.id);

      const affected = await sut.prunePersonIdsFromSmartAlbums([deadId]);
      expect(affected).toEqual([]);

      const after = await ctx.database
        .selectFrom('album')
        .select('filter')
        .where('id', '=', album.id)
        .executeTakeFirstOrThrow();
      // Filter was left untouched on the soft-deleted album.
      expect((after.filter as any).personIds).toEqual([deadId]);
    });

    it('returns an empty result and is a no-op when given no ids', async () => {
      const { sut } = setup();
      const result = await sut.prunePersonIdsFromSmartAlbums([]);
      expect(result).toEqual([]);
    });
  });

  describe('pruneTagIdsFromSmartAlbums', () => {
    it('splices a deleted tag id out of filter.tagIds and bumps cacheInvalidatedAt', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const deadId = newUuid();
      const liveId = newUuid();

      const { album } = await ctx.newAlbum({
        ownerId: user.id,
        kind: AlbumKind.Smart,
        filter: { tagIds: [deadId, liveId] } as any,
      });

      const affected = await sut.pruneTagIdsFromSmartAlbums([deadId]);
      expect(affected).toEqual([album.id]);

      const after = await ctx.database
        .selectFrom('album')
        .select(['filter', 'cacheInvalidatedAt'])
        .where('id', '=', album.id)
        .executeTakeFirstOrThrow();

      expect((after.filter as any).tagIds).toEqual([liveId]);
      expect(after.cacheInvalidatedAt).not.toBeNull();
    });

    it('removes the tagIds key entirely when the spliced array would be empty', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const deadId = newUuid();

      const { album } = await ctx.newAlbum({
        ownerId: user.id,
        kind: AlbumKind.Smart,
        filter: { tagIds: [deadId] } as any,
      });

      const affected = await sut.pruneTagIdsFromSmartAlbums([deadId]);
      expect(affected).toEqual([album.id]);

      const after = await ctx.database
        .selectFrom('album')
        .select('filter')
        .where('id', '=', album.id)
        .executeTakeFirstOrThrow();

      expect((after.filter as any).tagIds).toBeUndefined();
    });
  });
});
