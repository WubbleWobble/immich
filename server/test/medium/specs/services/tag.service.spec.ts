import { Kysely } from 'kysely';
import { BulkIdErrorReason } from 'src/dtos/asset-ids.response.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AlbumKind, AlbumUserRole, JobName, JobStatus, Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LockRepository } from 'src/repositories/lock.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { DB } from 'src/schema/index.js';
import { AlbumService } from 'src/services/album.service.js';
import { BaseService } from 'src/services/base.service.js';
import { TagService } from 'src/services/tag.service.js';
import { checkAccess } from 'src/utils/access.js';
import { upsertTags } from 'src/utils/tag.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(TagService, {
    database: db || defaultDatabase,
    real: [
      AlbumRepository,
      AlbumUserRepository,
      AssetRepository,
      LockRepository,
      TagRepository,
      AccessRepository,
      SearchRepository,
    ],
    mock: [EventRepository, JobRepository, LoggingRepository],
  });
};

type Ctx = ReturnType<typeof setup>['ctx'];

const getFilter = async (ctx: Ctx, albumId: string) => {
  const { filter } = await ctx.database
    .selectFrom('album')
    .select('filter')
    .where('id', '=', albumId)
    .executeTakeFirstOrThrow();
  return filter as { tagIds?: string[] } | null;
};

/** Which of `assetIds` `auth` may read, through every grant path (owner, album, partner, smart album, locks). */
const readableAssetIds = async (ctx: Ctx, auth: AuthDto, assetIds: string[]) =>
  [
    ...(await checkAccess(ctx.get(AccessRepository), { auth, permission: Permission.AssetRead, ids: assetIds })),
  ].toSorted();

/** The asset count the Albums list shows `auth` for `albumId` (served from, or recomputed into, the smart-album cache). */
const listedAssetCount = async (sut: TagService, auth: AuthDto, albumId: string) => {
  const albums = await BaseService.create(AlbumService, sut).getAll(auth, {});
  return albums.find(({ id }) => id === albumId)?.assetCount;
};

/** A smart album of `ownerId` with `filter`, shared with `recipientId` as a viewer. */
const newSharedSmartAlbum = async (ctx: Ctx, ownerId: string, recipientId: string, filter: object) => {
  const { album } = await ctx.newAlbum({ ownerId, kind: AlbumKind.Smart, filter: filter as any });
  await ctx.newAlbumUser({ albumId: album.id, userId: recipientId, role: AlbumUserRole.Viewer });
  return album;
};

/** A tag owned by one user, plus another user's auth to attempt access with */
const newTagOfAnotherUser = async (ctx: ReturnType<typeof setup>['ctx']) => {
  const { user } = await ctx.newUser();
  const { user: otherUser } = await ctx.newUser();
  const [tag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['tag-1'] });

  return { tag, auth: factory.auth({ user }), otherAuth: factory.auth({ user: otherUser }) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

/**
 * `protectedOnly` is hidden by nothing but the owner's locked smart album filtering on the tag; `visible` carries
 * the tag too but an unlocked regular album rescues it; `alsoLocked` additionally sits in a locked regular album.
 */
const lockedByTag = async (ctx: Ctx, tags = ['trip']) => {
  const { user } = await ctx.newUser();
  const { user: partner } = await ctx.newUser();
  await ctx.newPartner({ sharedById: user.id, sharedWithId: partner.id });
  const upserted = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags });
  const tag = upserted.at(-1)!;
  const { asset: protectedOnly } = await ctx.newAsset({ ownerId: user.id });
  const { asset: visible } = await ctx.newAsset({ ownerId: user.id });
  const { asset: alsoLocked } = await ctx.newAsset({ ownerId: user.id });
  await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [protectedOnly.id, visible.id, alsoLocked.id] });
  for (const asset of [protectedOnly, visible, alsoLocked]) {
    await ctx.newExif({ assetId: asset.id, tags: [tag.value] });
  }
  await ctx.newAlbum({ ownerId: user.id }, [visible.id]);
  const { album: lockedRegular } = await ctx.newAlbum({ ownerId: user.id }, [alsoLocked.id]);
  const { album: lockedSmart } = await ctx.newAlbum({
    ownerId: user.id,
    kind: AlbumKind.Smart,
    filter: { tagIds: [upserted[0].id] } as any,
  });
  await ctx.get(LockRepository).lockAlbum(user.id, lockedRegular.id);
  await ctx.get(LockRepository).lockAlbum(user.id, lockedSmart.id);
  return {
    user,
    tag,
    root: upserted[0],
    protectedOnly,
    visible,
    alsoLocked,
    ids: [protectedOnly.id, visible.id, alsoLocked.id],
    ordinary: factory.auth({ user, session: { hasElevatedPermission: false } }),
    elevated: factory.auth({ user, session: { hasElevatedPermission: true } }),
    partnerAuth: factory.auth({ user: partner }),
  };
};

