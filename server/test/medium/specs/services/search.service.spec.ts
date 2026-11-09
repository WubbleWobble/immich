import { ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { ZodValidationPipe } from 'nestjs-zod';
import { randomBytes } from 'node:crypto';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { IdsFilter, MetadataSearchDto, SearchFilter, SearchSuggestionType } from 'src/dtos/search.dto.js';
import { AlbumKind, AlbumUserRole, AssetOrder, AssetVisibility, SearchOrderField, SharedLinkType } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumContainerRepository } from 'src/repositories/album-container.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LockRepository } from 'src/repositories/lock.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { SearchService } from 'src/services/search.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const unitVector = (index: number) => JSON.stringify(Array.from({ length: 512 }, (_, i) => (i === index ? 1 : 0)));

/** Request-body validation as the app's global ZodValidationPipe runs it (a failure is a 400). */
const validateSearchBody = (filter: unknown) =>
  Promise.try(() =>
    new ZodValidationPipe().transform({ filter }, {
      type: 'body',
      metatype: MetadataSearchDto,
    } as ArgumentMetadata),
  );

const setup = (db?: Kysely<DB>) => {
  const result = newMediumService(SearchService, {
    database: db || defaultDatabase,
    real: [
      LockRepository,
      AccessRepository,
      AlbumRepository,
      AssetRepository,
      ConfigRepository,
      DatabaseRepository,
      SearchRepository,
      PartnerRepository,
      PersonRepository,
      SystemMetadataRepository,
    ],
    mock: [LoggingRepository, MachineLearningRepository],
  });
  // smart/vector search runs on a stubbed text embedding
  result.ctx.getMock(MachineLearningRepository).encodeText.mockResolvedValue(unitVector(0));
  return result;
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(SearchService.name, () => {
  it('should work', () => {
    const { sut } = setup();
    expect(sut).toBeDefined();
  });

  it('should return assets', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();

    const assets = [];
    const sizes = [12_334, 599, 123_456];

    for (let i = 0; i < sizes.length; i++) {
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, fileSizeInByte: sizes[i] });
      assets.push(asset);
    }

    const auth = factory.auth({ user: { id: user.id } });

    await expect(sut.searchLargeAssets(auth, { size: 250 })).resolves.toEqual([
      expect.objectContaining({ id: assets[2].id }),
      expect.objectContaining({ id: assets[0].id }),
      expect.objectContaining({ id: assets[1].id }),
    ]);
  });

  it('should not return hidden assets', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();

    const { asset: visibleAsset } = await ctx.newAsset({ ownerId: user.id });
    await ctx.newExif({ assetId: visibleAsset.id, fileSizeInByte: 1000 });
    const { asset: hiddenAsset } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Hidden });
    await ctx.newExif({ assetId: hiddenAsset.id, fileSizeInByte: 2000 });

    const auth = factory.auth({ user: { id: user.id } });

    await expect(sut.searchLargeAssets(auth, { size: 250 })).resolves.toEqual([
      expect.objectContaining({ id: visibleAsset.id }),
    ]);
  });

  describe('searchStatistics', () => {
    it('should return statistics when filtering by personIds', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { person } = await ctx.newPerson({ ownerId: user.id });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });

      const auth = factory.auth({ user: { id: user.id } });

      const result = await sut.searchStatistics(auth, { personIds: [person.personGroupId] });

      expect(result).toEqual({ total: 1 });
    });

    it('should return zero when no assets match the personIds filter', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });

      const auth = factory.auth({ user: { id: user.id } });

      const result = await sut.searchStatistics(auth, { personIds: [person.personGroupId] });

      expect(result).toEqual({ total: 0 });
    });

    it('should not return locked assets of partner in elevated session', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();

      await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id });

      await ctx.newAsset({ ownerId: partner.id, visibility: AssetVisibility.Locked });

      const auth = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });

      const result = await sut.searchStatistics(auth, { visibility: AssetVisibility.Locked });

      expect(result).toEqual({ total: 0 });
    });
  });

  describe('withStacked option', () => {
    it('should exclude stacked assets when withStacked is false', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();

      const { asset: primaryAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: stackedAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: unstackedAsset } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newStack({ ownerId: user.id }, [primaryAsset.id, stackedAsset.id]);

      const auth = factory.auth({ user: { id: user.id } });

      const response = await sut.searchMetadata(auth, { size: 250, withStacked: false });

      expect(response.assets.items.length).toBe(1);
      expect(response.assets.items[0].id).toBe(unstackedAsset.id);
    });

    describe('visibility', () => {
      it('should filter out locked assets in a default session', async () => {
        const { sut, ctx } = setup();
        const { user } = await ctx.newUser();

        await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });

        const auth = factory.auth({ user: { id: user.id } });

        const response = await sut.searchMetadata(auth, { size: 250, withStacked: false });

        expect(response.assets.items.length).toBe(0);
      });

      it('should return locked assets in an elevated session', async () => {
        const { sut, ctx } = setup();
        const { user } = await ctx.newUser();

        await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });

        const auth = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });

        const response = await sut.searchMetadata(auth, { size: 250, withStacked: false });

        expect(response.assets.items.length).toBe(1);
      });
    });
  });

  describe('albumIds option', () => {
    it('should return assets from shared album', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();

      const { asset } = await ctx.newAsset({ ownerId: otherUser.id });
      const { album } = await ctx.newAlbum({ ownerId: otherUser.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });
      await ctx.newAlbumUser({ albumId: album.id, userId: user.id, role: AlbumUserRole.Editor });

      const auth = factory.auth({ user: { id: user.id } });

      const response = await sut.searchMetadata(auth, { size: 250, albumIds: [album.id] });

      expect(response.assets.items.length).toBe(1);
    });

    it('should not return assets for album, a user is not in, when partner sharing is enabled', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();

      await ctx.newPartner({ sharedById: otherUser.id, sharedWithId: user.id });

      const { asset } = await ctx.newAsset({ ownerId: otherUser.id });
      const { album } = await ctx.newAlbum({ ownerId: otherUser.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });

      const auth = factory.auth({ user: { id: user.id } });

      await expect(sut.searchMetadata(auth, { size: 250, albumIds: [album.id] })).rejects.toThrow(
        'Not found or no album.read access',
      );
    });
  });

  describe('getSearchSuggestions', () => {
    it('should filter out empty search suggestions', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();

      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });

      const { asset: assetWithEmptyMake } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: assetWithEmptyMake.id, make: '' });

      const auth = factory.auth({ user: { id: user.id } });
      const suggestions = await sut.getSearchSuggestions(auth, {
        type: SearchSuggestionType.CAMERA_MAKE,
        includeNull: true,
      });

      expect(suggestions).toEqual(['Canon', null]);
    });
  });

  describe('searchRandom', () => {
    it('should filter out locked assets in a default session', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();

      await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });

      const auth = factory.auth({ user: { id: user.id } });

      const response = await sut.searchRandom(auth, { size: 250 });

      expect(response.length).toBe(0);
    });
  });

  describe('new search shape', () => {
    it('should filter by an exif field and return a cursor-less single page', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, city: 'Oslo' });
      const { asset: other } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: other.id, city: 'Bergen' });

      const auth = factory.auth({ user: { id: user.id } });
      const response = await sut.searchMetadata(auth, { size: 250, filter: { city: { eq: 'Oslo' } } });

      expect(response.assets.items).toEqual([expect.objectContaining({ id: asset.id })]);
      expect(response.assets.nextPage).toBeNull();
      expect(response.assets.nextCursor).toBeNull();
    });

    it('should combine OR branches', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: oslo } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: oslo.id, city: 'Oslo' });
      const { asset: favorite } = await ctx.newAsset({ ownerId: user.id, isFavorite: true });
      await ctx.newAsset({ ownerId: user.id });

      const auth = factory.auth({ user: { id: user.id } });
      const response = await sut.searchMetadata(auth, {
        size: 250,
        filter: { or: [{ city: { eq: 'Oslo' } }, { isFavorite: { eq: true } }] },
      });

      expect(response.assets.items.map(({ id }) => id).toSorted()).toEqual([oslo.id, favorite.id].toSorted());
    });

    it('should scope a top-level album constraint to the album', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: otherUser.id });
      const { album } = await ctx.newAlbum({ ownerId: user.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });

      const auth = factory.auth({ user: { id: user.id } });
      const response = await sut.searchMetadata(auth, { size: 250, filter: { albumIds: { any: [album.id] } } });

      expect(response.assets.items).toEqual([expect.objectContaining({ id: asset.id })]);
    });

    it('should scope an album-constrained branch to the album', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: otherUser.id });
      const { album } = await ctx.newAlbum({ ownerId: user.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });

      const auth = factory.auth({ user: { id: user.id } });
      const response = await sut.searchMetadata(auth, {
        size: 250,
        filter: { or: [{ albumIds: { any: [album.id] } }] },
      });

      expect(response.assets.items).toEqual([expect.objectContaining({ id: asset.id })]);
    });

    it('should keep the ownership scope for branches without an album constraint', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const { asset: ownOslo } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: ownOslo.id, city: 'Oslo' });
      const { asset: foreignOslo } = await ctx.newAsset({ ownerId: otherUser.id });
      await ctx.newExif({ assetId: foreignOslo.id, city: 'Oslo' });
      const { asset: albumAsset } = await ctx.newAsset({ ownerId: otherUser.id });
      const { album } = await ctx.newAlbum({ ownerId: user.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: albumAsset.id });

      const auth = factory.auth({ user: { id: user.id } });
      const response = await sut.searchMetadata(auth, {
        size: 250,
        filter: { or: [{ albumIds: { any: [album.id] } }, { city: { eq: 'Oslo' } }] },
      });

      // the album branch searches the album, the city branch stays confined to the caller's own assets
      expect(response.assets.items.map(({ id }) => id).toSorted()).toEqual([ownOslo.id, albumAsset.id].toSorted());
    });

    it('should reject an inaccessible album anywhere in the filter', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: otherUser.id });

      const auth = factory.auth({ user: { id: user.id } });

      await expect(
        sut.searchMetadata(auth, { size: 250, filter: { or: [{ albumIds: { none: [album.id] } }] } }),
      ).rejects.toThrow('Not found or no album.read access');
    });

    it('should paginate with an opaque cursor', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      for (let i = 0; i < 3; i++) {
        await ctx.newAsset({ ownerId: user.id });
      }

      const auth = factory.auth({ user: { id: user.id } });

      const firstPage = await sut.searchMetadata(auth, { filter: {}, size: 2 });
      expect(firstPage.assets.items.length).toBe(2);
      expect(firstPage.assets.nextPage).toBeNull();
      expect(firstPage.assets.nextCursor).toEqual(expect.any(String));

      const secondPage = await sut.searchMetadata(auth, { cursor: firstPage.assets.nextCursor!, size: 2 });
      expect(secondPage.assets.items.length).toBe(1);
      expect(secondPage.assets.nextCursor).toBeNull();

      const ids = [...firstPage.assets.items, ...secondPage.assets.items].map(({ id }) => id);
      expect(new Set(ids).size).toBe(3);
    });

    it('should order by fileSizeInBytes', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const sizes = [12_334, 599, 123_456];
      const assetIds: string[] = [];
      for (const fileSizeInByte of sizes) {
        const { asset } = await ctx.newAsset({ ownerId: user.id });
        await ctx.newExif({ assetId: asset.id, fileSizeInByte });
        assetIds.push(asset.id);
      }

      const auth = factory.auth({ user: { id: user.id } });
      const response = await sut.searchMetadata(auth, {
        size: 250,
        orderBy: { field: SearchOrderField.FileSizeInBytes, direction: AssetOrder.Asc },
      });

      expect(response.assets.items.map(({ id }) => id)).toEqual([assetIds[1], assetIds[0], assetIds[2]]);
    });

    it('should order smart search results by embedding distance with cursor offsets', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const searchRepository = ctx.get(SearchRepository);

      const assetIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const { asset } = await ctx.newAsset({ ownerId: user.id });
        await searchRepository.upsert(asset.id, unitVector(i));
        assetIds.push(asset.id);
      }

      const options = { filter: {}, embedding: unitVector(0) };
      const scope = { userIds: [user.id], grantedAlbumIds: [] };
      const firstPage = await searchRepository.searchSmartV3({ take: 2 }, options, scope);
      expect(firstPage.items.length).toBe(2);
      expect(firstPage.items[0].id).toBe(assetIds[0]);
      expect(firstPage.hasNextPage).toBe(true);

      const secondPage = await searchRepository.searchSmartV3({ take: 2, skip: 2 }, options, scope);
      expect(secondPage.items.length).toBe(1);
      expect(secondPage.hasNextPage).toBe(false);
    });
  });

  describe('fork locks in the new search shape', () => {
    const SMART_ALBUM_ERROR = 'Smart albums cannot be used as a search album filter';
    const ALBUM_ACCESS_ERROR = 'Not found or no album.read access';

    type Ctx = ReturnType<typeof setup>['ctx'];

    /** Every asset gets an embedding, so smart/vector search sees the same universe as the other kinds. */
    const newSearchAsset = async (ctx: Ctx, dto: { ownerId: string; isFavorite?: boolean; city?: string }) => {
      const { asset } = await ctx.newAsset({ ownerId: dto.ownerId, isFavorite: dto.isFavorite ?? false });
      if (dto.city) {
        await ctx.newExif({ assetId: asset.id, city: dto.city });
      }
      await ctx.get(SearchRepository).upsert(asset.id, unitVector(0));
      return asset;
    };

    const lockAlbum = (ctx: Ctx, userId: string, albumId: string) => ctx.get(LockRepository).lockAlbum(userId, albumId);

    const v3SearchSpies = (ctx: Ctx) => {
      const repository = ctx.get(SearchRepository);
      return [
        vi.spyOn(repository, 'searchMetadataV3'),
        vi.spyOn(repository, 'searchStatisticsV3'),
        vi.spyOn(repository, 'searchRandomV3'),
        vi.spyOn(repository, 'searchSmartV3'),
      ];
    };

    const SEARCH_KINDS = ['metadata', 'statistics', 'random', 'smart'] as const;
    type SearchKind = (typeof SEARCH_KINDS)[number];

    describe.each(SEARCH_KINDS)('%s search', (kind: SearchKind) => {
      /** Result ids (sorted), or the total for statistics, which has no items. */
      const search = async (sut: SearchService, auth: AuthDto, filter: SearchFilter) => {
        switch (kind) {
          case 'metadata': {
            const response = await sut.searchMetadata(auth, { size: 250, filter });
            return response.assets.items.map(({ id }) => id).toSorted();
          }
          case 'statistics': {
            const { total } = await sut.searchStatistics(auth, { filter });
            return total;
          }
          case 'random': {
            const assets = await sut.searchRandom(auth, { size: 250, filter });
            return assets.map(({ id }) => id).toSorted();
          }
          case 'smart': {
            const response = await sut.searchSmart(auth, { size: 100, query: 'photo', filter });
            return response.assets.items.map(({ id }) => id).toSorted();
          }
        }
      };

      const expected = (ids: string[]) => (kind === 'statistics' ? ids.length : ids.toSorted());

      it("excludes assets hidden by the owner's locks in timeline/partner scope", async () => {
        const { sut, ctx } = setup();
        const { user: viewer } = await ctx.newUser();
        const { user: partner } = await ctx.newUser();
        await ctx.newPartner({ sharedById: partner.id, sharedWithId: viewer.id });

        const viewerVisible = await newSearchAsset(ctx, { ownerId: viewer.id });
        const viewerHidden = await newSearchAsset(ctx, { ownerId: viewer.id });
        const partnerVisible = await newSearchAsset(ctx, { ownerId: partner.id });
        const partnerHidden = await newSearchAsset(ctx, { ownerId: partner.id });
        const { album: viewerLocked } = await ctx.newAlbum({ ownerId: viewer.id }, [viewerHidden.id]);
        const { album: partnerLocked } = await ctx.newAlbum({ ownerId: partner.id }, [partnerHidden.id]);
        await lockAlbum(ctx, viewer.id, viewerLocked.id);
        await lockAlbum(ctx, partner.id, partnerLocked.id);

        const visible = [viewerVisible.id, partnerVisible.id];
        const plain = factory.auth({ user: { id: viewer.id } });
        await expect(search(sut, plain, {})).resolves.toEqual(expected(visible));

        // search is a list-like surface: elevation alone reveals nothing (spec §15.3)
        const elevated = factory.auth({ user: { id: viewer.id }, session: { hasElevatedPermission: true } });
        await expect(search(sut, elevated, {})).resolves.toEqual(expected(visible));

        // the viewer's reveal applies to the viewer's own locks only, never to a partner's
        const revealing = {
          ...elevated,
          revealedLocks: { albumIds: [viewerLocked.id, partnerLocked.id], containerIds: [] },
        };
        await expect(search(sut, revealing, {})).resolves.toEqual(expected([...visible, viewerHidden.id]));

        // a reveal header without elevation is ignored
        const unelevatedReveal = { ...plain, revealedLocks: revealing.revealedLocks };
        await expect(search(sut, unelevatedReveal, {})).resolves.toEqual(expected(visible));
      });

      it("applies the owner's smart albums inside the lock filter (a visible smart album rescues)", async () => {
        const { sut, ctx } = setup();
        const { user: viewer } = await ctx.newUser();
        const { user: partner } = await ctx.newUser();
        await ctx.newPartner({ sharedById: partner.id, sharedWithId: viewer.id });

        const rescued = await newSearchAsset(ctx, { ownerId: partner.id, city: 'Rescue' });
        const hidden = await newSearchAsset(ctx, { ownerId: partner.id, city: 'Elsewhere' });
        const { album: locked } = await ctx.newAlbum({ ownerId: partner.id }, [rescued.id, hidden.id]);
        await ctx.newAlbum({ ownerId: partner.id, kind: AlbumKind.Smart, filter: { city: 'Rescue' } });
        await lockAlbum(ctx, partner.id, locked.id);

        const auth = factory.auth({ user: { id: viewer.id } });
        await expect(search(sut, auth, {})).resolves.toEqual(expected([rescued.id]));
        await expect(search(sut, auth, { city: { ne: 'Nowhere' } })).resolves.toEqual(expected([rescued.id]));
      });

      it('or-branch without locked album ids still excludes hidden assets', async () => {
        const { sut, ctx } = setup();
        const { user: viewer } = await ctx.newUser();
        const { user: partner } = await ctx.newUser();
        await ctx.newPartner({ sharedById: partner.id, sharedWithId: viewer.id });

        const visibleFavorite = await newSearchAsset(ctx, { ownerId: viewer.id, isFavorite: true });
        const visibleInX = await newSearchAsset(ctx, { ownerId: partner.id, city: 'X' });
        const viewerHidden = await newSearchAsset(ctx, { ownerId: viewer.id, isFavorite: true, city: 'X' });
        const partnerHidden = await newSearchAsset(ctx, { ownerId: partner.id, isFavorite: true, city: 'X' });
        const { album: viewerLocked } = await ctx.newAlbum({ ownerId: viewer.id }, [viewerHidden.id]);
        const { album: partnerLocked } = await ctx.newAlbum({ ownerId: partner.id }, [partnerHidden.id]);
        await lockAlbum(ctx, viewer.id, viewerLocked.id);
        await lockAlbum(ctx, partner.id, partnerLocked.id);

        const auth = factory.auth({ user: { id: viewer.id } });
        await expect(search(sut, auth, { or: [{ isFavorite: { eq: true } }, { city: { eq: 'X' } }] })).resolves.toEqual(
          expected([visibleFavorite.id, visibleInX.id]),
        );
        await expect(
          search(sut, auth, { isFavorite: { eq: true }, or: [{ city: { eq: 'X' } }, { city: { ne: 'X' } }] }),
        ).resolves.toEqual(expected([]));
      });

      it('or-branch naming a hidden album is rejected', async () => {
        const { sut, ctx } = setup();
        const { user: viewer } = await ctx.newUser();
        const hidden = await newSearchAsset(ctx, { ownerId: viewer.id, isFavorite: true });
        const { album: locked } = await ctx.newAlbum({ ownerId: viewer.id }, [hidden.id]);
        await lockAlbum(ctx, viewer.id, locked.id);
        const spies = v3SearchSpies(ctx);

        const auth = factory.auth({ user: { id: viewer.id } });
        for (const albumIds of [{ any: [locked.id] }, { all: [locked.id] }, { none: [locked.id] }]) {
          await expect(search(sut, auth, { or: [{ albumIds }, { isFavorite: { eq: true } }] })).rejects.toThrow(
            new BadRequestException(ALBUM_ACCESS_ERROR),
          );
          await expect(search(sut, auth, { albumIds })).rejects.toThrow(new BadRequestException(ALBUM_ACCESS_ERROR));
        }
        for (const spy of spies) {
          expect(spy).not.toHaveBeenCalled();
        }
      });

      it("mixed scope: album grant survives the sharer's own lock", async () => {
        const { sut, ctx } = setup();
        const { user: sharer } = await ctx.newUser();
        const { user: viewer } = await ctx.newUser();
        await ctx.newPartner({ sharedById: sharer.id, sharedWithId: viewer.id });

        const inShared = await newSearchAsset(ctx, { ownerId: sharer.id });
        const { album: shared } = await ctx.newAlbum({ ownerId: sharer.id }, [inShared.id]);
        await ctx.newAlbumUser({ albumId: shared.id, userId: viewer.id, role: AlbumUserRole.Viewer });
        await lockAlbum(ctx, sharer.id, shared.id);
        // a favorite the sharer hid in a private album stays hidden on the partner arm
        const sharerHidden = await newSearchAsset(ctx, { ownerId: sharer.id, isFavorite: true });
        const { album: privateLocked } = await ctx.newAlbum({ ownerId: sharer.id }, [sharerHidden.id]);
        await lockAlbum(ctx, sharer.id, privateLocked.id);

        const auth = factory.auth({ user: { id: viewer.id } });
        await expect(
          search(sut, auth, { or: [{ albumIds: { any: [shared.id] } }, { isFavorite: { eq: true } }] }),
        ).resolves.toEqual(expected([inShared.id]));
        await expect(search(sut, auth, { or: [{ albumIds: { any: [shared.id] } }] })).resolves.toEqual(
          expected([inShared.id]),
        );
        await expect(search(sut, auth, { albumIds: { any: [shared.id] } })).resolves.toEqual(expected([inShared.id]));
        await expect(search(sut, auth, { albumIds: { all: [shared.id] } })).resolves.toEqual(expected([inShared.id]));
      });

      it('naming an album hidden for the viewer is rejected even though partner scope could reach its assets', async () => {
        const { sut, ctx } = setup();
        const { user: sharer } = await ctx.newUser();
        const { user: viewer } = await ctx.newUser();
        await ctx.newPartner({ sharedById: sharer.id, sharedWithId: viewer.id });

        const inShared = await newSearchAsset(ctx, { ownerId: sharer.id, isFavorite: true });
        const { album: shared } = await ctx.newAlbum({ ownerId: sharer.id }, [inShared.id]);
        await ctx.newAlbumUser({ albumId: shared.id, userId: viewer.id, role: AlbumUserRole.Viewer });
        await lockAlbum(ctx, viewer.id, shared.id);
        const spies = v3SearchSpies(ctx);

        const auth = factory.auth({ user: { id: viewer.id } });
        await expect(
          search(sut, auth, { or: [{ albumIds: { any: [shared.id] } }, { isFavorite: { eq: true } }] }),
        ).rejects.toThrow(new BadRequestException(ALBUM_ACCESS_ERROR));
        for (const spy of spies) {
          expect(spy).not.toHaveBeenCalled();
        }
      });

      it('partner scope still returns an asset A has not hidden even when it is also in an album B hid', async () => {
        const { sut, ctx } = setup();
        const { user: sharer } = await ctx.newUser();
        const { user: viewer } = await ctx.newUser();
        await ctx.newPartner({ sharedById: sharer.id, sharedWithId: viewer.id });

        const asset = await newSearchAsset(ctx, { ownerId: sharer.id, isFavorite: true });
        const { album: shared } = await ctx.newAlbum({ ownerId: sharer.id }, [asset.id]);
        await ctx.newAlbumUser({ albumId: shared.id, userId: viewer.id, role: AlbumUserRole.Viewer });
        await lockAlbum(ctx, viewer.id, shared.id);

        const auth = factory.auth({ user: { id: viewer.id } });
        await expect(search(sut, auth, { isFavorite: { eq: true } })).resolves.toEqual(expected([asset.id]));
      });

      it('shared link album search respects locks', async () => {
        const { sut, ctx } = setup();
        const { user: owner } = await ctx.newUser();
        const inLinked = await newSearchAsset(ctx, { ownerId: owner.id, isFavorite: true });
        const { album: linked } = await ctx.newAlbum({ ownerId: owner.id }, [inLinked.id]);
        const hidden = await newSearchAsset(ctx, { ownerId: owner.id, isFavorite: true });
        const { album: other } = await ctx.newAlbum({ ownerId: owner.id }, [hidden.id]);
        // the owner's own locks are personal organisation: they do not withdraw a deliberate link grant (spec §4)
        await lockAlbum(ctx, owner.id, linked.id);
        await lockAlbum(ctx, owner.id, other.id);
        const sharedLink = await ctx.get(SharedLinkRepository).create({
          allowUpload: false,
          key: randomBytes(16),
          type: SharedLinkType.Album,
          userId: owner.id,
          albumId: linked.id,
        });

        const auth = factory.auth({ user: { id: owner.id }, sharedLink: { id: sharedLink.id, albumId: linked.id } });
        await expect(search(sut, auth, { albumIds: { any: [linked.id] } })).resolves.toEqual(expected([inLinked.id]));
        await expect(search(sut, auth, { or: [{ albumIds: { any: [linked.id] } }] })).resolves.toEqual(
          expected([inLinked.id]),
        );
        // the link has no universe beyond its album: an unconfined branch, or another album of the owner, is refused
        await expect(
          search(sut, auth, { or: [{ albumIds: { any: [linked.id] } }, { isFavorite: { eq: true } }] }),
        ).rejects.toThrow('Shared link access is only allowed in combination with an albumIds filter');
        await expect(search(sut, auth, { albumIds: { any: [other.id] } })).rejects.toThrow(ALBUM_ACCESS_ERROR);
      });

      it('folder-derived album access respects locks', async () => {
        const { sut, ctx } = setup();
        const { user: owner } = await ctx.newUser();
        const { user: viewer } = await ctx.newUser();
        const folders = ctx.get(AlbumContainerRepository);
        const folder = await folders.create({ ownerId: owner.id, name: 'Family', parentId: null });
        const asset = await newSearchAsset(ctx, { ownerId: owner.id });
        const { album } = await ctx.newAlbum({ ownerId: owner.id, containerId: folder.id }, [asset.id]);
        await folders.addUser(folder.id, viewer.id, AlbumUserRole.Viewer);

        // the folder owner's lock does not withdraw the cascade grant
        await ctx.get(LockRepository).lockContainer(owner.id, folder.id);
        const auth = factory.auth({ user: { id: viewer.id } });
        await expect(search(sut, auth, { albumIds: { any: [album.id] } })).resolves.toEqual(expected([asset.id]));

        // the viewer's own lock on the shared folder withholds it outside an elevated session
        await ctx.get(LockRepository).lockContainer(viewer.id, folder.id);
        await expect(search(sut, auth, { albumIds: { any: [album.id] } })).rejects.toThrow(
          new BadRequestException(ALBUM_ACCESS_ERROR),
        );
        await expect(
          search(sut, auth, { or: [{ albumIds: { none: [album.id] } }, { isFavorite: { eq: true } }] }),
        ).rejects.toThrow(new BadRequestException(ALBUM_ACCESS_ERROR));

        // direct-by-id: an elevated session reaches the album it names (spec §15.3)
        const elevated = factory.auth({ user: { id: viewer.id }, session: { hasElevatedPermission: true } });
        await expect(search(sut, elevated, { albumIds: { any: [album.id] } })).resolves.toEqual(expected([asset.id]));
      });

      it('rejects smart album ids in any/all/none at root and in or-branches, v1 and v3', async () => {
        const { sut, ctx } = setup();
        const { user: viewer } = await ctx.newUser();
        const { user: stranger } = await ctx.newUser();
        await newSearchAsset(ctx, { ownerId: viewer.id, city: 'X' });
        const { album: smart } = await ctx.newAlbum({
          ownerId: viewer.id,
          kind: AlbumKind.Smart,
          filter: { city: 'X' },
        });
        const { album: regular } = await ctx.newAlbum({ ownerId: viewer.id });
        const { album: foreignSmart } = await ctx.newAlbum({
          ownerId: stranger.id,
          kind: AlbumKind.Smart,
          filter: { city: 'X' },
        });
        const spies = v3SearchSpies(ctx);

        const auth = factory.auth({ user: { id: viewer.id } });
        for (const operator of ['any', 'all', 'none'] as const) {
          const albumIds = { [operator]: [regular.id, smart.id] } as IdsFilter;
          await expect(search(sut, auth, { albumIds })).rejects.toThrow(new BadRequestException(SMART_ALBUM_ERROR));
          await expect(search(sut, auth, { or: [{ isFavorite: { eq: true } }, { albumIds }] })).rejects.toThrow(
            new BadRequestException(SMART_ALBUM_ERROR),
          );
          // authorization runs first: an unreadable smart album never reveals that it is smart
          const foreign = { [operator]: [foreignSmart.id] } as IdsFilter;
          await expect(search(sut, auth, { or: [{ albumIds: foreign }] })).rejects.toThrow(
            new BadRequestException(ALBUM_ACCESS_ERROR),
          );
        }
        for (const spy of spies) {
          expect(spy).not.toHaveBeenCalled();
        }

        // v1 (flat) albumIds
        const v1 = (albumIds: string[]) => {
          switch (kind) {
            case 'metadata': {
              return sut.searchMetadata(auth, { size: 250, albumIds });
            }
            case 'statistics': {
              return sut.searchStatistics(auth, { albumIds });
            }
            case 'random': {
              return sut.searchRandom(auth, { size: 250, albumIds });
            }
            case 'smart': {
              return sut.searchSmart(auth, { size: 100, query: 'photo', albumIds });
            }
          }
        };
        await expect(v1([regular.id, smart.id])).rejects.toThrow(new BadRequestException(SMART_ALBUM_ERROR));
        await expect(v1([foreignSmart.id])).rejects.toThrow(new BadRequestException(ALBUM_ACCESS_ERROR));
        await expect(v1([regular.id])).resolves.toBeDefined();
      });
    });

    it('rejects smart album ids in the v1 large-asset search', async () => {
      const { sut, ctx } = setup();
      const { user: viewer } = await ctx.newUser();
      const { album: smart } = await ctx.newAlbum({ ownerId: viewer.id, kind: AlbumKind.Smart, filter: { city: 'X' } });

      const auth = factory.auth({ user: { id: viewer.id } });
      await expect(sut.searchLargeAssets(auth, { size: 250, albumIds: [smart.id] })).rejects.toThrow(
        new BadRequestException(SMART_ALBUM_ERROR),
      );
    });

    it('rejects nested or inside an or-branch and an and field', async () => {
      const validate = validateSearchBody;

      await expect(validate({ or: [{ or: [{ isFavorite: { eq: true } }] }] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(validate({ and: [{ isFavorite: { eq: true } }] })).rejects.toBeInstanceOf(BadRequestException);
      await expect(validate({ or: [{ and: [{ isFavorite: { eq: true } }] }] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(validate({ or: [{ isFavorite: { eq: true } }] })).resolves.toBeDefined();
    });

    it('rejects visibility locked inside structured filters', async () => {
      const validate = validateSearchBody;

      for (const visibility of [
        { eq: AssetVisibility.Locked },
        { ne: AssetVisibility.Locked },
        { in: [AssetVisibility.Timeline, AssetVisibility.Locked] },
        { notIn: [AssetVisibility.Locked] },
      ]) {
        await expect(validate({ visibility })).rejects.toBeInstanceOf(BadRequestException);
        await expect(validate({ or: [{ isFavorite: { eq: true } }, { visibility }] })).rejects.toBeInstanceOf(
          BadRequestException,
        );
      }
      await expect(validate({ visibility: { eq: AssetVisibility.Archive } })).resolves.toBeDefined();
    });
  });
});
