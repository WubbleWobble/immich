import { Kysely } from 'kysely';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LockRepository } from 'src/repositories/lock.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StackRepository } from 'src/repositories/stack.repository.js';
import { DB } from 'src/schema/index.js';
import { StackService } from 'src/services/stack.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(StackService, {
    database: db || defaultDatabase,
    real: [AccessRepository, AlbumRepository, AssetRepository, LockRepository, StackRepository],
    mock: [EventRepository, LoggingRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(StackService.name, () => {
  describe('create', () => {
    it('should not stack an asset of another user', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: otherAsset } = await ctx.newAsset({ ownerId: otherUser.id });

      await expect(sut.create(factory.auth({ user }), { assetIds: [asset.id, otherAsset.id] })).rejects.toThrow(
        'Not found or no asset.update access',
      );
      await expect(
        ctx.database.selectFrom('stack').selectAll().where('ownerId', '=', user.id).execute(),
      ).resolves.toEqual([]);
    });

    it('auto-stacking an uploaded edit onto a locked original does not expose the original', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { user } = await ctx.newUser();
      const stackRows = () =>
        ctx.database.selectFrom('stack').select(['id', 'primaryAssetId']).where('ownerId', '=', user.id).execute();
      const stackIdOf = async (id: string) => {
        const row = await ctx.database
          .selectFrom('asset')
          .select('stackId')
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        return row.stackId;
      };

      // stack members are read with their exif row (as every uploaded asset has one)
      const newStackAsset = async () => {
        const { asset } = await ctx.newAsset({ ownerId: user.id });
        await ctx.newExif({ assetId: asset.id, make: 'Canon' });
        return { asset };
      };

      const { asset: original } = await newStackAsset();
      const { asset: edit } = await newStackAsset();
      const { album: locked } = await ctx.newAlbum({ ownerId: user.id }, [original.id]);
      await ctx.get(LockRepository).lockAlbum(user.id, locked.id);

      // the mobile client stacks the freshly uploaded edit over its original (962ffaacc)
      const auth = factory.auth({ user });
      await expect(sut.create(auth, { assetIds: [edit.id, original.id] })).rejects.toThrow(
        'Not found or no asset.update access',
      );
      await expect(stackRows()).resolves.toEqual([]);
      await expect(stackIdOf(original.id)).resolves.toBeNull();

      // a reveal header is presentation state, never write access (spec §15.13)
      const revealing = { ...auth, revealedLocks: { albumIds: [locked.id], containerIds: [] } };
      await expect(sut.create(revealing, { assetIds: [edit.id, original.id] })).rejects.toThrow(
        'Not found or no asset.update access',
      );

      // the original is visible, but its existing stack holds a hidden member: merging that stack would re-stack the
      // hidden asset and return it in the response, so the whole create is refused (stack rules, spec §15.12)
      const { asset: visibleOriginal } = await newStackAsset();
      const { asset: hiddenSibling } = await newStackAsset();
      await ctx.newAlbumAsset({ albumId: locked.id, assetId: hiddenSibling.id });
      const { stack: existing } = await ctx.newStack({ ownerId: user.id }, [visibleOriginal.id, hiddenSibling.id]);
      await expect(sut.create(auth, { assetIds: [edit.id, visibleOriginal.id] })).rejects.toThrow(
        'Asset stack not found',
      );
      // ...and likewise when the visible original is a secondary of that stack
      const { asset: anotherEdit } = await newStackAsset();
      await expect(sut.create(auth, { assetIds: [anotherEdit.id, hiddenSibling.id] })).rejects.toThrow(
        'Not found or no asset.update access',
      );
      const { asset: hiddenPrimary } = await newStackAsset();
      const { asset: visibleSecondary } = await newStackAsset();
      await ctx.newAlbumAsset({ albumId: locked.id, assetId: hiddenPrimary.id });
      const { stack: hiddenPrimaryStack } = await ctx.newStack({ ownerId: user.id }, [
        hiddenPrimary.id,
        visibleSecondary.id,
      ]);
      await expect(sut.create(auth, { assetIds: [anotherEdit.id, visibleSecondary.id] })).rejects.toThrow(
        'Asset stack not found',
      );
      await expect(stackRows()).resolves.toEqual(
        expect.arrayContaining([
          { id: existing.id, primaryAssetId: visibleOriginal.id },
          { id: hiddenPrimaryStack.id, primaryAssetId: hiddenPrimary.id },
        ]),
      );
      await expect(stackRows()).resolves.toHaveLength(2);
      await expect(stackIdOf(hiddenSibling.id)).resolves.toBe(existing.id);
      await expect(stackIdOf(visibleSecondary.id)).resolves.toBe(hiddenPrimaryStack.id);
      await expect(stackIdOf(edit.id)).resolves.toBeNull();

      // an elevated session may organise its hidden content (the mutation bypass)
      const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });
      const stack = await sut.create(elevated, { assetIds: [edit.id, original.id] });
      expect(stack.assets.map(({ id }) => id).toSorted()).toEqual([edit.id, original.id].toSorted());
    });
  });
});
