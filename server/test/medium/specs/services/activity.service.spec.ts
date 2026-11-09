import { Kysely } from 'kysely';
import { ReactionType } from 'src/dtos/activity.dto.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ActivityRepository } from 'src/repositories/activity.repository.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LockRepository } from 'src/repositories/lock.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { ActivityService } from 'src/services/activity.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory, newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(ActivityService, {
    database: db || defaultDatabase,
    real: [
      AccessRepository,
      ActivityRepository,
      AlbumRepository,
      AlbumUserRepository,
      AssetRepository,
      LockRepository,
      UserRepository,
    ],
    mock: [LoggingRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(ActivityService.name, () => {
  describe('getAll', () => {
    it('should start off empty', async () => {
      const { sut, ctx } = setup();
      const { album, owner } = await ctx.newSharedAlbum();

      await expect(sut.getAll(factory.auth({ user: owner }), { albumId: album.id })).resolves.toEqual([]);
    });

    it('should filter by album id', async () => {
      const { sut, ctx } = setup();
      const { album, owner } = await ctx.newSharedAlbum();
      const auth = factory.auth({ user: owner });
      const { album: other } = await ctx.newAlbum({ ownerId: owner.id });
      const { value } = await sut.create(auth, { albumId: album.id, type: ReactionType.LIKE });
      await sut.create(auth, { albumId: other.id, type: ReactionType.LIKE });

      await expect(sut.getAll(auth, { albumId: album.id })).resolves.toEqual([value]);
    });

    it('should filter by type=comment', async () => {
      const { sut, ctx } = setup();
      const { album, owner } = await ctx.newSharedAlbum();
      const auth = factory.auth({ user: owner });
      const { value } = await sut.create(auth, {
        albumId: album.id,
        type: ReactionType.COMMENT,
        comment: 'comment',
      });
      await sut.create(auth, { albumId: album.id, type: ReactionType.LIKE });

      await expect(sut.getAll(auth, { albumId: album.id, type: ReactionType.COMMENT })).resolves.toEqual([value]);
    });

    it('should filter by type=like', async () => {
      const { sut, ctx } = setup();
      const { album, owner } = await ctx.newSharedAlbum();
      const auth = factory.auth({ user: owner });
      const { value } = await sut.create(auth, { albumId: album.id, type: ReactionType.LIKE });
      await sut.create(auth, { albumId: album.id, type: ReactionType.COMMENT, comment: 'comment' });

      await expect(sut.getAll(auth, { albumId: album.id, type: ReactionType.LIKE })).resolves.toEqual([value]);
    });

    it('should filter by userId', async () => {
      const { sut, ctx } = setup();
      const { album, owner } = await ctx.newSharedAlbum();
      const auth = factory.auth({ user: owner });
      const { value } = await sut.create(auth, { albumId: album.id, type: ReactionType.LIKE });

      await expect(sut.getAll(auth, { albumId: album.id, userId: newUuid() })).resolves.toEqual([]);
      await expect(sut.getAll(auth, { albumId: album.id, userId: owner.id })).resolves.toEqual([value]);
    });

    it('should filter by assetId', async () => {
      const { sut, ctx } = setup();
      const { album, asset, owner } = await ctx.newSharedAlbum();
      const auth = factory.auth({ user: owner });
      const { value } = await sut.create(auth, {
        albumId: album.id,
        assetId: asset.id,
        type: ReactionType.LIKE,
      });
      await sut.create(auth, { albumId: album.id, type: ReactionType.LIKE });

      await expect(sut.getAll(auth, { albumId: album.id, assetId: asset.id })).resolves.toEqual([value]);
    });
  });

  describe('create', () => {
    it('should add a comment to an album', async () => {
      const { sut, ctx } = setup();
      const { album, owner } = await ctx.newSharedAlbum();
      const auth = factory.auth({ user: owner });

      await expect(
        sut.create(auth, { albumId: album.id, type: ReactionType.COMMENT, comment: 'This is my first comment' }),
      ).resolves.toEqual({
        duplicate: false,
        value: {
          id: expect.any(String),
          assetId: null,
          createdAt: expect.any(Date),
          type: ReactionType.COMMENT,
          comment: 'This is my first comment',
          user: expect.objectContaining({ id: owner.id }),
        },
      });
    });

    it('should add a like to an album', async () => {
      const { sut, ctx } = setup();
      const { album, owner } = await ctx.newSharedAlbum();
      const auth = factory.auth({ user: owner });

      await expect(sut.create(auth, { albumId: album.id, type: ReactionType.LIKE })).resolves.toEqual({
        duplicate: false,
        value: {
          id: expect.any(String),
          assetId: null,
          createdAt: expect.any(Date),
          type: ReactionType.LIKE,
          comment: null,
          user: expect.objectContaining({ id: owner.id }),
        },
      });
    });

    it('should report a duplicate like on an album', async () => {
      const { sut, ctx } = setup();
      const { album, owner } = await ctx.newSharedAlbum();
      const ownerAuth = factory.auth({ user: owner });
      const { value } = await sut.create(ownerAuth, { albumId: album.id, type: ReactionType.LIKE });

      await expect(sut.create(ownerAuth, { albumId: album.id, type: ReactionType.LIKE })).resolves.toEqual({
        duplicate: true,
        value,
      });
    });

    it('should not confuse an album like with an asset like', async () => {
      const { sut, ctx } = setup();
      const { album, asset, owner } = await ctx.newSharedAlbum();
      const ownerAuth = factory.auth({ user: owner });
      const { value } = await sut.create(ownerAuth, {
        albumId: album.id,
        assetId: asset.id,
        type: ReactionType.LIKE,
      });

      const result = await sut.create(ownerAuth, { albumId: album.id, type: ReactionType.LIKE });

      expect(result.duplicate).toBe(false);
      expect(result.value.id).not.toEqual(value.id);
    });

    it('should add a comment to an asset', async () => {
      const { sut, ctx } = setup();
      const { album, asset, owner } = await ctx.newSharedAlbum();

      await expect(
        sut.create(factory.auth({ user: owner }), {
          albumId: album.id,
          assetId: asset.id,
          type: ReactionType.COMMENT,
          comment: 'This is my first comment',
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          duplicate: false,
          value: expect.objectContaining({ assetId: asset.id, comment: 'This is my first comment' }),
        }),
      );
    });

    it('should add a like to an asset', async () => {
      const { sut, ctx } = setup();
      const { album, asset, owner } = await ctx.newSharedAlbum();

      await expect(
        sut.create(factory.auth({ user: owner }), { albumId: album.id, assetId: asset.id, type: ReactionType.LIKE }),
      ).resolves.toEqual(
        expect.objectContaining({
          duplicate: false,
          value: expect.objectContaining({ assetId: asset.id, type: ReactionType.LIKE, comment: null }),
        }),
      );
    });

    it('should report a duplicate like on an asset', async () => {
      const { sut, ctx } = setup();
      const { album, asset, owner } = await ctx.newSharedAlbum();
      const auth = factory.auth({ user: owner });
      const { value } = await sut.create(auth, {
        albumId: album.id,
        assetId: asset.id,
        type: ReactionType.LIKE,
      });

      await expect(
        sut.create(auth, { albumId: album.id, assetId: asset.id, type: ReactionType.LIKE }),
      ).resolves.toEqual({ duplicate: true, value });
    });

    it('should not let a user comment on an album they cannot access', async () => {
      const { sut, ctx } = setup();
      const { album } = await ctx.newSharedAlbum();
      const { user: outsider } = await ctx.newUser();

      await expect(
        sut.create(factory.auth({ user: outsider }), { albumId: album.id, type: ReactionType.LIKE }),
      ).rejects.toThrow('Not found or no activity.create access');
    });
  });

  describe('delete', () => {
    it('should remove a comment from an album', async () => {
      const { sut, ctx } = setup();
      const { album, owner } = await ctx.newSharedAlbum();
      const auth = factory.auth({ user: owner });
      const { value } = await sut.create(auth, {
        albumId: album.id,
        type: ReactionType.COMMENT,
        comment: 'This is a test comment',
      });

      await expect(sut.delete(auth, value.id)).resolves.toBeUndefined();
      await expect(sut.getAll(auth, { albumId: album.id })).resolves.toEqual([]);
    });

    it('should remove a like from an album', async () => {
      const { sut, ctx } = setup();
      const { album, owner } = await ctx.newSharedAlbum();
      const auth = factory.auth({ user: owner });
      const { value } = await sut.create(auth, { albumId: album.id, type: ReactionType.LIKE });

      await expect(sut.delete(auth, value.id)).resolves.toBeUndefined();
      await expect(sut.getAll(auth, { albumId: album.id })).resolves.toEqual([]);
    });

    it('should let the album owner remove a comment by another user', async () => {
      const { sut, ctx } = setup();
      const { album, owner, sharedWith } = await ctx.newSharedAlbum();
      const auth = factory.auth({ user: owner });
      const sharedWithAuth = factory.auth({ user: sharedWith });
      const { value } = await sut.create(sharedWithAuth, {
        albumId: album.id,
        type: ReactionType.COMMENT,
        comment: 'This is a test comment',
      });

      await expect(sut.delete(auth, value.id)).resolves.toBeUndefined();
      await expect(sut.getAll(auth, { albumId: album.id })).resolves.toEqual([]);
    });

    it('should not let a user remove a comment by another user', async () => {
      const { sut, ctx } = setup();
      const { album, owner, sharedWith } = await ctx.newSharedAlbum();
      const auth = factory.auth({ user: owner });
      const sharedWithAuth = factory.auth({ user: sharedWith });
      const { value } = await sut.create(auth, {
        albumId: album.id,
        type: ReactionType.COMMENT,
        comment: 'This is a test comment',
      });

      await expect(sut.delete(sharedWithAuth, value.id)).rejects.toThrow('Not found or no activity.delete access');
      await expect(sut.getAll(auth, { albumId: album.id })).resolves.toEqual([value]);
    });

    it('should let a non-owner remove their own comment', async () => {
      const { sut, ctx } = setup();
      const { album, owner, sharedWith } = await ctx.newSharedAlbum();
      const auth = factory.auth({ user: owner });
      const sharedWithAuth = factory.auth({ user: sharedWith });
      const { value } = await sut.create(sharedWithAuth, {
        albumId: album.id,
        type: ReactionType.COMMENT,
        comment: 'This is a test comment',
      });

      await expect(sut.delete(sharedWithAuth, value.id)).resolves.toBeUndefined();
      await expect(sut.getAll(auth, { albumId: album.id })).resolves.toEqual([]);
    });

    it('should drop activities when the asset is removed from the album', async () => {
      const { sut, ctx } = setup();
      const { album, asset, owner } = await ctx.newSharedAlbum();
      const auth = factory.auth({ user: owner });
      await sut.create(auth, { albumId: album.id, assetId: asset.id, type: ReactionType.LIKE });

      await ctx.database
        .deleteFrom('album_asset')
        .where('albumId', '=', album.id)
        .where('assetId', '=', asset.id)
        .execute();

      await expect(sut.getAll(auth, { albumId: album.id })).resolves.toEqual([]);
    });
  });

  describe('fork locks', () => {
    it("activity on an album hidden for the viewer is unreachable and write-protected; the owner's lock never binds a sharee", async () => {
      const { sut, ctx } = setup();
      const { album, owner, sharedWith } = await ctx.newSharedAlbum();
      const ownerAuth = factory.auth({ user: owner });
      const sharedWithAuth = factory.auth({ user: sharedWith });
      const { value } = await sut.create(sharedWithAuth, {
        albumId: album.id,
        type: ReactionType.COMMENT,
        comment: 'hi',
      });

      await ctx.get(LockRepository).lockAlbum(owner.id, album.id);

      // the locker is refused outside an elevated session (spec §15.4), reveal header or not
      const ALBUM_ERROR = 'Not found or no album.read access';
      const revealingUnelevated = { ...ownerAuth, revealedLocks: { albumIds: [album.id], containerIds: [] } };
      for (const auth of [ownerAuth, revealingUnelevated]) {
        await expect(sut.getAll(auth, { albumId: album.id })).rejects.toThrow(ALBUM_ERROR);
        await expect(sut.getStatistics(auth, { albumId: album.id })).rejects.toThrow(ALBUM_ERROR);
        // activity creation on hidden content is write-protected (spec §15.2)
        await expect(sut.create(auth, { albumId: album.id, type: ReactionType.LIKE })).rejects.toThrow(ALBUM_ERROR);
      }
      await expect(
        ctx.database.selectFrom('activity').select('id').where('albumId', '=', album.id).execute(),
      ).resolves.toEqual([{ id: value.id }]);

      // the album owner's lock is personal presentation state: the sharee is unaffected (spec §4)
      await expect(sut.getAll(sharedWithAuth, { albumId: album.id })).resolves.toEqual([value]);
      await expect(sut.create(sharedWithAuth, { albumId: album.id, type: ReactionType.LIKE })).resolves.toEqual(
        expect.objectContaining({ duplicate: false }),
      );

      // an elevated session bypasses the guard (direct-by-id, spec §15.3)
      const elevated = factory.auth({ user: owner, session: { hasElevatedPermission: true } });
      await expect(sut.getAll(elevated, { albumId: album.id })).resolves.toHaveLength(2);
      await expect(sut.create(elevated, { albumId: album.id, type: ReactionType.LIKE })).resolves.toEqual(
        expect.objectContaining({ duplicate: false }),
      );
    });

    it('non-elevated locker cannot delete an activity on a hidden album; elevated can', async () => {
      const { sut, ctx } = setup();
      const { album, owner, sharedWith } = await ctx.newSharedAlbum();
      const ownerAuth = factory.auth({ user: owner });
      const sharedWithAuth = factory.auth({ user: sharedWith });
      const { value: ownLike } = await sut.create(ownerAuth, { albumId: album.id, type: ReactionType.LIKE });
      const { value: shareeComment } = await sut.create(sharedWithAuth, {
        albumId: album.id,
        type: ReactionType.COMMENT,
        comment: 'hi',
      });
      const { value: shareeLike } = await sut.create(sharedWithAuth, { albumId: album.id, type: ReactionType.LIKE });

      await ctx.get(LockRepository).lockAlbum(owner.id, album.id);
      const activityIds = async () => {
        const rows = await ctx.database.selectFrom('activity').select('id').where('albumId', '=', album.id).execute();
        return new Set(rows.map(({ id }) => id));
      };

      // refused exactly like a missing activity (ruling R32), reveal header or not: neither the locker's own activity
      // nor one they may delete as the album owner
      const MISSING_ERROR = 'Not found or no activity.delete access';
      await expect(sut.delete(ownerAuth, newUuid())).rejects.toThrow(MISSING_ERROR);
      const revealingUnelevated = { ...ownerAuth, revealedLocks: { albumIds: [album.id], containerIds: [] } };
      for (const auth of [ownerAuth, revealingUnelevated]) {
        await expect(sut.delete(auth, ownLike.id)).rejects.toThrow(MISSING_ERROR);
        await expect(sut.delete(auth, shareeComment.id)).rejects.toThrow(MISSING_ERROR);
      }
      await expect(activityIds()).resolves.toEqual(new Set([ownLike.id, shareeComment.id, shareeLike.id]));

      // the owner's lock never binds the sharee (spec §4)
      await expect(sut.delete(sharedWithAuth, shareeLike.id)).resolves.toBeUndefined();

      // an elevated session bypasses the guard (direct-by-id, spec §15.3)
      const elevated = factory.auth({ user: owner, session: { hasElevatedPermission: true } });
      await expect(sut.delete(elevated, ownLike.id)).resolves.toBeUndefined();
      await expect(sut.delete(elevated, shareeComment.id)).resolves.toBeUndefined();
      await expect(activityIds()).resolves.toEqual(new Set());
    });
  });
});
