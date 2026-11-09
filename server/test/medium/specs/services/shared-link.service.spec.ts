import { Kysely } from 'kysely';
import { randomBytes } from 'node:crypto';
import { AssetIdErrorReason } from 'src/dtos/asset-ids.response.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AlbumKind, AlbumUserRole, AssetType, AssetVisibility, Permission, SharedLinkType } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumContainerRepository } from 'src/repositories/album-container.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LockRepository } from 'src/repositories/lock.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { SharedLinkAssetRepository } from 'src/repositories/shared-link-asset.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { DB } from 'src/schema/index.js';
import { SharedLinkService } from 'src/services/shared-link.service.js';
import { checkAccess } from 'src/utils/access.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(SharedLinkService, {
    database: db || defaultDatabase,
    real: [
      AccessRepository,
      AlbumRepository,
      CryptoRepository,
      DatabaseRepository,
      LockRepository,
      PartnerRepository,
      SharedLinkRepository,
      SharedLinkAssetRepository,
    ],
    mock: [LoggingRepository, StorageRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

const ALBUM_READ_ERROR = 'Not found or no album.read access';
// Ruling R32: hidden content fails exactly like missing content on every link-management path
const LINK_NOT_FOUND = 'Shared link not found';
const ASSET_SHARE_ERROR = 'Not found or no asset.share access';

type Ctx = ReturnType<typeof setup>['ctx'];

const newLinkAsset = async (ctx: Ctx, ownerId: string, dto: { isFavorite?: boolean } = {}) => {
  const { asset } = await ctx.newAsset({ ownerId, ...dto });
  await ctx.newExif({ assetId: asset.id, make: 'Canon' });
  return asset;
};

const newLink = async (ctx: Ctx, userId: string, dto: { albumId?: string; assetIds?: string[] }) => {
  const link = await ctx.get(SharedLinkRepository).create({
    key: randomBytes(16),
    id: factory.uuid(),
    userId,
    allowUpload: false,
    allowDownload: false,
    showExif: false,
    type: dto.albumId ? SharedLinkType.Album : SharedLinkType.Individual,
    albumId: dto.albumId ?? null,
    assetIds: dto.assetIds,
  });
  return { id: link.id, key: link.key.toString('base64url'), albumId: link.albumId };
};

type Link = { id: string; key: string; albumId: string | null };

const idsOf = (links: { id: string }[]) => links.map(({ id }) => id).sort();

/** The AuthSharedLink a public visitor holding the link's key authenticates as. */
const asVisitor = async (ctx: Ctx, userId: string, link: Link) => {
  const sharedLink = await ctx.get(SharedLinkRepository).get(userId, link.id);
  return { user: { id: userId }, sharedLink } as unknown as AuthDto;
};

/** A thrown error reduced to what a client can observe (ruling R32 compares these). */
const errorOf = (promise: Promise<unknown>) =>
  promise
    .then(() => ({ resolved: true }))
    .catch((error: any) => ({
      type: error?.constructor?.name,
      message: error?.message,
      status: error?.getStatus?.(),
      response: error?.getResponse?.(),
    }));

/** Per-asset results without their ids. */
const strip = (results: { assetId: string }[]) => results.map(({ assetId: _, ...rest }) => rest);

const getLinkRow = (ctx: Ctx, id: string) =>
  ctx.database
    .selectFrom('shared_link')
    .select(['password', 'expiresAt', 'allowDownload', 'showExif'])
    .where('id', '=', id)
    .executeTakeFirst();

/**
 * The manager's own content, every hidden case hidden ONLY by the manager's own locks. All links are minted while
 * everything is still visible; the locks land afterwards.
 */
const setupOwnLocks = async (ctx: Ctx, sut: SharedLinkService) => {
  const { user } = await ctx.newUser();
  const plain = factory.auth({ user });
  const locks = ctx.get(LockRepository);
  const folders = ctx.get(AlbumContainerRepository);

  const visibleAsset = await newLinkAsset(ctx, user.id);
  const { album: visibleAlbum } = await ctx.newAlbum({ ownerId: user.id }, [visibleAsset.id]);

  // hiddenA lives only in a regular album; hiddenB is matched only by a smart album (both locked below)
  const hiddenA = await newLinkAsset(ctx, user.id);
  const hiddenB = await newLinkAsset(ctx, user.id, { isFavorite: true });
  const { album: regular } = await ctx.newAlbum({ ownerId: user.id }, [hiddenA.id]);
  const { album: smart } = await ctx.newAlbum({
    ownerId: user.id,
    kind: AlbumKind.Smart,
    filter: { isFavorite: true },
  });
  const folder = await folders.create({ ownerId: user.id, name: 'Locked folder', parentId: null });
  const { album: inFolder } = await ctx.newAlbum({ ownerId: user.id, containerId: folder.id });
  const ancestor = await folders.create({ ownerId: user.id, name: 'Locked ancestor', parentId: null });
  const child = await folders.create({ ownerId: user.id, name: 'Child', parentId: ancestor.id });
  const { album: underAncestor } = await ctx.newAlbum({ ownerId: user.id, containerId: child.id });

  const links = {
    visibleAlbum: await newLink(ctx, user.id, { albumId: visibleAlbum.id }),
    visibleIndividual: await newLink(ctx, user.id, { assetIds: [visibleAsset.id] }),
    regular: await newLink(ctx, user.id, { albumId: regular.id }),
    smart: await newLink(ctx, user.id, { albumId: smart.id }),
    inFolder: await newLink(ctx, user.id, { albumId: inFolder.id }),
    underAncestor: await newLink(ctx, user.id, { albumId: underAncestor.id }),
    allHidden: await newLink(ctx, user.id, { assetIds: [hiddenA.id, hiddenB.id] }),
    // minted through the service while its assets were still visible
    mixed: await sut
      .create(plain, {
        type: SharedLinkType.Individual,
        assetIds: [visibleAsset.id, hiddenA.id],
        allowDownload: false,
        showMetadata: false,
      })
      .then(({ id, key }) => ({ id, key, albumId: null })),
  };

  await locks.lockAlbum(user.id, regular.id);
  await locks.lockAlbum(user.id, smart.id);
  await locks.lockContainer(user.id, folder.id);
  await locks.lockContainer(user.id, ancestor.id);

  const hiddenAlbumLinks = [links.regular, links.smart, links.inFolder, links.underAncestor];
  const hiddenIndividualLinks = [links.allHidden, links.mixed];
  return {
    user,
    plain,
    elevated: factory.auth({ user, session: { hasElevatedPermission: true } }),
    assets: { visibleAsset, hiddenA, hiddenB },
    albums: { visibleAlbum, regular, smart, inFolder, underAncestor },
    folders: { folder, ancestor },
    links,
    visibleLinks: [links.visibleAlbum, links.visibleIndividual],
    hiddenAlbumLinks,
    hiddenIndividualLinks,
    hiddenLinks: [...hiddenAlbumLinks, ...hiddenIndividualLinks],
  };
};

/** Partner A shares their library with manager B; X is A's photo, visible when B mints a link containing it. */
const setupPartnerLink = async (ctx: Ctx, sut: SharedLinkService) => {
  const { user: partnerA } = await ctx.newUser();
  const { user: managerB } = await ctx.newUser();
  await ctx.newPartner({ sharedById: partnerA.id, sharedWithId: managerB.id });

  const photoX = await newLinkAsset(ctx, partnerA.id);
  const ownAsset = await newLinkAsset(ctx, managerB.id);
  const plain = factory.auth({ user: managerB });
  const elevated = factory.auth({ user: managerB, session: { hasElevatedPermission: true } });

  const link = await sut.create(plain, {
    type: SharedLinkType.Individual,
    assetIds: [photoX.id],
    allowDownload: false,
    showMetadata: false,
  });
  const mixedLink = await sut.create(plain, {
    type: SharedLinkType.Individual,
    assetIds: [photoX.id, ownAsset.id],
    allowDownload: false,
    showMetadata: false,
  });
  return { partnerA, managerB, photoX, ownAsset, plain, elevated, link, mixedLink };
};

describe(SharedLinkService.name, () => {
  describe('get', () => {
    it('should return the correct dates on the shared link album', async () => {
      const { sut, ctx } = setup();

      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { album } = await ctx.newAlbum({ ownerId: user.id });

      const dates = ['2021-01-01T00:00:00.000Z', '2022-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'];

      for (const date of dates) {
        const { asset } = await ctx.newAsset({ fileCreatedAt: date, localDateTime: date, ownerId: user.id });
        await ctx.newExif({ assetId: asset.id, make: 'Canon' });
        await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });
      }

      const sharedLinkRepo = ctx.get(SharedLinkRepository);

      const sharedLink = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        albumId: album.id,
        allowUpload: true,
        type: SharedLinkType.Album,
      });

      await expect(sut.get(auth, sharedLink.id)).resolves.toMatchObject({
        album: expect.objectContaining({
          startDate: '2020-01-01T00:00:00+00:00',
          endDate: '2022-01-01T00:00:00+00:00',
        }),
      });
    });
  });

  it('should share individually assets', async () => {
    const { sut, ctx } = setup();

    const { user } = await ctx.newUser();

    const assets = await Promise.all([
      ctx.newAsset({ ownerId: user.id }),
      ctx.newAsset({ ownerId: user.id }),
      ctx.newAsset({ ownerId: user.id }),
    ]);

    for (const { asset } of assets) {
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });
    }

    const sharedLinkRepo = ctx.get(SharedLinkRepository);

    const sharedLink = await sharedLinkRepo.create({
      key: randomBytes(16),
      id: factory.uuid(),
      userId: user.id,
      allowUpload: false,
      type: SharedLinkType.Individual,
      assetIds: assets.map(({ asset }) => asset.id),
    });

    await expect(sut.getMine({ user, sharedLink }, [])).resolves.toMatchObject({
      assets: assets.map(({ asset }) => expect.objectContaining({ id: asset.id })),
    });
  });

  describe('getAll', () => {
    it('should return all shared links even when they share the same createdAt', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      const sharedLinkRepo = ctx.get(SharedLinkRepository);
      const sameTimestamp = '2024-01-01T00:00:00.000Z';

      const link1 = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        allowUpload: false,
        type: SharedLinkType.Individual,
        createdAt: sameTimestamp,
      });

      const link2 = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        allowUpload: false,
        type: SharedLinkType.Individual,
        createdAt: sameTimestamp,
      });

      const result = await sut.getAll(auth, {});
      expect(result).toHaveLength(2);
      const ids = result.map((r) => r.id);
      expect(ids).toContain(link1.id);
      expect(ids).toContain(link2.id);
    });

    it('should return shared links sorted by createdAt in descending order', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      const sharedLinkRepo = ctx.get(SharedLinkRepository);

      const link1 = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        allowUpload: false,
        type: SharedLinkType.Individual,
        createdAt: '2021-01-01T00:00:00.000Z',
      });

      const link2 = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        allowUpload: false,
        type: SharedLinkType.Individual,
        createdAt: '2023-01-01T00:00:00.000Z',
      });

      const link3 = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        allowUpload: false,
        type: SharedLinkType.Individual,
        createdAt: '2022-01-01T00:00:00.000Z',
      });

      const result = await sut.getAll(auth, {});
      expect(result).toHaveLength(3);
      expect(result.map((r) => r.id)).toEqual([link2.id, link3.id, link1.id]);
    });

    it('should not return shared links belonging to other users', async () => {
      const { sut, ctx } = setup();

      const { user: userA } = await ctx.newUser();
      const { user: userB } = await ctx.newUser();
      const authA = factory.auth({ user: userA });
      const authB = factory.auth({ user: userB });

      const sharedLinkRepo = ctx.get(SharedLinkRepository);

      const linkA = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: userA.id,
        allowUpload: false,
        type: SharedLinkType.Individual,
      });

      await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: userB.id,
        allowUpload: false,
        type: SharedLinkType.Individual,
      });

      const resultA = await sut.getAll(authA, {});
      expect(resultA).toHaveLength(1);
      expect(resultA[0].id).toBe(linkA.id);

      const resultB = await sut.getAll(authB, {});
      expect(resultB).toHaveLength(1);
      expect(resultB[0].id).not.toBe(linkA.id);
    });

    it('should filter by albumId', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      const { album: album1 } = await ctx.newAlbum({ ownerId: user.id });
      const { album: album2 } = await ctx.newAlbum({ ownerId: user.id });

      const sharedLinkRepo = ctx.get(SharedLinkRepository);

      const link1 = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        albumId: album1.id,
        allowUpload: false,
        type: SharedLinkType.Album,
      });

      await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        albumId: album2.id,
        allowUpload: false,
        type: SharedLinkType.Album,
      });

      const result = await sut.getAll(auth, { albumId: album1.id });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(link1.id);
    });

    it('should return album shared links with album data and (only) the owner', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: albumContributor } = await ctx.newUser();
      const auth = factory.auth({ user });

      const { album } = await ctx.newAlbum({ ownerId: user.id });
      await ctx.newAlbumUser({ albumId: album.id, userId: albumContributor.id, role: AlbumUserRole.Editor });

      const sharedLinkRepo = ctx.get(SharedLinkRepository);

      await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        albumId: album.id,
        allowUpload: false,
        type: SharedLinkType.Album,
      });

      const result = await sut.getAll(auth, {});
      expect(result).toHaveLength(1);
      expect(result[0].album).toBeDefined();
      expect(result[0].album!.id).toBe(album.id);
      expect(result[0].album!.albumUsers.length).toBe(1);
      expect(result[0].album!.albumUsers[0].role).toBe(AlbumUserRole.Owner);
      expect(result[0].album!.albumUsers[0].user.id).toBe(user.id);
    });

    it('should return multiple album shared links without sql error from json group by', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      const { album: album1 } = await ctx.newAlbum({ ownerId: user.id });
      const { album: album2 } = await ctx.newAlbum({ ownerId: user.id });

      const sharedLinkRepo = ctx.get(SharedLinkRepository);

      const link1 = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        albumId: album1.id,
        allowUpload: false,
        type: SharedLinkType.Album,
      });

      const link2 = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        albumId: album2.id,
        allowUpload: false,
        type: SharedLinkType.Album,
      });

      const result = await sut.getAll(auth, {});
      expect(result).toHaveLength(2);
      const ids = result.map((r) => r.id);
      expect(ids).toContain(link1.id);
      expect(ids).toContain(link2.id);
      expect(result[0].album).toBeDefined();
      expect(result[1].album).toBeDefined();
    });

    it('should return mixed album and individual shared links together', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      const { album } = await ctx.newAlbum({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      const sharedLinkRepo = ctx.get(SharedLinkRepository);

      const albumLink = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        albumId: album.id,
        allowUpload: false,
        type: SharedLinkType.Album,
      });

      const albumLink2 = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        albumId: album.id,
        allowUpload: false,
        type: SharedLinkType.Album,
      });

      const individualLink = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        allowUpload: false,
        type: SharedLinkType.Individual,
        assetIds: [asset.id],
      });

      const result = await sut.getAll(auth, {});
      expect(result).toHaveLength(3);
      const ids = result.map((r) => r.id);
      expect(ids).toContain(albumLink.id);
      expect(ids).toContain(albumLink2.id);
      expect(ids).toContain(individualLink.id);
    });

    it('should return only the first asset as cover for an individual shared link', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      const assets = await Promise.all([
        ctx.newAsset({ ownerId: user.id, fileCreatedAt: '2021-01-01T00:00:00.000Z' }),
        ctx.newAsset({ ownerId: user.id, fileCreatedAt: '2023-01-01T00:00:00.000Z' }),
        ctx.newAsset({ ownerId: user.id, fileCreatedAt: '2022-01-01T00:00:00.000Z' }),
      ]);

      const sharedLinkRepo = ctx.get(SharedLinkRepository);

      await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        allowUpload: false,
        type: SharedLinkType.Individual,
        assetIds: assets.map(({ asset }) => asset.id),
      });

      const result = await sut.getAll(auth, {});
      expect(result).toHaveLength(1);
      expect(result[0].assets).toHaveLength(1);
      expect(result[0].assets[0].id).toBe(assets[0].asset.id);
    });
  });

  describe('get', () => {
    it('should return an album shared link with assets', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { album } = await ctx.newAlbum({ ownerId: user.id });

      const [{ asset: asset1 }, { asset: asset2 }] = await Promise.all([
        ctx.newAsset({ ownerId: user.id }),
        ctx.newAsset({ ownerId: user.id }),
      ]);
      await Promise.all([
        ctx.newExif({ assetId: asset1.id, make: 'Canon' }),
        ctx.newExif({ assetId: asset2.id, make: 'Canon' }),
      ]);

      const sharedLinkRepo = ctx.get(SharedLinkRepository);
      const sharedLink = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        albumId: album.id,
        allowUpload: true,
        type: SharedLinkType.Album,
      });

      await sharedLinkRepo.addAssets(sharedLink.id, [asset1.id, asset2.id]);
      const result = await sut.get(auth, sharedLink.id);
      const assetIds = result.assets.map((asset) => asset.id);

      expect(result).toMatchObject({
        id: sharedLink.id,
        album: expect.objectContaining({ id: album.id }),
      });
      expect(assetIds).toHaveLength(2);
      expect(assetIds).toEqual(expect.arrayContaining([asset1.id, asset2.id]));
    });

    it('should not return trashed assets for an individual shared link', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      const { asset: visibleAsset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: visibleAsset.id, make: 'Canon' });

      const { asset: trashedAsset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: trashedAsset.id, make: 'Canon' });
      await ctx.softDeleteAsset(trashedAsset.id);

      const sharedLinkRepo = ctx.get(SharedLinkRepository);
      const sharedLink = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        allowUpload: false,
        type: SharedLinkType.Individual,
        assetIds: [visibleAsset.id, trashedAsset.id],
      });

      const result = await sut.get(auth, sharedLink.id);
      expect(result).toBeDefined();
      expect(result!.assets).toHaveLength(1);
      expect(result!.assets[0].id).toBe(visibleAsset.id);
    });

    it('should return empty assets when all individually shared assets are trashed', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      await ctx.softDeleteAsset(asset.id);

      const sharedLinkRepo = ctx.get(SharedLinkRepository);
      const sharedLink = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        allowUpload: false,
        type: SharedLinkType.Individual,
        assetIds: [asset.id],
      });

      await expect(sut.get(auth, sharedLink.id)).resolves.toMatchObject({
        assets: [],
      });
    });

    it('should not return trashed assets in a shared album', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { album } = await ctx.newAlbum({ ownerId: user.id });

      const { asset: visibleAsset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: visibleAsset.id, make: 'Canon' });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: visibleAsset.id });

      const { asset: trashedAsset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: trashedAsset.id, make: 'Canon' });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: trashedAsset.id });
      await ctx.softDeleteAsset(trashedAsset.id);

      const sharedLinkRepo = ctx.get(SharedLinkRepository);
      const sharedLink = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        albumId: album.id,
        allowUpload: true,
        type: SharedLinkType.Album,
      });

      await expect(sut.get(auth, sharedLink.id)).resolves.toMatchObject({
        album: expect.objectContaining({ assetCount: 1 }),
      });
    });

    it('should return an empty asset count when all album assets are trashed', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { album } = await ctx.newAlbum({ ownerId: user.id });

      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });
      await ctx.softDeleteAsset(asset.id);

      const sharedLinkRepo = ctx.get(SharedLinkRepository);
      const sharedLink = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        albumId: album.id,
        allowUpload: false,
        type: SharedLinkType.Album,
      });

      await expect(sut.get(auth, sharedLink.id)).resolves.toMatchObject({
        album: expect.objectContaining({ assetCount: 0 }),
      });
    });

    it('should not return an album shared link when the album is trashed', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { album } = await ctx.newAlbum({ ownerId: user.id });

      const sharedLinkRepo = ctx.get(SharedLinkRepository);
      const sharedLink = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        albumId: album.id,
        allowUpload: false,
        type: SharedLinkType.Album,
      });

      await ctx.softDeleteAlbum(album.id);

      await expect(sut.get(auth, sharedLink.id)).rejects.toThrow('Shared link not found');
    });
  });

  describe('getAll', () => {
    it('should not return trashed assets as cover for an individual shared link', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      const { asset: trashedAsset } = await ctx.newAsset({
        ownerId: user.id,
        fileCreatedAt: '2020-01-01T00:00:00.000Z',
      });
      await ctx.softDeleteAsset(trashedAsset.id);

      const { asset: visibleAsset } = await ctx.newAsset({
        ownerId: user.id,
        fileCreatedAt: '2021-01-01T00:00:00.000Z',
      });

      const sharedLinkRepo = ctx.get(SharedLinkRepository);
      await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        allowUpload: false,
        type: SharedLinkType.Individual,
        assetIds: [trashedAsset.id, visibleAsset.id],
      });

      const result = await sut.getAll(auth, {});
      expect(result).toHaveLength(1);
      expect(result[0].assets).toHaveLength(1);
      expect(result[0].assets[0].id).toBe(visibleAsset.id);
    });

    it('should not return an album shared link when the album is trashed', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { album } = await ctx.newAlbum({ ownerId: user.id });

      const sharedLinkRepo = ctx.get(SharedLinkRepository);
      await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        albumId: album.id,
        allowUpload: false,
        type: SharedLinkType.Album,
      });

      await ctx.softDeleteAlbum(album.id);

      const result = await sut.getAll(auth, {});
      expect(result).toHaveLength(0);
    });
  });

  it('should remove individually shared asset', async () => {
    const { sut, ctx } = setup();

    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    await ctx.newExif({ assetId: asset.id, make: 'Canon' });

    const sharedLinkRepo = ctx.get(SharedLinkRepository);

    const sharedLink = await sharedLinkRepo.create({
      key: randomBytes(16),
      id: factory.uuid(),
      userId: user.id,
      allowUpload: false,
      type: SharedLinkType.Individual,
      assetIds: [asset.id],
    });

    await expect(sut.getMine({ user, sharedLink }, [])).resolves.toMatchObject({
      assets: [expect.objectContaining({ id: asset.id })],
    });

    await sut.removeAssets(auth, sharedLink.id, {
      assetIds: [asset.id],
    });

    await expect(sut.getMine({ user, sharedLink }, [])).resolves.toHaveProperty('assets', []);
  });
  describe("fork locks: link management respects the manager's locks (7A.1)", () => {
    it('non-elevated getAll omits hidden links and never returns their keys', async () => {
      const { sut, ctx } = setup();
      const fixture = await setupOwnLocks(ctx, sut);
      const { plain, visibleLinks, hiddenLinks, hiddenAlbumLinks } = fixture;

      const revealing = {
        ...plain,
        revealedLocks: {
          albumIds: [fixture.albums.regular.id, fixture.albums.smart.id],
          containerIds: [fixture.folders.folder.id, fixture.folders.ancestor.id],
        },
      } as AuthDto;
      // reveal headers are ignored outside an elevated session
      for (const auth of [plain, revealing]) {
        const result = await sut.getAll(auth, {});
        expect(idsOf(result)).toEqual(idsOf(visibleLinks));
        const serialized = JSON.stringify(result);
        for (const link of hiddenLinks) {
          expect(serialized).not.toContain(link.key);
          expect(serialized).not.toContain(link.id);
        }

        // narrowing by id or album does not leak them either
        for (const link of hiddenLinks) {
          await expect(sut.getAll(auth, { id: link.id })).resolves.toEqual([]);
        }
        for (const link of hiddenAlbumLinks) {
          await expect(sut.getAll(auth, { albumId: link.albumId! })).resolves.toEqual([]);
        }
      }
    });

    it('non-elevated cannot get, edit (password/expiry/allowDownload/showExif) or delete a hidden link', async () => {
      const { sut, ctx } = setup();
      const { plain, hiddenLinks, hiddenIndividualLinks, visibleLinks, assets } = await setupOwnLocks(ctx, sut);

      const edits = [
        { password: 'secret' },
        { expiresAt: new Date('2099-01-01T00:00:00.000Z') },
        { allowDownload: true },
        { showMetadata: true },
      ];
      for (const link of hiddenLinks) {
        await expect(sut.get(plain, link.id)).rejects.toThrow(LINK_NOT_FOUND);
        for (const dto of edits) {
          await expect(sut.update(plain, link.id, dto)).rejects.toThrow(LINK_NOT_FOUND);
        }
        await expect(sut.remove(plain, link.id)).rejects.toThrow(LINK_NOT_FOUND);
        await expect(getLinkRow(ctx, link.id)).resolves.toEqual({
          password: null,
          expiresAt: null,
          allowDownload: false,
          showExif: false,
        });
      }
      for (const link of hiddenIndividualLinks) {
        await expect(sut.addAssets(plain, link.id, { assetIds: [assets.visibleAsset.id] })).rejects.toThrow(
          LINK_NOT_FOUND,
        );
        await expect(sut.removeAssets(plain, link.id, { assetIds: [assets.hiddenA.id] })).rejects.toThrow(
          LINK_NOT_FOUND,
        );
      }
      await expect(
        ctx.database
          .selectFrom('shared_link_asset')
          .select('assetId')
          .where('sharedLinkId', '=', hiddenIndividualLinks[1].id)
          .execute(),
      ).resolves.toHaveLength(2);

      // visible links stay fully manageable
      for (const link of visibleLinks) {
        await expect(sut.get(plain, link.id)).resolves.toEqual(expect.objectContaining({ id: link.id }));
        await expect(sut.update(plain, link.id, { allowDownload: true })).resolves.toEqual(
          expect.objectContaining({ allowDownload: true }),
        );
      }
    });

    it('non-elevated cannot mint an album or individual link to hidden content, or addAssets hidden assets', async () => {
      const { sut, ctx } = setup();
      const { user, plain, albums, assets, links } = await setupOwnLocks(ctx, sut);
      const countLinks = () =>
        ctx.database.selectFrom('shared_link').select('id').where('userId', '=', user.id).execute();
      const before = await countLinks();

      for (const album of [albums.regular, albums.smart, albums.inFolder, albums.underAncestor]) {
        await expect(sut.create(plain, { type: SharedLinkType.Album, albumId: album.id })).rejects.toThrow(
          ALBUM_READ_ERROR,
        );
      }
      // all hidden, and mixed visible + hidden
      for (const assetIds of [
        [assets.hiddenA.id, assets.hiddenB.id],
        [assets.visibleAsset.id, assets.hiddenA.id],
        [assets.hiddenB.id],
      ]) {
        await expect(sut.create(plain, { type: SharedLinkType.Individual, assetIds })).rejects.toThrow(
          ASSET_SHARE_ERROR,
        );
      }
      // a hidden asset is reported exactly like a missing one, and not added
      await expect(
        sut.addAssets(plain, links.visibleIndividual.id, { assetIds: [assets.hiddenA.id, assets.visibleAsset.id] }),
      ).resolves.toEqual([
        { assetId: assets.hiddenA.id, success: false, error: AssetIdErrorReason.NO_PERMISSION },
        { assetId: assets.visibleAsset.id, success: false, error: AssetIdErrorReason.DUPLICATE },
      ]);
      await expect(sut.get(plain, links.visibleIndividual.id)).resolves.toEqual(
        expect.objectContaining({ assets: [expect.objectContaining({ id: assets.visibleAsset.id })] }),
      );
      await expect(countLinks()).resolves.toHaveLength(before.length);

      // visible content can still be shared
      await expect(sut.create(plain, { type: SharedLinkType.Album, albumId: albums.visibleAlbum.id })).resolves.toEqual(
        expect.objectContaining({ type: SharedLinkType.Album }),
      );
      await expect(
        sut.create(plain, { type: SharedLinkType.Individual, assetIds: [assets.visibleAsset.id] }),
      ).resolves.toEqual(expect.objectContaining({ type: SharedLinkType.Individual }));
    });

    it("elevated direct-by-id management is allowed when only the manager's own locks hide the content", async () => {
      const { sut, ctx } = setup();
      const { elevated, hiddenLinks, links, albums, assets } = await setupOwnLocks(ctx, sut);

      for (const link of hiddenLinks) {
        await expect(sut.get(elevated, link.id)).resolves.toEqual(
          expect.objectContaining({ id: link.id, key: link.key }),
        );
        await expect(
          sut.update(elevated, link.id, {
            password: 'secret',
            expiresAt: new Date('2099-01-01T00:00:00.000Z'),
            allowDownload: true,
            showMetadata: true,
          }),
        ).resolves.toEqual(expect.objectContaining({ id: link.id, allowDownload: true, showMetadata: true }));
      }
      await expect(sut.addAssets(elevated, links.mixed.id, { assetIds: [assets.hiddenB.id] })).resolves.toEqual([
        { assetId: assets.hiddenB.id, success: true },
      ]);
      await expect(sut.removeAssets(elevated, links.mixed.id, { assetIds: [assets.hiddenB.id] })).resolves.toEqual([
        { assetId: assets.hiddenB.id, success: true },
      ]);

      for (const album of [albums.regular, albums.smart, albums.inFolder, albums.underAncestor]) {
        await expect(sut.create(elevated, { type: SharedLinkType.Album, albumId: album.id })).resolves.toEqual(
          expect.objectContaining({ type: SharedLinkType.Album }),
        );
      }
      await expect(
        sut.create(elevated, {
          type: SharedLinkType.Individual,
          assetIds: [assets.hiddenA.id, assets.hiddenB.id, assets.visibleAsset.id],
        }),
      ).resolves.toEqual(expect.objectContaining({ type: SharedLinkType.Individual }));

      for (const link of hiddenLinks) {
        await expect(sut.remove(elevated, link.id)).resolves.toBeUndefined();
        await expect(getLinkRow(ctx, link.id)).resolves.toBeUndefined();
      }
    });

    it("elevated manager cannot retrieve or reactivate a link exposing a partner's later-locked photo", async () => {
      const { sut, ctx } = setup();
      const { partnerA, photoX, ownAsset, plain, elevated, link, mixedLink } = await setupPartnerLink(ctx, sut);

      // A files X into an album of their own and locks it - A's locks hide A's content (spec §4)
      const { album } = await ctx.newAlbum({ ownerId: partnerA.id }, [photoX.id]);
      await ctx.get(LockRepository).lockAlbum(partnerA.id, album.id);

      // B's reveal set cannot reveal A's locks
      const revealing = { ...elevated, revealedLocks: { albumIds: [album.id], containerIds: [] } } as AuthDto;
      for (const auth of [plain, elevated, revealing]) {
        const all = await sut.getAll(auth, {});
        expect(idsOf(all)).toEqual([]);
        expect(JSON.stringify(all)).not.toContain(link.key);
        expect(JSON.stringify(all)).not.toContain(mixedLink.key);
        await expect(sut.getAll(auth, { id: link.id })).resolves.toEqual([]);

        for (const id of [link.id, mixedLink.id]) {
          await expect(sut.get(auth, id)).rejects.toThrow(LINK_NOT_FOUND);
          for (const dto of [
            { expiresAt: new Date('2099-01-01T00:00:00.000Z') },
            { password: 'secret' },
            { allowDownload: true },
          ]) {
            await expect(sut.update(auth, id, dto)).rejects.toThrow(LINK_NOT_FOUND);
          }
          // addAssets cannot probe the link: same answer for a new asset, a present one, or one it already holds
          for (const assetIds of [[ownAsset.id], [photoX.id]]) {
            await expect(sut.addAssets(auth, id, { assetIds })).rejects.toThrow(LINK_NOT_FOUND);
          }
          await expect(getLinkRow(ctx, id)).resolves.toEqual({
            password: null,
            expiresAt: null,
            allowDownload: false,
            showExif: false,
          });
        }

        // nor can B mint a fresh link to X
        await expect(sut.create(auth, { type: SharedLinkType.Individual, assetIds: [photoX.id] })).rejects.toThrow(
          ASSET_SHARE_ERROR,
        );
      }
    });

    it('the same link is manageable when B has another legitimate grant to X', async () => {
      const { sut, ctx } = setup();
      const { partnerA, managerB, photoX, plain, elevated, link } = await setupPartnerLink(ctx, sut);

      // X is also in an album A shares with B; A then locks that album (and so hides X under A's locks), but the
      // album owner's locks do not bind the sharee (spec §4): B's album grant to X stands
      const { album: shared } = await ctx.newAlbum({ ownerId: partnerA.id }, [photoX.id]);
      await ctx.newAlbumUser({ albumId: shared.id, userId: managerB.id, role: AlbumUserRole.Viewer });
      await ctx.get(LockRepository).lockAlbum(partnerA.id, shared.id);

      for (const auth of [plain, elevated]) {
        await expect(sut.getAll(auth, {})).resolves.toEqual(
          expect.arrayContaining([expect.objectContaining({ id: link.id, key: link.key })]),
        );
        await expect(sut.get(auth, link.id)).resolves.toEqual(expect.objectContaining({ id: link.id }));
        await expect(sut.update(auth, link.id, { allowDownload: true })).resolves.toEqual(
          expect.objectContaining({ allowDownload: true }),
        );
      }

      // B's OWN lock on the rescuing album withholds that grant (spec §15.1): elevation bypasses it for direct-by-id
      // management, and the list shows the link only when the album is revealed (spec §15.3)
      await ctx.get(LockRepository).lockAlbum(managerB.id, shared.id);
      expect(idsOf(await sut.getAll(plain, {}))).not.toContain(link.id);
      await expect(sut.get(plain, link.id)).rejects.toThrow(LINK_NOT_FOUND);
      await expect(sut.get(elevated, link.id)).resolves.toEqual(expect.objectContaining({ id: link.id }));
      expect(idsOf(await sut.getAll(elevated, {}))).not.toContain(link.id);
      const revealing = { ...elevated, revealedLocks: { albumIds: [shared.id], containerIds: [] } } as AuthDto;
      expect(idsOf(await sut.getAll(revealing, {}))).toContain(link.id);
    });

    it("link owner can revoke a link hidden only by a partner's lock, elevated or not", async () => {
      const { sut, ctx } = setup();
      const { partnerA, photoX, plain, elevated, link, mixedLink } = await setupPartnerLink(ctx, sut);
      const { album } = await ctx.newAlbum({ ownerId: partnerA.id }, [photoX.id]);
      await ctx.get(LockRepository).lockAlbum(partnerA.id, album.id);

      // still hidden for B on every other path ...
      await expect(sut.get(plain, link.id)).rejects.toThrow(LINK_NOT_FOUND);
      await expect(sut.get(elevated, mixedLink.id)).rejects.toThrow(LINK_NOT_FOUND);
      // ... but revoking returns and reveals nothing and ends the public exposure (ruling R30)
      await expect(sut.remove(plain, link.id)).resolves.toBeUndefined();
      await expect(getLinkRow(ctx, link.id)).resolves.toBeUndefined();
      await expect(sut.remove(elevated, mixedLink.id)).resolves.toBeUndefined();
      await expect(getLinkRow(ctx, mixedLink.id)).resolves.toBeUndefined();
    });

    it("link owner can revoke a link hidden by a former partner's lock", async () => {
      const { sut, ctx } = setup();
      const { partnerA, managerB, photoX, plain, link } = await setupPartnerLink(ctx, sut);
      const { album } = await ctx.newAlbum({ ownerId: partnerA.id }, [photoX.id]);
      await ctx.get(LockRepository).lockAlbum(partnerA.id, album.id);
      await ctx.get(PartnerRepository).remove({ sharedById: partnerA.id, sharedWithId: managerB.id });

      // X is now a stranger's asset, still judged by its owner's locks: the link stays hidden ...
      await expect(sut.getAll(plain, {}).then(idsOf)).resolves.toEqual([]);
      await expect(sut.get(plain, link.id)).rejects.toThrow(LINK_NOT_FOUND);
      // ... and stays revocable
      await expect(sut.remove(plain, link.id)).resolves.toBeUndefined();
      await expect(getLinkRow(ctx, link.id)).resolves.toBeUndefined();
    });

    it("revoking a link hidden by the manager's own lock requires elevation", async () => {
      const { sut, ctx } = setup();
      const { plain, elevated, hiddenLinks, albums, folders } = await setupOwnLocks(ctx, sut);
      const revealingUnelevated = {
        ...plain,
        revealedLocks: {
          albumIds: [albums.regular.id, albums.smart.id],
          containerIds: [folders.folder.id, folders.ancestor.id],
        },
      } as AuthDto;

      for (const link of hiddenLinks) {
        for (const auth of [plain, revealingUnelevated]) {
          await expect(sut.remove(auth, link.id)).rejects.toThrow(LINK_NOT_FOUND);
        }
        await expect(getLinkRow(ctx, link.id)).resolves.toBeDefined();
        await expect(sut.remove(elevated, link.id)).resolves.toBeUndefined();
        await expect(getLinkRow(ctx, link.id)).resolves.toBeUndefined();
      }

      // hidden by the manager's own lock AND a partner's: the own lock still requires elevation
      const partner = await setupPartnerLink(ctx, sut);
      const { album: partnerAlbum } = await ctx.newAlbum({ ownerId: partner.partnerA.id }, [partner.photoX.id]);
      await ctx.get(LockRepository).lockAlbum(partner.partnerA.id, partnerAlbum.id);
      const { album: ownAlbum } = await ctx.newAlbum({ ownerId: partner.managerB.id }, [partner.ownAsset.id]);
      await ctx.get(LockRepository).lockAlbum(partner.managerB.id, ownAlbum.id);
      await expect(sut.remove(partner.plain, partner.mixedLink.id)).rejects.toThrow(LINK_NOT_FOUND);
      await expect(getLinkRow(ctx, partner.mixedLink.id)).resolves.toBeDefined();
      await expect(sut.remove(partner.elevated, partner.mixedLink.id)).resolves.toBeUndefined();
    });

    it('a hidden id and a non-existent id produce identical errors on each path', async () => {
      const { sut, ctx } = setup();
      const { plain, links, assets, hiddenLinks, hiddenIndividualLinks } = await setupOwnLocks(ctx, sut);
      const missingId = factory.uuid();
      const same = async (call: (id: string) => Promise<unknown>, hiddenId: string) => {
        const hidden = await errorOf(call(hiddenId));
        expect(hidden).not.toEqual({ resolved: true });
        expect(hidden).toEqual(await errorOf(call(missingId)));
      };

      // existing links: hidden by the manager's own locks, non-elevated
      for (const link of hiddenLinks) {
        await same((id) => sut.get(plain, id), link.id);
        await same((id) => sut.update(plain, id, { allowDownload: true }), link.id);
        await same((id) => sut.remove(plain, id), link.id);
      }
      for (const link of hiddenIndividualLinks) {
        await same((id) => sut.addAssets(plain, id, { assetIds: [assets.visibleAsset.id] }), link.id);
        await same((id) => sut.removeAssets(plain, id, { assetIds: [assets.hiddenA.id] }), link.id);
      }

      // minting a link: a hidden asset fails exactly like a non-existent one
      await same((id) => sut.create(plain, { type: SharedLinkType.Individual, assetIds: [id] }), assets.hiddenA.id);
      await same(
        (id) => sut.create(plain, { type: SharedLinkType.Individual, assetIds: [assets.visibleAsset.id, id] }),
        assets.hiddenA.id,
      );

      // addAssets: the per-asset result does not distinguish hidden from missing, and nothing is added
      const hiddenResult = await sut.addAssets(plain, links.visibleIndividual.id, { assetIds: [assets.hiddenA.id] });
      const missingResult = await sut.addAssets(plain, links.visibleIndividual.id, { assetIds: [missingId] });
      expect(strip(hiddenResult)).toEqual(strip(missingResult));
      expect(hiddenResult).toEqual([
        { assetId: assets.hiddenA.id, success: false, error: AssetIdErrorReason.NO_PERMISSION },
      ]);
      await expect(
        ctx.database
          .selectFrom('shared_link_asset')
          .select('assetId')
          .where('sharedLinkId', '=', links.visibleIndividual.id)
          .execute(),
      ).resolves.toEqual([{ assetId: assets.visibleAsset.id }]);

      // and for a partner's later-locked photo, in an elevated session
      const partner = await setupPartnerLink(ctx, sut);
      const { album } = await ctx.newAlbum({ ownerId: partner.partnerA.id }, [partner.photoX.id]);
      await ctx.get(LockRepository).lockAlbum(partner.partnerA.id, album.id);
      const { elevated } = partner;
      await same((id) => sut.get(elevated, id), partner.link.id);
      await same(
        (id) => sut.update(elevated, id, { expiresAt: new Date('2099-01-01T00:00:00.000Z') }),
        partner.link.id,
      );
      await same((id) => sut.addAssets(elevated, id, { assetIds: [partner.ownAsset.id] }), partner.link.id);
      await same((id) => sut.removeAssets(elevated, id, { assetIds: [partner.photoX.id] }), partner.link.id);
      await same((id) => sut.create(elevated, { type: SharedLinkType.Individual, assetIds: [id] }), partner.photoX.id);
      const ownLink = await newLink(ctx, partner.managerB.id, { assetIds: [partner.ownAsset.id] });
      const partnerHidden = await sut.addAssets(elevated, ownLink.id, { assetIds: [partner.photoX.id] });
      const partnerMissing = await sut.addAssets(elevated, ownLink.id, { assetIds: [missingId] });
      expect(strip(partnerHidden)).toEqual(strip(partnerMissing));
      expect(partnerHidden).toEqual([
        { assetId: partner.photoX.id, success: false, error: AssetIdErrorReason.NO_PERMISSION },
      ]);
    });

    it('elevated getAll lists a hidden link only when revealed', async () => {
      const { sut, ctx } = setup();
      const { plain, elevated, visibleLinks, hiddenLinks, links, albums, folders } = await setupOwnLocks(ctx, sut);

      await expect(sut.getAll(elevated, {}).then(idsOf)).resolves.toEqual(idsOf(visibleLinks));

      const revealAll = {
        albumIds: [albums.regular.id, albums.smart.id],
        containerIds: [folders.folder.id, folders.ancestor.id],
      };
      await expect(sut.getAll({ ...elevated, revealedLocks: revealAll } as AuthDto, {}).then(idsOf)).resolves.toEqual(
        idsOf([...visibleLinks, ...hiddenLinks]),
      );

      // a partial reveal shows exactly what it uncovers: the mixed link's only hidden asset is in the regular album,
      // while the all-hidden link also holds an asset hidden by the (still locked) smart album
      const partial = { ...elevated, revealedLocks: { albumIds: [albums.regular.id], containerIds: [] } } as AuthDto;
      await expect(sut.getAll(partial, {}).then(idsOf)).resolves.toEqual(
        idsOf([...visibleLinks, links.regular, links.mixed]),
      );
      const folderOnly = {
        ...elevated,
        revealedLocks: { albumIds: [], containerIds: [folders.folder.id] },
      } as AuthDto;
      await expect(sut.getAll(folderOnly, {}).then(idsOf)).resolves.toEqual(idsOf([...visibleLinks, links.inFolder]));

      // the same reveal set in a non-elevated session reveals nothing
      await expect(sut.getAll({ ...plain, revealedLocks: revealAll } as AuthDto, {}).then(idsOf)).resolves.toEqual(
        idsOf(visibleLinks),
      );
    });

    it('an individual link containing the motion asset of a locked still is hidden for the manager (7A.1 x 7A.2)', async () => {
      const { sut, ctx } = setup();
      const locks = ctx.get(LockRepository);
      const { user } = await ctx.newUser();
      const plain = factory.auth({ user });
      const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });

      const { asset: motion } = await ctx.newAsset({
        ownerId: user.id,
        type: AssetType.Video,
        visibility: AssetVisibility.Hidden,
      });
      await ctx.newExif({ assetId: motion.id, make: 'Canon' });
      const still = await newLinkAsset(ctx, user.id);
      await ctx.database.updateTable('asset').set({ livePhotoVideoId: motion.id }).where('id', '=', still.id).execute();
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [still.id]);

      // minted while the Live Photo was visible; the still's album is locked afterwards
      const link = await newLink(ctx, user.id, { assetIds: [motion.id] });
      await locks.lockAlbum(user.id, album.id);

      await expect(sut.getAll(plain, {}).then(idsOf)).resolves.toEqual([]);
      await expect(sut.get(plain, link.id)).rejects.toThrow(LINK_NOT_FOUND);
      await expect(sut.update(plain, link.id, { allowDownload: true })).rejects.toThrow(LINK_NOT_FOUND);
      await expect(sut.create(plain, { type: SharedLinkType.Individual, assetIds: [motion.id] })).rejects.toThrow(
        ASSET_SHARE_ERROR,
      );

      // the manager's own lock: elevation bypasses it for direct-by-id management, the list needs the reveal set
      await expect(sut.get(elevated, link.id)).resolves.toEqual(expect.objectContaining({ id: link.id }));
      await expect(sut.getAll(elevated, {}).then(idsOf)).resolves.toEqual([]);
      const revealing = { ...elevated, revealedLocks: { albumIds: [album.id], containerIds: [] } } as AuthDto;
      await expect(sut.getAll(revealing, {}).then(idsOf)).resolves.toEqual([link.id]);

      // the same holds for a partner's motion asset in B's link - and there elevation never helps
      const { user: managerB } = await ctx.newUser();
      await ctx.newPartner({ sharedById: user.id, sharedWithId: managerB.id });
      const partnerLink = await newLink(ctx, managerB.id, { assetIds: [motion.id] });
      const bElevated = factory.auth({ user: managerB, session: { hasElevatedPermission: true } });
      await expect(sut.getAll(bElevated, {}).then(idsOf)).resolves.toEqual([]);
      await expect(sut.get(bElevated, partnerLink.id)).rejects.toThrow(LINK_NOT_FOUND);
    });

    it('public visitor access through an existing key is unchanged', async () => {
      const { sut, ctx } = setup();
      const { user, hiddenLinks, links, assets } = await setupOwnLocks(ctx, sut);
      const access = ctx.get(AccessRepository);

      for (const link of hiddenLinks) {
        await expect(sut.getMine(await asVisitor(ctx, user.id, link), [])).resolves.toEqual(
          expect.objectContaining({ id: link.id }),
        );
      }
      const visitor = await asVisitor(ctx, user.id, links.allHidden);
      await expect(sut.getMine(visitor, [])).resolves.toEqual(
        expect.objectContaining({
          assets: expect.arrayContaining([
            expect.objectContaining({ id: assets.hiddenA.id }),
            expect.objectContaining({ id: assets.hiddenB.id }),
          ]),
        }),
      );
      await expect(
        checkAccess(access, {
          auth: visitor,
          permission: Permission.AssetRead,
          ids: [assets.hiddenA.id, assets.hiddenB.id],
        }),
      ).resolves.toEqual(new Set([assets.hiddenA.id, assets.hiddenB.id]));

      // and for a link exposing a partner's later-locked photo
      const partner = await setupPartnerLink(ctx, sut);
      const { album } = await ctx.newAlbum({ ownerId: partner.partnerA.id }, [partner.photoX.id]);
      await ctx.get(LockRepository).lockAlbum(partner.partnerA.id, album.id);
      const partnerVisitor = await asVisitor(ctx, partner.managerB.id, { ...partner.link, albumId: null });
      await expect(sut.getMine(partnerVisitor, [])).resolves.toEqual(
        expect.objectContaining({ assets: [expect.objectContaining({ id: partner.photoX.id })] }),
      );
      await expect(
        checkAccess(access, { auth: partnerVisitor, permission: Permission.AssetRead, ids: [partner.photoX.id] }),
      ).resolves.toEqual(new Set([partner.photoX.id]));
    });
  });

  describe('fork: smart-album links accept no uploads (R36-5)', () => {
    const SMART_UPLOAD_ERROR = 'Smart albums do not accept uploads';

    it('defaults allowUpload to false for a smart album and refuses an explicit true', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { album: smart } = await ctx.newAlbum({
        ownerId: user.id,
        kind: AlbumKind.Smart,
        filter: { isFavorite: true },
      });
      const { album: regular } = await ctx.newAlbum({ ownerId: user.id });

      await expect(sut.create(auth, { type: SharedLinkType.Album, albumId: smart.id })).resolves.toEqual(
        expect.objectContaining({ allowUpload: false }),
      );
      await expect(
        sut.create(auth, { type: SharedLinkType.Album, albumId: smart.id, allowUpload: false }),
      ).resolves.toEqual(expect.objectContaining({ allowUpload: false }));
      await expect(
        sut.create(auth, { type: SharedLinkType.Album, albumId: smart.id, allowUpload: true }),
      ).rejects.toThrow(SMART_UPLOAD_ERROR);

      // regular albums keep the upstream default
      await expect(sut.create(auth, { type: SharedLinkType.Album, albumId: regular.id })).resolves.toEqual(
        expect.objectContaining({ allowUpload: true }),
      );
    });

    it('refuses enabling uploads on an existing smart-album link', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { album: smart } = await ctx.newAlbum({
        ownerId: user.id,
        kind: AlbumKind.Smart,
        filter: { isFavorite: true },
      });
      const link = await sut.create(auth, { type: SharedLinkType.Album, albumId: smart.id });

      await expect(sut.update(auth, link.id, { allowUpload: true })).rejects.toThrow(SMART_UPLOAD_ERROR);
      await expect(sut.update(auth, link.id, { description: 'renamed' })).resolves.toEqual(
        expect.objectContaining({ allowUpload: false, description: 'renamed' }),
      );
      // a legacy link created with uploads on can still be switched off
      await ctx.database.updateTable('shared_link').set({ allowUpload: true }).where('id', '=', link.id).execute();
      await expect(sut.update(auth, link.id, { allowUpload: false })).resolves.toEqual(
        expect.objectContaining({ allowUpload: false }),
      );
    });
  });
});