const taggedAssetIds = async (ctx: Ctx, tagId: string, assetIds: string[]) =>
  [...(await ctx.get(TagRepository).getAssetIds(tagId, assetIds))].toSorted();

describe(TagService.name, () => {
  describe('get', () => {
    it('should not return a tag of another user', async () => {
      const { sut, ctx } = setup();
      const { tag, otherAuth } = await newTagOfAnotherUser(ctx);

      await expect(sut.get(otherAuth, tag.id)).rejects.toThrow('Not found or no tag.read access');
    });
  });

  describe('update', () => {
    it('should not update a tag of another user', async () => {
      const { sut, ctx } = setup();
      const { tag, otherAuth } = await newTagOfAnotherUser(ctx);

      await expect(sut.update(otherAuth, tag.id, { color: '#000000' })).rejects.toThrow(
        'Not found or no tag.update access',
      );
    });

    it('should sync renamed tags and descendants to the exif table', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { asset: parentAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: childAsset } = await ctx.newAsset({ ownerId: user.id });
      const tagRepo = ctx.get(TagRepository);
      const [parentTag, childTag] = await upsertTags(tagRepo, {
        userId: user.id,
        tags: ['parent', 'parent/child'],
      });
      await ctx.newTagAsset({ tagIds: [parentTag.id], assetIds: [parentAsset.id] });
      await ctx.newTagAsset({ tagIds: [childTag.id], assetIds: [childAsset.id] });
      await ctx.newExif({ assetId: parentAsset.id, tags: ['parent'] });
      await ctx.newExif({ assetId: childAsset.id, tags: ['parent/child'] });

      await sut.update(factory.auth({ user }), parentTag.id, { name: 'renamed' });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select(['assetId', 'lockedProperties', 'tags'])
          .where('assetId', 'in', [parentAsset.id, childAsset.id])
          .orderBy('assetId')
          .execute(),
      ).resolves.toEqual(
        expect.arrayContaining([
          { assetId: parentAsset.id, lockedProperties: ['tags'], tags: ['renamed'] },
          { assetId: childAsset.id, lockedProperties: ['tags'], tags: ['renamed/child'] },
        ]),
      );
      expect(ctx.getMock(JobRepository).queueAll).toHaveBeenCalledWith(
        expect.arrayContaining([
          { name: JobName.SidecarWrite, data: { id: parentAsset.id } },
          { name: JobName.SidecarWrite, data: { id: childAsset.id } },
        ]),
      );
    });
  });

  describe('fork locks', () => {
    it("tag rename and delete keep hidden assets' exif tags in sync, within the tag owner's assets only", async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { user: stranger } = await ctx.newUser();
      const { asset: visible } = await ctx.newAsset({ ownerId: user.id });
      const { asset: hidden } = await ctx.newAsset({ ownerId: user.id });
      const { asset: foreign } = await ctx.newAsset({ ownerId: stranger.id });
      const { album: locked } = await ctx.newAlbum({ ownerId: user.id }, [hidden.id]);
      await ctx.get(LockRepository).lockAlbum(user.id, locked.id);
      const [tag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['trip'] });
      await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [visible.id, hidden.id] });
      // a stray cross-owner link (no API creates one): the tag owner's rename must never rewrite another user's asset
      await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [foreign.id] });
      await ctx.newExif({ assetId: visible.id, tags: ['trip'] });
      await ctx.newExif({ assetId: hidden.id, tags: ['trip'] });
      await ctx.newExif({ assetId: foreign.id, tags: ['mine'] });
      const exifTags = () =>
        ctx.database
          .selectFrom('asset_exif')
          .select(['assetId', 'tags'])
          .where('assetId', 'in', [visible.id, hidden.id, foreign.id])
          .execute();
      const auth = factory.auth({ user });

      // a derived-data consistency write, not a read: hidden assets must follow too, or their stale exif/sidecar
      // tag would resurrect the old value on the next metadata extraction. Nothing about them is returned.
      await expect(sut.update(auth, tag.id, { name: 'renamed' })).resolves.toEqual(
        expect.objectContaining({ id: tag.id, value: 'renamed' }),
      );
      await expect(exifTags()).resolves.toEqual(
        expect.arrayContaining([
          { assetId: visible.id, tags: ['renamed'] },
          { assetId: hidden.id, tags: ['renamed'] },
          { assetId: foreign.id, tags: ['mine'] },
        ]),
      );
      expect(ctx.getMock(JobRepository).queueAll).toHaveBeenLastCalledWith(
        expect.not.arrayContaining([{ name: JobName.SidecarWrite, data: { id: foreign.id } }]),
      );

      // R71: a lock holder deletes a tag in an elevated session
      const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });
      await expect(sut.remove(elevated, tag.id)).resolves.toBeUndefined();
      await expect(exifTags()).resolves.toEqual(
        expect.arrayContaining([
          { assetId: visible.id, tags: [] },
          { assetId: hidden.id, tags: [] },
          { assetId: foreign.id, tags: ['mine'] },
        ]),
      );
      expect(ctx.getMock(JobRepository).queueAll).toHaveBeenLastCalledWith(
        expect.not.arrayContaining([{ name: JobName.SidecarWrite, data: { id: foreign.id } }]),
      );
    });
  });

  describe('remove', () => {
    it('should not remove a tag of another user', async () => {
      const { sut, ctx } = setup();
      const { tag, auth, otherAuth } = await newTagOfAnotherUser(ctx);

      await expect(sut.remove(otherAuth, tag.id)).rejects.toThrow('Not found or no tag.delete access');
      await expect(sut.get(auth, tag.id)).resolves.toEqual(expect.objectContaining({ id: tag.id }));
    });
  });

  describe('smart album filters keep dangling tag ids (D12)', () => {
    it('deleting one of several referenced tags does not broaden a shared smart album', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user: owner } = await ctx.newUser();
      const { user: recipient } = await ctx.newUser();
      const [a, b] = await upsertTags(ctx.get(TagRepository), { userId: owner.id, tags: ['a', 'b'] });
      const { asset: both } = await ctx.newAsset({ ownerId: owner.id });
      const { asset: onlyA } = await ctx.newAsset({ ownerId: owner.id });
      const { asset: onlyB } = await ctx.newAsset({ ownerId: owner.id });
      await ctx.newTagAsset({ tagIds: [a.id, b.id], assetIds: [both.id] });
      await ctx.newTagAsset({ tagIds: [a.id], assetIds: [onlyA.id] });
      await ctx.newTagAsset({ tagIds: [b.id], assetIds: [onlyB.id] });
      const album = await newSharedSmartAlbum(ctx, owner.id, recipient.id, { tagIds: [a.id, b.id] });
      const recipientAuth = factory.auth({ user: recipient });
      const candidates = [both.id, onlyA.id, onlyB.id];

      const before = await readableAssetIds(ctx, recipientAuth, candidates);
      expect(before).toEqual([both.id]);

      await sut.remove(factory.auth({ user: owner }), a.id);

      const after = await readableAssetIds(ctx, recipientAuth, candidates);
      expect(
        after.filter((id) => !before.includes(id)),
        'newly readable',
      ).toEqual([]);
      expect(after).not.toContain(onlyB.id);
      await expect(getFilter(ctx, album.id)).resolves.toHaveProperty('tagIds', [a.id, b.id]);
    });

    it('deleting the last referenced person/tag while another criterion remains yields zero matches', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user: owner } = await ctx.newUser();
      const { user: recipient } = await ctx.newUser();
      const [tag] = await upsertTags(ctx.get(TagRepository), { userId: owner.id, tags: ['trip'] });
      const { asset: favoriteTagged } = await ctx.newAsset({ ownerId: owner.id, isFavorite: true });
      const { asset: favoriteOnly } = await ctx.newAsset({ ownerId: owner.id, isFavorite: true });
      await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [favoriteTagged.id] });
      const album = await newSharedSmartAlbum(ctx, owner.id, recipient.id, { tagIds: [tag.id], isFavorite: true });
      const ownerAuth = factory.auth({ user: owner });
      const recipientAuth = factory.auth({ user: recipient });
      const candidates = [favoriteTagged.id, favoriteOnly.id];

      await expect(readableAssetIds(ctx, recipientAuth, candidates)).resolves.toEqual([favoriteTagged.id]);
      await expect(listedAssetCount(sut, ownerAuth, album.id)).resolves.toBe(1);
      await expect(listedAssetCount(sut, recipientAuth, album.id)).resolves.toBe(1);

      await sut.remove(ownerAuth, tag.id);

      await expect(readableAssetIds(ctx, recipientAuth, candidates)).resolves.toEqual([]);
      // the list-view cache recompute evaluates the dangling id without error, to zero
      await expect(listedAssetCount(sut, ownerAuth, album.id)).resolves.toBe(0);
      await expect(listedAssetCount(sut, recipientAuth, album.id)).resolves.toBe(0);
      expect(await getFilter(ctx, album.id)).toEqual({ tagIds: [tag.id], isFavorite: true });
    });

    it('an unlocked smart album with a dangling id cannot rescue locked assets', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user: owner } = await ctx.newUser();
      const [a, b] = await upsertTags(ctx.get(TagRepository), { userId: owner.id, tags: ['a', 'b'] });
      const { asset: hidden } = await ctx.newAsset({ ownerId: owner.id });
      await ctx.newTagAsset({ tagIds: [b.id], assetIds: [hidden.id] });
      const { album: locked } = await ctx.newAlbum({ ownerId: owner.id }, [hidden.id]);
      await ctx.get(LockRepository).lockAlbum(owner.id, locked.id);
      const { album } = await ctx.newAlbum({
        ownerId: owner.id,
        kind: AlbumKind.Smart,
        filter: { tagIds: [a.id, b.id] } as any,
      });
      const ownerAuth = factory.auth({ user: owner });

      await expect(readableAssetIds(ctx, ownerAuth, [hidden.id])).resolves.toEqual([]);

      // R71: a lock holder deletes a tag in an elevated session
      await sut.remove(factory.auth({ user: owner, session: { hasElevatedPermission: true } }), a.id);

      await expect(readableAssetIds(ctx, ownerAuth, [hidden.id])).resolves.toEqual([]);
      await expect(getFilter(ctx, album.id)).resolves.toHaveProperty('tagIds', [a.id, b.id]);

      // control: the album with the dangling id pruned away would rescue the asset, so the checks above are meaningful
      await ctx.database
        .updateTable('album')
        .set({ filter: { tagIds: [b.id] } as any })
        .where('id', '=', album.id)
        .execute();
      await expect(readableAssetIds(ctx, ownerAuth, [hidden.id])).resolves.toEqual([hidden.id]);
    });
  });

  describe('classification removals and locked smart albums (R71)', () => {
    const needsElevation = 'Elevated permission is required';

    it('untagging skips a hidden photo in an ordinary session like one that is not tagged, and untags the visible one', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { tag, protectedOnly, visible, alsoLocked, ids, ordinary, partnerAuth, user } = await lockedByTag(ctx);
      const { asset: untagged } = await ctx.newAsset({ ownerId: user.id });

      await expect(readableAssetIds(ctx, ordinary, ids)).resolves.toEqual([visible.id]);
      await expect(readableAssetIds(ctx, partnerAuth, ids)).resolves.toEqual([visible.id]);

      await expect(
        sut.removeAssets(ordinary, tag.id, { ids: [protectedOnly.id, visible.id, alsoLocked.id, untagged.id] }),
      ).resolves.toEqual([
        { id: protectedOnly.id, success: false, error: BulkIdErrorReason.NOT_FOUND },
        { id: visible.id, success: true },
        { id: alsoLocked.id, success: false, error: BulkIdErrorReason.NOT_FOUND },
        // R32: the same answer as for a photo of the caller's that simply does not carry the tag
        { id: untagged.id, success: false, error: BulkIdErrorReason.NOT_FOUND },
      ]);

      await expect(taggedAssetIds(ctx, tag.id, ids)).resolves.toEqual([protectedOnly.id, alsoLocked.id].toSorted());
      await expect(readableAssetIds(ctx, ordinary, ids)).resolves.toEqual([visible.id]);
      await expect(readableAssetIds(ctx, partnerAuth, ids)).resolves.toEqual([visible.id]);
      // only the untagged photo's denormalized tags were rewritten
      expect(ctx.getMock(EventRepository).emit).toHaveBeenCalledTimes(1);
      expect(ctx.getMock(EventRepository).emit).toHaveBeenCalledWith('AssetUntag', { assetId: visible.id });
    });

    it('a reveal header does not make a hidden photo untaggable', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { tag, protectedOnly, ordinary, user } = await lockedByTag(ctx);
      const { lockedAlbumIds } = await ctx.get(LockRepository).getLocks(user.id);
      const revealing = { ...ordinary, revealedLocks: { albumIds: lockedAlbumIds, containerIds: [] } };

      await expect(sut.removeAssets(revealing, tag.id, { ids: [protectedOnly.id] })).resolves.toEqual([
        { id: protectedOnly.id, success: false, error: BulkIdErrorReason.NOT_FOUND },
      ]);
      await expect(readableAssetIds(ctx, ordinary, [protectedOnly.id])).resolves.toEqual([]);
      expect(ctx.getMock(EventRepository).emit).not.toHaveBeenCalled();
    });

    it('untagging a hidden photo works in an elevated session; a locked regular album still protects', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { tag, protectedOnly, visible, alsoLocked, ids, ordinary, elevated, partnerAuth } = await lockedByTag(ctx);

      await expect(sut.removeAssets(elevated, tag.id, { ids: [protectedOnly.id, alsoLocked.id] })).resolves.toEqual([
        { id: protectedOnly.id, success: true },
        { id: alsoLocked.id, success: true },
      ]);

      // the PIN holder released the photo that only the tag filter was hiding; the regular lock is untouched
      const expected = [protectedOnly.id, visible.id].toSorted();
      await expect(readableAssetIds(ctx, ordinary, ids)).resolves.toEqual(expected);
      await expect(readableAssetIds(ctx, partnerAuth, ids)).resolves.toEqual(expected);
    });

    it('refuses deleting a tag in an ordinary session when the owner holds locks', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { tag, visible, ids, ordinary, partnerAuth, user } = await lockedByTag(ctx);
      const { lockedAlbumIds } = await ctx.get(LockRepository).getLocks(user.id);

      await expect(sut.remove(ordinary, tag.id)).rejects.toThrow(needsElevation);
      await expect(
        sut.remove({ ...ordinary, revealedLocks: { albumIds: lockedAlbumIds, containerIds: [] } }, tag.id),
      ).rejects.toThrow(needsElevation);

      await expect(ctx.get(TagRepository).get(tag.id)).resolves.toBeDefined();
      await expect(taggedAssetIds(ctx, tag.id, ids)).resolves.toEqual(ids.toSorted());
      await expect(readableAssetIds(ctx, ordinary, ids)).resolves.toEqual([visible.id]);
      await expect(readableAssetIds(ctx, partnerAuth, ids)).resolves.toEqual([visible.id]);
      expect(ctx.getMock(JobRepository).queueAll).not.toHaveBeenCalled();
    });

    it('refuses deleting an ancestor tag in an ordinary session when the owner holds locks', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      // the locked smart album filters on `trips`; the photos carry its descendant `trips/2024`
      const { tag, root, visible, ids, ordinary, partnerAuth } = await lockedByTag(ctx, ['trips', 'trips/2024']);
      expect(tag.id).not.toEqual(root.id);

      await expect(sut.remove(ordinary, root.id)).rejects.toThrow(needsElevation);
      await expect(sut.remove(ordinary, tag.id)).rejects.toThrow(needsElevation);

      await expect(taggedAssetIds(ctx, tag.id, ids)).resolves.toEqual(ids.toSorted());
      await expect(readableAssetIds(ctx, ordinary, ids)).resolves.toEqual([visible.id]);
      await expect(readableAssetIds(ctx, partnerAuth, ids)).resolves.toEqual([visible.id]);
    });

    it('deletes a tag in an elevated session, keeping exif tags in sync; a locked regular album still protects', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { root, protectedOnly, visible, ids, ordinary, elevated, partnerAuth } = await lockedByTag(ctx, [
        'trips',
        'trips/2024',
      ]);

      await expect(sut.remove(elevated, root.id)).resolves.toBeUndefined();

      const expected = [protectedOnly.id, visible.id].toSorted();
      await expect(readableAssetIds(ctx, ordinary, ids)).resolves.toEqual(expected);
      await expect(readableAssetIds(ctx, partnerAuth, ids)).resolves.toEqual(expected);
      // no stale tag is left behind in the denormalized exif tags (or the sidecars queued from them)
      await expect(
        ctx.database.selectFrom('asset_exif').select('tags').where('assetId', 'in', ids).execute(),
      ).resolves.toEqual([{ tags: [] }, { tags: [] }, { tags: [] }]);
      expect(ctx.getMock(JobRepository).queueAll).toHaveBeenCalledWith(
        expect.arrayContaining(ids.map((id) => ({ name: JobName.SidecarWrite, data: { id } }))),
      );
    });

    it('leaves an owner without locks alone: ordinary untag and tag delete work', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user, session: { hasElevatedPermission: false } });
      const [tag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['trip'] });
      const { asset: first } = await ctx.newAsset({ ownerId: user.id });
      const { asset: second } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [first.id, second.id] });

      await expect(sut.removeAssets(auth, tag.id, { ids: [first.id] })).resolves.toEqual([
        { id: first.id, success: true },
      ]);
      await expect(sut.remove(auth, tag.id)).resolves.toBeUndefined();
      await expect(ctx.get(TagRepository).get(tag.id)).resolves.toBeUndefined();
    });
  });

  describe('addAssets', () => {
    it('should not add assets to a tag of another user', async () => {
      const { sut, ctx } = setup();
      const { tag, otherAuth } = await newTagOfAnotherUser(ctx);
      const { asset } = await ctx.newAsset({ ownerId: otherAuth.user.id });

      await expect(sut.addAssets(otherAuth, tag.id, { ids: [asset.id] })).rejects.toThrow(
        'Not found or no tag.asset access',
      );
    });

    it('should lock exif column', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const [tag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['tag-1'] });
      const authDto = factory.auth({ user });

      await sut.addAssets(authDto, tag.id, { ids: [asset.id] });
      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select(['lockedProperties', 'tags'])
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        lockedProperties: ['tags'],
        tags: ['tag-1'],
      });
      await expect(ctx.get(TagRepository).getByValue(user.id, 'tag-1')).resolves.toEqual(
        expect.objectContaining({ id: tag.id }),
      );
      await expect(ctx.get(TagRepository).getAssetIds(tag.id, [asset.id])).resolves.toContain(asset.id);
    });

    it('should not tag a partner asset', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { user: owner } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: owner.id, inTimeline: true });
      const { asset } = await ctx.newAsset({ ownerId: partner.id });
      const [tag] = await upsertTags(ctx.get(TagRepository), { userId: owner.id, tags: ['tag-1'] });
      const authDto = factory.auth({ user: owner });

      await expect(sut.addAssets(authDto, tag.id, { ids: [asset.id] })).resolves.toEqual([
        { id: asset.id, success: false, error: BulkIdErrorReason.NO_PERMISSION },
      ]);
    });
  });

  describe('removeAssets', () => {
    it('should not remove assets from a tag of another user', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { tag, auth, otherAuth } = await newTagOfAnotherUser(ctx);
      const { asset } = await ctx.newAsset({ ownerId: auth.user.id });
      await sut.addAssets(auth, tag.id, { ids: [asset.id] });

      await expect(sut.removeAssets(otherAuth, tag.id, { ids: [asset.id] })).rejects.toThrow(
        'Not found or no tag.asset access',
      );
      await expect(ctx.get(TagRepository).getAssetIds(tag.id, [asset.id])).resolves.toContain(asset.id);
    });
  });

  describe('deleteEmptyTags', () => {
    it('single tag exists, not connected to any assets, and is deleted', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const tagRepo = ctx.get(TagRepository);
      const [tag] = await upsertTags(tagRepo, { userId: user.id, tags: ['tag-1'] });

      await expect(tagRepo.getByValue(user.id, 'tag-1')).resolves.toEqual(expect.objectContaining({ id: tag.id }));
      await expect(sut.handleTagCleanup()).resolves.toBe(JobStatus.Success);
      await expect(tagRepo.getByValue(user.id, 'tag-1')).resolves.toBeUndefined();
    });

    it('single tag exists, connected to one asset, and is not deleted', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const tagRepo = ctx.get(TagRepository);
      const [tag] = await upsertTags(tagRepo, { userId: user.id, tags: ['tag-1'] });

      await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [asset.id] });

      await expect(tagRepo.getByValue(user.id, 'tag-1')).resolves.toEqual(expect.objectContaining({ id: tag.id }));
      await expect(sut.handleTagCleanup()).resolves.toBe(JobStatus.Success);
      await expect(tagRepo.getByValue(user.id, 'tag-1')).resolves.toEqual(expect.objectContaining({ id: tag.id }));
    });

    it('hierarchical tag exists, and the parent is connected to an asset, and the child is deleted', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const tagRepo = ctx.get(TagRepository);
      const [parentTag, childTag] = await upsertTags(tagRepo, { userId: user.id, tags: ['parent', 'parent/child'] });

      await ctx.newTagAsset({ tagIds: [parentTag.id], assetIds: [asset.id] });

      await expect(tagRepo.getByValue(user.id, 'parent')).resolves.toEqual(
        expect.objectContaining({ id: parentTag.id }),
      );
      await expect(tagRepo.getByValue(user.id, 'parent/child')).resolves.toEqual(
        expect.objectContaining({ id: childTag.id }),
      );
      await expect(sut.handleTagCleanup()).resolves.toBe(JobStatus.Success);
      await expect(tagRepo.getByValue(user.id, 'parent')).resolves.toEqual(
        expect.objectContaining({ id: parentTag.id }),
      );
      await expect(tagRepo.getByValue(user.id, 'parent/child')).resolves.toBeUndefined();
    });

    it('hierarchical tag exists, and only the child is connected to an asset, and nothing is deleted', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const tagRepo = ctx.get(TagRepository);
      const [parentTag, childTag] = await upsertTags(tagRepo, { userId: user.id, tags: ['parent', 'parent/child'] });

      await ctx.newTagAsset({ tagIds: [childTag.id], assetIds: [asset.id] });

      await expect(tagRepo.getByValue(user.id, 'parent')).resolves.toEqual(
        expect.objectContaining({ id: parentTag.id }),
      );
      await expect(tagRepo.getByValue(user.id, 'parent/child')).resolves.toEqual(
        expect.objectContaining({ id: childTag.id }),
      );
      await expect(sut.handleTagCleanup()).resolves.toBe(JobStatus.Success);
      await expect(tagRepo.getByValue(user.id, 'parent')).resolves.toEqual(
        expect.objectContaining({ id: parentTag.id }),
      );
      await expect(tagRepo.getByValue(user.id, 'parent/child')).resolves.toEqual(
        expect.objectContaining({ id: childTag.id }),
      );
    });

    it('hierarchical tag exists, and neither parent nor child is connected to an asset, and both are deleted', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const tagRepo = ctx.get(TagRepository);
      const [parentTag, childTag] = await upsertTags(tagRepo, { userId: user.id, tags: ['parent', 'parent/child'] });

      await expect(tagRepo.getByValue(user.id, 'parent')).resolves.toEqual(
        expect.objectContaining({ id: parentTag.id }),
      );
      await expect(tagRepo.getByValue(user.id, 'parent/child')).resolves.toEqual(
        expect.objectContaining({ id: childTag.id }),
      );
      await expect(sut.handleTagCleanup()).resolves.toBe(JobStatus.Success);
      await expect(tagRepo.getByValue(user.id, 'parent/child')).resolves.toBeUndefined();
      await expect(tagRepo.getByValue(user.id, 'parent')).resolves.toBeUndefined();
    });
  });
});
