import { NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetEditAction, MirrorAxis } from 'src/dtos/editing.dto.js';
import { AssetFaceCreateDto, PersonSearchDto, PersonUserRole } from 'src/dtos/person.dto.js';
import { AlbumKind, AlbumUserRole, AssetFileType, AssetVisibility, JobName, Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ClusterGroupRepository } from 'src/repositories/cluster-group.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LockRepository } from 'src/repositories/lock.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { PersonUserRepository } from 'src/repositories/person-user.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AlbumService } from 'src/services/album.service.js';
import { BaseService } from 'src/services/base.service.js';
import { ClusterGroupService } from 'src/services/cluster-group.service.js';
import { PersonService } from 'src/services/person.service.js';
import { SearchService } from 'src/services/search.service.js';
import { checkAccess } from 'src/utils/access.js';
import { getMyPartnerIds } from 'src/utils/asset.util.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory, newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(PersonService, {
    database: db || defaultDatabase,
    real: [
      AccessRepository,
      AssetJobRepository,
      ConfigRepository,
      DatabaseRepository,
      PersonRepository,
      PersonUserRepository,
      AssetRepository,
      AssetEditRepository,
      SystemMetadataRepository,
      UserRepository,
      ClusterGroupRepository,
      PartnerRepository,
      LockRepository,
      AlbumRepository,
      AlbumUserRepository,
      SearchRepository,
    ],
    mock: [JobRepository, LoggingRepository, StorageRepository, MachineLearningRepository],
  });
};

type Ctx = ReturnType<typeof setup>['ctx'];

/** A face in `personGroupId` on a new asset of `ownerId`; with `locked`, the asset sits only in an album the owner locked. */
const newFaceOn = async (
  ctx: Ctx,
  { ownerId, personGroupId, locked = false }: { ownerId: string; personGroupId: string; locked?: boolean },
) => {
  const { asset } = await ctx.newAsset({ ownerId });
  const { assetFace: face } = await ctx.newAssetFace({ assetId: asset.id, personGroupId });
  const { album } = await ctx.newAlbum({ ownerId }, [asset.id]);
  if (locked) {
    await ctx.get(LockRepository).lockAlbum(ownerId, album.id);
  }
  return { asset, face, album };
};

/** Write a published (thumbnailPath, thumbnailSourceFaceId) pair directly. */
const publishPair = (
  ctx: Ctx,
  {
    ownerId,
    personGroupId,
    faceId,
    path,
  }: { ownerId: string; personGroupId: string; faceId: string | null; path: string },
) =>
  ctx.database
    .updateTable('person')
    .set({ thumbnailPath: path, thumbnailSourceFaceId: faceId })
    .where('ownerId', '=', ownerId)
    .where('personGroupId', '=', personGroupId)
    .execute();

/** The sharee runs every check as non-elevated, elevated, and elevated with a reveal set naming `revealAlbumIds`. */
const shareeAuths = (user: { id: string }, revealAlbumIds: string[]): [string, AuthDto][] => [
  ['non-elevated', factory.auth({ user })],
  ['elevated', factory.auth({ user, session: { hasElevatedPermission: true } })],
  [
    'elevated with reveal',
    {
      ...factory.auth({ user, session: { hasElevatedPermission: true } }),
      revealedLocks: { albumIds: revealAlbumIds, containerIds: [] },
    },
  ],
];

const expectServed = async (sut: PersonService, auth: AuthDto, personGroupId: string, path: string, label = '') => {
  await expect(sut.getThumbnail(auth, personGroupId), label).resolves.toEqual(expect.objectContaining({ path }));
};

const expectWithheld = async (sut: PersonService, auth: AuthDto, personGroupId: string, label = '') => {
  await expect(sut.getThumbnail(auth, personGroupId), label).rejects.toBeInstanceOf(NotFoundException);
};

const getCacheRevision = async (ctx: Ctx, albumId: string) => {
  const { cacheRevision } = await ctx.database
    .selectFrom('album')
    .select('cacheRevision')
    .where('id', '=', albumId)
    .executeTakeFirstOrThrow();
  return cacheRevision;
};

const getFilter = async (ctx: Ctx, albumId: string) => {
  const { filter } = await ctx.database
    .selectFrom('album')
    .select('filter')
    .where('id', '=', albumId)
    .executeTakeFirstOrThrow();
  return filter as { personIds?: string[] } | null;
};

/** Which of `assetIds` `auth` may read, through every grant path (owner, album, partner, smart album, locks). */
const readableAssetIds = async (ctx: Ctx, auth: AuthDto, assetIds: string[]) =>
  [
    ...(await checkAccess(ctx.get(AccessRepository), { auth, permission: Permission.AssetRead, ids: assetIds })),
  ].toSorted();

/** The asset count the Albums list shows `auth` for `albumId` (served from, or recomputed into, the smart-album cache). */
const listedAssetCount = async (sut: PersonService, auth: AuthDto, albumId: string) => {
  const albums = await BaseService.create(AlbumService, sut).getAll(auth, {});
  return albums.find(({ id }) => id === albumId)?.assetCount;
};

/** A smart album of `ownerId` with `filter`, shared with `recipientId` as a viewer. */
const newSharedSmartAlbum = async (ctx: Ctx, ownerId: string, recipientId: string, filter: object) => {
  const { album } = await ctx.newAlbum({ ownerId, kind: AlbumKind.Smart, filter: filter as any });
  await ctx.newAlbumUser({ albumId: album.id, userId: recipientId, role: AlbumUserRole.Viewer });
  return album;
};

/** A shares person group G with B; B's own person row (created by the share trigger) has no thumbnail. */
const newSharedPerson = async (ctx: Ctx) => {
  const { user: owner } = await ctx.newUser();
  const { user: sharee } = await ctx.newUser({ clusterGroupId: owner.clusterGroupId });
  const { person } = await ctx.newPerson({ ownerId: owner.id, thumbnailPath: '' });
  await ctx.newPersonUser({ personGroupId: person.personGroupId, sharedById: owner.id, sharedWithId: sharee.id });
  return { owner, sharee, personGroupId: person.personGroupId };
};

// Databases created for a single test are dropped from the pool afterwards, so the suite stays within the test
// server's connection limit.
const isolatedDatabases: Kysely<DB>[] = [];
const isolatedDb = async () => {
  const db = await getKyselyDB();
  isolatedDatabases.push(db);
  return db;
};

afterEach(async () => {
  await Promise.all(isolatedDatabases.splice(0).map((db) => db.destroy()));
});

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

/** A face's person and soft-delete state, or undefined once hard-deleted. */
const personOf = async (ctx: Ctx, faceId: string) => {
  const row = await ctx.database
    .selectFrom('asset_face')
    .select(['personGroupId', 'deletedAt'])
    .where('id', '=', faceId)
    .executeTakeFirst();
  return row;
};

describe(PersonService.name, () => {
  describe('reassignFaces', () => {
    it('should require access to the person the auth user is assigning to', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user2.id });

      await expect(sut.reassignFaces(factory.auth({ user }), person.personGroupId, { data: [] })).rejects.toThrow(
        'Not found or no person.update access',
      );
    });

    it('should allow person owner access', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });

      await expect(sut.reassignFaces(factory.auth({ user }), person.personGroupId, { data: [] })).resolves.toEqual([]);
    });

    it('should not allow shared read only access', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user2.id });
      await ctx.newPersonUser({
        personGroupId: person.personGroupId,
        sharedById: user2.id,
        sharedWithId: user.id,
        role: PersonUserRole.Read,
      });

      await expect(
        sut.reassignFaces(factory.auth({ user }), person.personGroupId, {
          data: [{ personId: person.personGroupId, userId: user2.id, assetId: newUuid() }],
        }),
      ).rejects.toThrow('Not found or no person.update access');
    });

    it('should allow shared write access', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user2.id });
      await ctx.newPersonUser({
        personGroupId: person.personGroupId,
        sharedById: user2.id,
        sharedWithId: user.id,
        role: PersonUserRole.Write,
      });

      await expect(
        sut.reassignFaces(factory.auth({ user }), person.personGroupId, {
          data: [{ personId: person.personGroupId, userId: user2.id, assetId: newUuid() }],
        }),
      ).resolves.toEqual([expect.objectContaining({ id: person.personGroupId })]);
    });
  });

  describe('getAll', () => {
    it('should filter by sharing direction and user', async () => {
      const { ctx, sut } = setup(await getKyselyDB());
      const { user: user1 } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser({ clusterGroupId: user1.clusterGroupId });
      const { user: user3 } = await ctx.newUser({ clusterGroupId: user1.clusterGroupId });
      const { asset } = await ctx.newAsset({ ownerId: user1.id });

      const { person: sharedByMe } = await ctx.newPerson({ ownerId: user1.id, name: 'Shared by me' });
      const { person: notShared } = await ctx.newPerson({ ownerId: user1.id, name: 'Not shared' });
      const { person: sharedWithMe } = await ctx.newPerson({ ownerId: user3.id, name: 'Shared with me' });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: sharedByMe.personGroupId });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: notShared.personGroupId });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: sharedWithMe.personGroupId });
      await ctx.newPersonUser({
        personGroupId: sharedByMe.personGroupId,
        sharedById: user1.id,
        sharedWithId: user2.id,
      });
      await ctx.newPersonUser({
        personGroupId: sharedWithMe.personGroupId,
        sharedById: user3.id,
        sharedWithId: user1.id,
      });

      const auth = factory.auth({ user: user1 });
      const getIds = async (dto: Partial<PersonSearchDto>) => {
        const { people, total } = await sut.getAll(auth, { page: 1, size: 10, ...dto });
        expect(total).toBe(people.length);
        return people.map(({ id }) => id).toSorted();
      };

      await expect(getIds({})).resolves.toEqual(
        [sharedByMe.personGroupId, notShared.personGroupId, sharedWithMe.personGroupId].toSorted(),
      );
      await expect(getIds({ sharedById: user1.id })).resolves.toEqual([sharedByMe.personGroupId]);
      await expect(getIds({ sharedWithId: user2.id })).resolves.toEqual([sharedByMe.personGroupId]);
      await expect(getIds({ sharedWithId: user3.id })).resolves.toEqual([]);
      await expect(getIds({ sharedWithId: user1.id })).resolves.toEqual([sharedWithMe.personGroupId]);
      await expect(getIds({ sharedById: user3.id })).resolves.toEqual([sharedWithMe.personGroupId]);
      await expect(getIds({ sharedById: user2.id })).resolves.toEqual([]);
    });

    it('should filter by favorite and hidden', async () => {
      const { ctx, sut } = setup(await getKyselyDB());
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { person: favorite } = await ctx.newPerson({ ownerId: user.id, isFavorite: true });
      const { person: hidden } = await ctx.newPerson({ ownerId: user.id, isHidden: true });
      const { person: neither } = await ctx.newPerson({ ownerId: user.id });
      for (const person of [favorite, hidden, neither]) {
        await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
      }

      const auth = factory.auth({ user });
      const getIds = async (dto: Partial<PersonSearchDto>) => {
        const { people, total } = await sut.getAll(auth, { page: 1, size: 10, withHidden: true, ...dto });
        expect(total).toBe(people.length);
        return people.map(({ id }) => id).toSorted();
      };

      await expect(getIds({ isFavorite: true })).resolves.toEqual([favorite.personGroupId]);
      await expect(getIds({ isFavorite: false })).resolves.toEqual(
        [hidden.personGroupId, neither.personGroupId].toSorted(),
      );
      await expect(getIds({ isHidden: true })).resolves.toEqual([hidden.personGroupId]);
      await expect(getIds({ isHidden: false })).resolves.toEqual(
        [favorite.personGroupId, neither.personGroupId].toSorted(),
      );
      await expect(getIds({ isFavorite: true, isHidden: true })).resolves.toEqual([]);
    });

    it('should include hidden people when filtering by isHidden without withHidden', async () => {
      const { ctx, sut } = setup(await getKyselyDB());
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { person: hidden } = await ctx.newPerson({ ownerId: user.id, isHidden: true });
      const { person: visible } = await ctx.newPerson({ ownerId: user.id });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: hidden.personGroupId });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: visible.personGroupId });

      const auth = factory.auth({ user });

      await expect(sut.getAll(auth, { page: 1, size: 10, isHidden: true })).resolves.toEqual(
        expect.objectContaining({ people: [expect.objectContaining({ id: hidden.personGroupId })], total: 1 }),
      );
      await expect(sut.getAll(auth, { page: 1, size: 10, isHidden: false })).resolves.toEqual(
        expect.objectContaining({ people: [expect.objectContaining({ id: visible.personGroupId })], total: 1 }),
      );
    });
  });

  describe('getById', () => {
    it('should require person.read access', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });

      await expect(sut.getById(factory.auth(), person.personGroupId)).rejects.toThrow(
        'Not found or no person.read access',
      );
    });

    it('should return own version of shared person but copy over a shared name and birth date', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user2.id, name: "User2's person", birthDate: new Date() });
      await ctx.newPersonUser({ personGroupId: person.personGroupId, sharedById: user2.id, sharedWithId: user.id });

      await expect(sut.getById(factory.auth({ user }), person.personGroupId)).resolves.toEqual(
        expect.objectContaining({
          id: person.personGroupId,
          name: person.name,
          birthDate: expect.any(String),
          otherPeople: [expect.objectContaining({ sharedById: user2.id })],
        }),
      );
    });

    it('should include the users the person is shared by and shared with', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: user1 } = await ctx.newUser({ clusterGroupId: owner.clusterGroupId });
      const { person } = await ctx.newPerson({ ownerId: owner.id });
      await ctx.newPersonUser({
        personGroupId: person.personGroupId,
        sharedById: owner.id,
        sharedWithId: user1.id,
        role: PersonUserRole.Write,
      });

      await expect(sut.getById(factory.auth({ user: owner }), person.personGroupId)).resolves.toEqual(
        expect.objectContaining({
          sharedBy: [],
          sharedWith: [expect.objectContaining({ id: user1.id, email: user1.email, role: PersonUserRole.Write })],
        }),
      );
      await expect(sut.getById(factory.auth({ user: user1 }), person.personGroupId)).resolves.toEqual(
        expect.objectContaining({
          sharedBy: [expect.objectContaining({ id: owner.id, email: owner.email, role: PersonUserRole.Write })],
          sharedWith: [],
        }),
      );
    });
  });

  describe('getThumbnail', () => {
    it('should require person.read access', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });

      await expect(sut.getThumbnail(factory.auth(), person.personGroupId)).rejects.toThrow(
        'Not found or no person.read access',
      );
    });

    it('should return own thumbnail path when its source face is verifiable', async () => {
      const { ctx, sut } = setup(await isolatedDb());
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { face } = await newFaceOn(ctx, { ownerId: user.id, personGroupId: person.personGroupId });
      await publishPair(ctx, {
        ownerId: user.id,
        personGroupId: person.personGroupId,
        faceId: face.id,
        path: '/own.jpeg',
      });

      await expect(sut.getThumbnail(factory.auth({ user }), person.personGroupId)).resolves.toEqual(
        expect.objectContaining({ path: '/own.jpeg' }),
      );
    });

    it('should fall back to a shared thumbnail path only when its source passes the check', async () => {
      const { ctx, sut } = setup(await isolatedDb());
      const { user } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user2.id, thumbnailPath: '' });
      const { face } = await newFaceOn(ctx, { ownerId: user2.id, personGroupId: person.personGroupId });
      await publishPair(ctx, {
        ownerId: user2.id,
        personGroupId: person.personGroupId,
        faceId: face.id,
        path: '/shared.jpeg',
      });
      await ctx.newPersonUser({ personGroupId: person.personGroupId, sharedById: user2.id, sharedWithId: user.id });

      await expect(sut.getThumbnail(factory.auth({ user }), person.personGroupId)).resolves.toEqual(
        expect.objectContaining({ path: '/shared.jpeg' }),
      );

      // an unverifiable shared candidate (no recorded source) is never served
      await publishPair(ctx, {
        ownerId: user2.id,
        personGroupId: person.personGroupId,
        faceId: null,
        path: '/shared.jpeg',
      });
      await expect(sut.getThumbnail(factory.auth({ user }), person.personGroupId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('should fail if there is no (shared) thumbnail available', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id, thumbnailPath: undefined });
      await ctx.newPerson({ ownerId: user2.id, personGroupId: person.personGroupId });

      await expect(sut.getThumbnail(factory.auth({ user }), person.personGroupId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('should throw an error when there is no access', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user2.id });

      await expect(sut.update(factory.auth({ user }), person.personGroupId, { name: 'New name' })).rejects.toThrow(
        'Not found or no person.update access',
      );
    });

    it('should update the name and birth date for every user with write access', async () => {
      const { ctx, sut } = setup();
      const personRepo = ctx.get(PersonRepository);
      const { user } = await ctx.newUser();
      const { user: writer } = await ctx.newUser();
      const { user: reader } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: writer.id, name: 'Old name' });
      const { personGroupId } = person;
      await ctx.newPerson({ ownerId: reader.id, personGroupId, name: 'Old name' });
      await ctx.newPersonUser({
        personGroupId,
        sharedById: writer.id,
        sharedWithId: user.id,
        role: PersonUserRole.Write,
      });
      await ctx.newPersonUser({
        personGroupId,
        sharedById: reader.id,
        sharedWithId: user.id,
        role: PersonUserRole.Read,
      });

      await expect(
        sut.update(factory.auth({ user }), personGroupId, { name: 'New name', birthDate: '2000-01-01' }),
      ).resolves.toEqual(expect.objectContaining({ name: 'New name', birthDate: '2000-01-01' }));

      await expect(personRepo.getByGroupId({ ownerId: user.id, personGroupId })).resolves.toEqual(
        expect.objectContaining({ name: 'New name', birthDate: new Date('2000-01-01') }),
      );
      await expect(personRepo.getByGroupId({ ownerId: writer.id, personGroupId })).resolves.toEqual(
        expect.objectContaining({ name: 'New name', birthDate: new Date('2000-01-01') }),
      );
      await expect(personRepo.getByGroupId({ ownerId: reader.id, personGroupId })).resolves.toEqual(
        expect.objectContaining({ name: 'Old name', birthDate: null }),
      );
    });

    it('should only update the specified user when userId is provided', async () => {
      const { ctx, sut } = setup();
      const personRepo = ctx.get(PersonRepository);
      const { user } = await ctx.newUser();
      const { user: writer } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: writer.id, name: 'Old name' });
      const { personGroupId } = person;
      await ctx.newPersonUser({
        personGroupId,
        sharedById: writer.id,
        sharedWithId: user.id,
        role: PersonUserRole.Write,
      });

      await expect(
        sut.update(factory.auth({ user }), personGroupId, { name: 'New name', userId: writer.id }),
      ).resolves.toEqual(expect.objectContaining({ name: 'New name' }));

      await expect(personRepo.getByGroupId({ ownerId: writer.id, personGroupId })).resolves.toEqual(
        expect.objectContaining({ name: 'New name' }),
      );
      await expect(personRepo.getByGroupId({ ownerId: user.id, personGroupId })).resolves.toEqual(
        expect.objectContaining({ name: 'Old name' }),
      );
    });

    it('should only update personal properties for the current user', async () => {
      const { ctx, sut } = setup();
      const personRepo = ctx.get(PersonRepository);
      const { user } = await ctx.newUser();
      const { user: writer } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: writer.id, name: 'Old name' });
      const { personGroupId } = person;
      await ctx.newPersonUser({
        personGroupId,
        sharedById: writer.id,
        sharedWithId: user.id,
        role: PersonUserRole.Write,
      });

      await expect(
        sut.update(factory.auth({ user }), personGroupId, { name: 'New name', isFavorite: true, isHidden: true }),
      ).resolves.toEqual(expect.objectContaining({ name: 'New name', isFavorite: true, isHidden: true }));

      await expect(personRepo.getByGroupId({ ownerId: writer.id, personGroupId })).resolves.toEqual(
        expect.objectContaining({ name: 'New name', isFavorite: false, isHidden: false }),
      );
    });

    it('should not allow personal properties to be updated for another user', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: writer } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: writer.id });
      const { personGroupId } = person;
      await ctx.newPersonUser({
        personGroupId,
        sharedById: writer.id,
        sharedWithId: user.id,
        role: PersonUserRole.Write,
      });

      await expect(
        sut.update(factory.auth({ user }), personGroupId, { isFavorite: true, userId: writer.id }),
      ).rejects.toThrow('Only name and birthDate can be updated for other users');
    });
  });

  describe('delete', () => {
    it('should throw an error when there is no access', async () => {
      const { sut } = setup();
      const auth = factory.auth();
      const personId = factory.uuid();
      await expect(sut.delete(auth, personId, {})).rejects.toThrow('Not found or no person.delete access');
    });

    it('should delete the person', async () => {
      const { sut, ctx } = setup();
      const personRepo = ctx.get(PersonRepository);
      const storageMock = ctx.getMock(StorageRepository);
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id, thumbnailPath: `/thumbs/${factory.uuid()}.jpeg` });
      const auth = factory.auth({ user });
      storageMock.unlink.mockResolvedValue();

      await expect(personRepo.getByGroupId(person)).resolves.toEqual(
        expect.objectContaining({ personGroupId: person.personGroupId }),
      );
      await expect(sut.delete(auth, person.personGroupId, {})).resolves.toBeUndefined();
      await expect(personRepo.getByGroupId(person)).resolves.toBeUndefined();

      expect(storageMock.unlink).toHaveBeenCalledWith(person.thumbnailPath);
    });
  });

  describe('deleteAll', () => {
    it('should throw an error when there is no access', async () => {
      const { sut } = setup();
      const auth = factory.auth();
      const personId = factory.uuid();
      await expect(sut.deleteAll(auth, { ids: [personId] })).rejects.toThrow('Not found or no person.delete access');
    });

    it('should delete the person', async () => {
      const { sut, ctx } = setup();
      const storageMock = ctx.getMock(StorageRepository);
      const personRepo = ctx.get(PersonRepository);
      const { user } = await ctx.newUser();
      const { person: person1 } = await ctx.newPerson({
        ownerId: user.id,
        thumbnailPath: `/thumbs/${factory.uuid()}.jpeg`,
      });
      const { person: person2 } = await ctx.newPerson({
        ownerId: user.id,
        thumbnailPath: `/thumbs/${factory.uuid()}.jpeg`,
      });
      const auth = factory.auth({ user });
      storageMock.unlink.mockResolvedValue();

      await expect(
        sut.deleteAll(auth, { ids: [person1.personGroupId, person2.personGroupId] }),
      ).resolves.toBeUndefined();
      await expect(personRepo.getByGroupId(person1)).resolves.toBeUndefined();
      await expect(personRepo.getByGroupId(person2)).resolves.toBeUndefined();

      expect(storageMock.unlink).toHaveBeenCalledTimes(2);
      expect(storageMock.unlink).toHaveBeenCalledWith(person1.thumbnailPath);
      expect(storageMock.unlink).toHaveBeenCalledWith(person2.thumbnailPath);
    });

    it('should not unlink a thumbnail file that another person row still references', async () => {
      const { sut, ctx } = setup();
      const storageMock = ctx.getMock(StorageRepository);
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const path = `/thumbs/${factory.uuid()}.jpeg`;
      const { person } = await ctx.newPerson({ ownerId: user.id, thumbnailPath: path });
      await ctx.newPerson({ ownerId: other.id, thumbnailPath: path });
      storageMock.unlink.mockResolvedValue();

      await sut.deleteAll(factory.auth({ user }), { ids: [person.personGroupId] });
      expect(storageMock.unlink).not.toHaveBeenCalled();
    });
  });

  describe('handleDetectFaces', () => {
    it('should prefer an edited preview file', async () => {
      const { sut, ctx } = setup();
      const config = await ctx.getConfig();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: '' });
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        isEdited: true,
        path: 'edited_file.jpg',
      });
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        isEdited: false,
        path: 'unedited_file.jpg',
      });
      ctx
        .getMock(MachineLearningRepository)
        .detectFaces.mockResolvedValue({ imageHeight: 42, imageWidth: 69, faces: [] });

      await sut.handleDetectFaces({ id: asset.id });

      expect(ctx.getMock(MachineLearningRepository).detectFaces).toHaveBeenCalledWith(
        'edited_file.jpg',
        config.machineLearning.facialRecognition,
      );
    });
  });

  describe('handleQueueRecognizeFaces', () => {
    it('should delete all people and queue faces for recognition', async () => {
      const { sut, ctx } = setup();
      const jobRepo = ctx.getMock(JobRepository);
      ctx.getMock(StorageRepository).unlink.mockResolvedValue();
      jobRepo.waitForQueueCompletion.mockResolvedValue();
      jobRepo.getJobCounts.mockResolvedValue({ active: 0, waiting: 0, completed: 0, delayed: 0, failed: 0, paused: 0 });
      jobRepo.queueAll.mockResolvedValue();

      const { user } = await ctx.newUser();
      const { user: user1 } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: assetUser1 } = await ctx.newAsset({ ownerId: user1.id });
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { person: personUser1 } = await ctx.newPerson({ ownerId: user1.id });
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
      const { assetFace: assetFaceUser1 } = await ctx.newAssetFace({
        assetId: assetUser1.id,
        personGroupId: personUser1.personGroupId,
      });

      await sut.handleQueueRecognizeFaces({ force: true });

      await expect(ctx.database.selectFrom('person').selectAll().execute()).resolves.toHaveLength(0);
      expect(jobRepo.queueAll).toHaveBeenCalledWith(
        expect.objectContaining([
          { name: JobName.FacialRecognition, data: { id: assetFace.id, deferred: false } },
          { name: JobName.FacialRecognition, data: { id: assetFaceUser1.id, deferred: false } },
        ]),
      );
    });

    it('should only delete all people of a specified cluster group and queue their faces for recognition', async () => {
      const { sut, ctx } = setup();
      const jobRepo = ctx.getMock(JobRepository);
      ctx.getMock(StorageRepository).unlink.mockResolvedValue();
      jobRepo.waitForQueueCompletion.mockResolvedValue();
      jobRepo.getJobCounts.mockResolvedValue({ active: 0, waiting: 0, completed: 0, delayed: 0, failed: 0, paused: 0 });
      jobRepo.queueAll.mockResolvedValue();

      const { user } = await ctx.newUser();
      const { user: user1 } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: assetUser1 } = await ctx.newAsset({ ownerId: user1.id });
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { person: personUser1 } = await ctx.newPerson({ ownerId: user1.id });
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
      const { assetFace: assetFaceUser1 } = await ctx.newAssetFace({
        assetId: assetUser1.id,
        personGroupId: personUser1.personGroupId,
      });

      await sut.handleQueueRecognizeFaces({ force: true, clusterGroupId: user.clusterGroupId });

      await expect(ctx.database.selectFrom('person').selectAll().execute()).resolves.toHaveLength(1);
      expect(jobRepo.queueAll).toHaveBeenCalledWith(
        expect.objectContaining([{ name: JobName.FacialRecognition, data: { id: assetFace.id, deferred: false } }]),
      );
      expect(jobRepo.queueAll).not.toHaveBeenCalledWith(
        expect.objectContaining([
          { name: JobName.FacialRecognition, data: { id: assetFace.id, deferred: false } },
          { name: JobName.FacialRecognition, data: { id: assetFaceUser1.id, deferred: false } },
        ]),
      );
    });
  });

  describe('mergePeople', () => {
    it('should merge people of multiple users', async () => {
      const { sut, ctx } = setup();
      const storageMock = ctx.getMock(StorageRepository);
      const { user: user1 } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser({ clusterGroupId: user1.clusterGroupId });
      const { person: person1 } = await ctx.newPerson({ ownerId: user1.id, name: undefined });
      const { person: person2 } = await ctx.newPerson({ ownerId: user1.id });
      await ctx.newPerson({
        ownerId: user2.id,
        personGroupId: person1.personGroupId,
      });
      await ctx.newPerson({
        ownerId: user2.id,
        personGroupId: person2.personGroupId,
        name: undefined,
      });
      const { asset } = await ctx.newAsset({ ownerId: user2.id });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: person2.personGroupId });
      storageMock.unlink.mockResolvedValue();

      const auth = factory.auth({ user: user1 });

      await sut.mergePeople(auth, { ids: [person1.personGroupId, person2.personGroupId] });
      const user1People = await Array.fromAsync(ctx.get(PersonRepository).getAll({ ownerId: user1.id }));
      const user2People = await Array.fromAsync(ctx.get(PersonRepository).getAll({ ownerId: user2.id }));
      expect(user1People).toEqual([expect.objectContaining({ personGroupId: person1.personGroupId })]);
      expect(user2People).toEqual([expect.objectContaining({ personGroupId: person1.personGroupId })]);
      await expect(ctx.get(PersonRepository).getFaces(asset.id, { viewingUserId: asset.ownerId })).resolves.toEqual([
        expect.objectContaining({ personGroupId: person1.personGroupId }),
      ]);
    });

    it('should skip people with a different name', async () => {
      const { sut, ctx } = setup();
      const storageMock = ctx.getMock(StorageRepository);
      const { user: user1 } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser({ clusterGroupId: user1.clusterGroupId });
      const { person: person1 } = await ctx.newPerson({ ownerId: user1.id });
      const { person: person2 } = await ctx.newPerson({ ownerId: user1.id });
      await ctx.newPerson({
        ownerId: user2.id,
        personGroupId: person1.personGroupId,
        name: 'Person 1',
      });
      await ctx.newPerson({
        ownerId: user2.id,
        personGroupId: person2.personGroupId,
        name: 'Person 2',
      });
      storageMock.unlink.mockResolvedValue();

      const auth = factory.auth({ user: user1 });

      await sut.mergePeople(auth, { ids: [person1.personGroupId, person2.personGroupId] });
      const user1People = await Array.fromAsync(ctx.get(PersonRepository).getAll({ ownerId: user1.id }));
      const user2People = await Array.fromAsync(ctx.get(PersonRepository).getAll({ ownerId: user2.id }));
      expect(user1People).toEqual([expect.objectContaining({ personGroupId: person1.personGroupId })]);
      expect(user2People).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ personGroupId: person1.personGroupId }),
          expect.objectContaining({ personGroupId: person2.personGroupId }),
        ]),
      );
    });

    it('should skip people with a different birth date', async () => {
      const { sut, ctx } = setup();
      const storageMock = ctx.getMock(StorageRepository);
      const { user: user1 } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser({ clusterGroupId: user1.clusterGroupId });
      const { person: person1 } = await ctx.newPerson({ ownerId: user1.id });
      const { person: person2 } = await ctx.newPerson({ ownerId: user1.id });
      await ctx.newPerson({
        ownerId: user2.id,
        personGroupId: person1.personGroupId,
        birthDate: DateTime.now().minus({ years: 1 }).toJSDate(),
      });
      await ctx.newPerson({
        ownerId: user2.id,
        personGroupId: person2.personGroupId,
        birthDate: DateTime.now().minus({ years: 2 }).toJSDate(),
      });
      storageMock.unlink.mockResolvedValue();

      const auth = factory.auth({ user: user1 });

      await sut.mergePeople(auth, { ids: [person1.personGroupId, person2.personGroupId] });
      const user1People = await Array.fromAsync(ctx.get(PersonRepository).getAll({ ownerId: user1.id }));
      const user2People = await Array.fromAsync(ctx.get(PersonRepository).getAll({ ownerId: user2.id }));
      expect(user1People).toEqual([expect.objectContaining({ personGroupId: person1.personGroupId })]);
      expect(user2People).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ personGroupId: person1.personGroupId }),
          expect.objectContaining({ personGroupId: person2.personGroupId }),
        ]),
      );
    });
  });

  describe('createFace', () => {
    it('should store and retrieve the face as-is when there are no edits', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 200, height: 200 });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 200, exifImageWidth: 200 });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 200,
        imageHeight: 200,
        x: 50,
        y: 50,
        width: 150,
        height: 150,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      // retrieve an asset's faces
      const faces = sut.getFacesById(auth, { id: asset.id });

      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 50,
            boundingBoxY1: 50,
            boundingBoxX2: 200,
            boundingBoxY2: 200,
          }),
        ]),
      );
    });

    it('should properly transform the coordinates when the asset is edited (Crop)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 150, height: 200 });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 200, exifImageWidth: 200 });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      await ctx.newEdits(asset.id, {
        edits: [
          {
            action: AssetEditAction.Crop,
            parameters: {
              x: 50,
              y: 50,
              width: 150,
              height: 200,
            },
          },
        ],
      });

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 150,
        imageHeight: 200,
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      // retrieve an asset's faces
      const faces = sut.getFacesById(auth, { id: asset.id });

      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 0,
            boundingBoxY1: 0,
            boundingBoxX2: 100,
            boundingBoxY2: 100,
          }),
        ]),
      );

      // remove edits and verify the stored coordinates map to the original image
      await ctx.newEdits(asset.id, { edits: [] });

      const facesAfterRemovingEdits = sut.getFacesById(auth, { id: asset.id });

      await expect(facesAfterRemovingEdits).resolves.toHaveLength(1);
      await expect(facesAfterRemovingEdits).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 50,
            boundingBoxY1: 50,
            boundingBoxX2: 150,
            boundingBoxY2: 150,
          }),
        ]),
      );
    });

    it('should properly transform the coordinates when the asset is edited (Rotate 90)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 100, height: 200 });
      await ctx.newExif({ assetId: asset.id, exifImageWidth: 200, exifImageHeight: 100 });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      await ctx.newEdits(asset.id, {
        edits: [
          {
            action: AssetEditAction.Rotate,
            parameters: {
              angle: 90,
            },
          },
        ],
      });

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 100,
        imageHeight: 200,
        x: 25,
        y: 50,
        width: 10,
        height: 10,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      const faces = sut.getFacesById(auth, { id: asset.id });
      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: expect.closeTo(25, 1),
            boundingBoxY1: expect.closeTo(50, 1),
            boundingBoxX2: expect.closeTo(35, 1),
            boundingBoxY2: expect.closeTo(60, 1),
          }),
        ]),
      );

      // remove edits and verify the stored coordinates map to the original image
      await ctx.newEdits(asset.id, { edits: [] });
      const facesAfterRemovingEdits = sut.getFacesById(auth, { id: asset.id });

      await expect(facesAfterRemovingEdits).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 50,
            boundingBoxY1: 65,
            boundingBoxX2: 60,
            boundingBoxY2: 75,
          }),
        ]),
      );
    });

    it('should properly transform the coordinates when the asset is edited (Mirror Horizontal)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 200, height: 100 });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 100, exifImageWidth: 200 });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      await ctx.newEdits(asset.id, {
        edits: [
          {
            action: AssetEditAction.Mirror,
            parameters: {
              axis: MirrorAxis.Horizontal,
            },
          },
        ],
      });

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 200,
        imageHeight: 100,
        x: 50,
        y: 25,
        width: 100,
        height: 50,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      const faces = sut.getFacesById(auth, { id: asset.id });
      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 50,
            boundingBoxY1: 25,
            boundingBoxX2: 150,
            boundingBoxY2: 75,
          }),
        ]),
      );

      // remove edits and verify the stored coordinates map to the original image
      await ctx.newEdits(asset.id, { edits: [] });
      const facesAfterRemovingEdits = sut.getFacesById(auth, { id: asset.id });

      await expect(facesAfterRemovingEdits).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 50,
            boundingBoxY1: 25,
            boundingBoxX2: 150,
            boundingBoxY2: 75,
          }),
        ]),
      );
    });

    it('should properly transform the coordinates when the asset is edited (Crop + Rotate)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 200, height: 150 });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 200, exifImageWidth: 200 });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      await ctx.newEdits(asset.id, {
        edits: [
          {
            action: AssetEditAction.Crop,
            parameters: {
              x: 50,
              y: 0,
              width: 150,
              height: 200,
            },
          },
          {
            action: AssetEditAction.Rotate,
            parameters: {
              angle: 90,
            },
          },
        ],
      });

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 200,
        imageHeight: 150,
        x: 50,
        y: 25,
        width: 10,
        height: 20,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      const faces = sut.getFacesById(auth, { id: asset.id });
      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: expect.closeTo(50, 1),
            boundingBoxY1: expect.closeTo(25, 1),
            boundingBoxX2: expect.closeTo(60, 1),
            boundingBoxY2: expect.closeTo(45, 1),
          }),
        ]),
      );

      // remove edits and verify the stored coordinates map to the original image
      await ctx.newEdits(asset.id, { edits: [] });
      const facesAfterRemovingEdits = sut.getFacesById(auth, { id: asset.id });

      await expect(facesAfterRemovingEdits).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 75,
            boundingBoxY1: 140,
            boundingBoxX2: 95,
            boundingBoxY2: 150,
          }),
        ]),
      );
    });

    it('should properly transform the coordinates when the asset is edited (Crop + Mirror)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 150, height: 100 });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 100, exifImageWidth: 200 });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      await ctx.newEdits(asset.id, {
        edits: [
          {
            action: AssetEditAction.Crop,
            parameters: {
              x: 50,
              y: 0,
              width: 150,
              height: 100,
            },
          },
          {
            action: AssetEditAction.Mirror,
            parameters: {
              axis: MirrorAxis.Horizontal,
            },
          },
        ],
      });

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 150,
        imageHeight: 100,
        x: 25,
        y: 25,
        width: 75,
        height: 50,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      const faces = sut.getFacesById(auth, { id: asset.id });
      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 25,
            boundingBoxY1: 25,
            boundingBoxX2: 100,
            boundingBoxY2: 75,
          }),
        ]),
      );

      // remove edits and verify the stored coordinates map to the original image
      await ctx.newEdits(asset.id, { edits: [] });
      const facesAfterRemovingEdits = sut.getFacesById(auth, { id: asset.id });

      await expect(facesAfterRemovingEdits).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 100,
            boundingBoxY1: 25,
            boundingBoxX2: 175,
            boundingBoxY2: 75,
          }),
        ]),
      );
    });

    it('should properly transform the coordinates when the asset is edited (Rotate + Mirror)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 200, height: 150 });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 200, exifImageWidth: 150 });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      await ctx.newEdits(asset.id, {
        edits: [
          {
            action: AssetEditAction.Rotate,
            parameters: {
              angle: 90,
            },
          },
          {
            action: AssetEditAction.Mirror,
            parameters: {
              axis: MirrorAxis.Horizontal,
            },
          },
        ],
      });

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 200,
        imageHeight: 150,
        x: 50,
        y: 25,
        width: 15,
        height: 20,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      const faces = sut.getFacesById(auth, { id: asset.id });
      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: expect.closeTo(50, 1),
            boundingBoxY1: expect.closeTo(25, 1),
            boundingBoxX2: expect.closeTo(65, 1),
            boundingBoxY2: expect.closeTo(45, 1),
          }),
        ]),
      );

      // remove edits and verify the stored coordinates map to the original image
      await ctx.newEdits(asset.id, { edits: [] });
      const facesAfterRemovingEdits = sut.getFacesById(auth, { id: asset.id });

      await expect(facesAfterRemovingEdits).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 25,
            boundingBoxY1: 50,
            boundingBoxX2: 45,
            boundingBoxY2: 65,
          }),
        ]),
      );
    });

    it('should properly transform the coordinates when the asset is edited (Crop + Rotate + Mirror)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 150, height: 100 });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 200, exifImageWidth: 200 });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      await ctx.newEdits(asset.id, {
        edits: [
          {
            action: AssetEditAction.Crop,
            parameters: {
              x: 50,
              y: 25,
              width: 100,
              height: 150,
            },
          },
          {
            action: AssetEditAction.Rotate,
            parameters: {
              angle: 270,
            },
          },
          {
            action: AssetEditAction.Mirror,
            parameters: {
              axis: MirrorAxis.Horizontal,
            },
          },
        ],
      });

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 150,
        imageHeight: 150,
        x: 25,
        y: 50,
        width: 75,
        height: 50,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      const faces = sut.getFacesById(auth, { id: asset.id });
      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 25,
            boundingBoxY1: 49,
            boundingBoxX2: 99,
            boundingBoxY2: 100,
          }),
        ]),
      );

      // remove edits and verify the stored coordinates map to the original image
      await ctx.newEdits(asset.id, { edits: [] });
      const facesAfterRemovingEdits = sut.getFacesById(auth, { id: asset.id });

      await expect(facesAfterRemovingEdits).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 50,
            boundingBoxY1: 75,
            boundingBoxX2: 100,
            boundingBoxY2: 150,
          }),
        ]),
      );
    });

    it('should properly transform the coordinates with multiple mirrors in sequence', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 100, height: 100 });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 100, exifImageWidth: 100 });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      await ctx.newEdits(asset.id, {
        edits: [
          {
            action: AssetEditAction.Mirror,
            parameters: {
              axis: MirrorAxis.Horizontal,
            },
          },
          {
            action: AssetEditAction.Mirror,
            parameters: {
              axis: MirrorAxis.Vertical,
            },
          },
        ],
      });

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 100,
        imageHeight: 100,
        x: 10,
        y: 10,
        width: 80,
        height: 80,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      const faces = sut.getFacesById(auth, { id: asset.id });
      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 10,
            boundingBoxY1: 10,
            boundingBoxX2: 90,
            boundingBoxY2: 90,
          }),
        ]),
      );

      // remove edits and verify the stored coordinates map to the original image
      await ctx.newEdits(asset.id, { edits: [] });
      const facesAfterRemovingEdits = sut.getFacesById(auth, { id: asset.id });

      await expect(facesAfterRemovingEdits).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 10,
            boundingBoxY1: 10,
            boundingBoxX2: 90,
            boundingBoxY2: 90,
          }),
        ]),
      );
    });

    it('should properly handle exif orientation when creating a face on an edited asset', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 100, height: 100 });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 200, exifImageWidth: 100, orientation: '6' });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      await ctx.newEdits(asset.id, {
        edits: [
          {
            action: AssetEditAction.Mirror,
            parameters: {
              axis: MirrorAxis.Horizontal,
            },
          },
          {
            action: AssetEditAction.Mirror,
            parameters: {
              axis: MirrorAxis.Vertical,
            },
          },
        ],
      });

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 100,
        imageHeight: 100,
        x: 10,
        y: 10,
        width: 80,
        height: 80,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      const faces = sut.getFacesById(auth, { id: asset.id });
      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 110,
            boundingBoxY1: 10,
            boundingBoxX2: 190,
            boundingBoxY2: 90,
          }),
        ]),
      );

      // remove edits and verify the stored coordinates map to the original image
      await ctx.newEdits(asset.id, { edits: [] });
      const facesAfterRemovingEdits = sut.getFacesById(auth, { id: asset.id });

      await expect(facesAfterRemovingEdits).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 10,
            boundingBoxY1: 10,
            boundingBoxX2: 90,
            boundingBoxY2: 90,
          }),
        ]),
      );
    });
  });

  describe('upsertPeopleUsers', () => {
    it('should throw error for sharedWith users that are not in the same cluster group', async () => {
      const { sut, ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: user1 } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: owner.id });
      const auth = factory.auth({ user: owner });

      await expect(
        sut.upsertPeopleUsers(auth, {
          personIds: [person.personGroupId],
          sharedWithIds: [user1.id],
          role: PersonUserRole.Read,
        }),
      ).rejects.toThrow('All users must be in the same cluster group');

      await expect(sut.getUsersForPeople(auth, {})).resolves.toHaveLength(0);
    });

    it('should add user to person', async () => {
      const { sut, ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: user1 } = await ctx.newUser({ clusterGroupId: owner.clusterGroupId });
      const { person } = await ctx.newPerson({ ownerId: owner.id });
      const auth = factory.auth({ user: owner });

      await sut.upsertPeopleUsers(auth, {
        personIds: [person.personGroupId],
        sharedWithIds: [user1.id],
        role: PersonUserRole.Read,
      });

      await expect(sut.getUsersForPeople(auth, {})).resolves.toEqual([
        expect.objectContaining({
          sharedBy: expect.objectContaining({ id: owner.id }),
          sharedWith: expect.objectContaining({ id: user1.id }),
        }),
      ]);
    });

    it('should update the name and birthdate when sharing to an existing copy', async () => {
      const { sut, ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: user1 } = await ctx.newUser({ clusterGroupId: owner.clusterGroupId });
      const { person } = await ctx.newPerson({ ownerId: owner.id, name: 'Owner name', birthDate: '1990-01-01' });
      await ctx.newPerson({ ownerId: user1.id, personGroupId: person.personGroupId, name: '', birthDate: null });

      await sut.upsertPeopleUsers(factory.auth({ user: owner }), {
        personIds: [person.personGroupId],
        sharedWithIds: [user1.id],
        role: PersonUserRole.Read,
      });

      await expect(sut.getById(factory.auth({ user: user1 }), person.personGroupId)).resolves.toEqual(
        expect.objectContaining({ name: 'Owner name', birthDate: '1990-01-01' }),
      );
    });

    it('should skip updating when sharing to an existing copy with values', async () => {
      const { sut, ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: user1 } = await ctx.newUser({ clusterGroupId: owner.clusterGroupId });
      const { person } = await ctx.newPerson({ ownerId: owner.id, name: 'Owner name', birthDate: '1990-01-01' });
      await ctx.newPerson({
        ownerId: user1.id,
        personGroupId: person.personGroupId,
        name: 'User1 name',
        birthDate: '2000-02-02',
      });

      await sut.upsertPeopleUsers(factory.auth({ user: owner }), {
        personIds: [person.personGroupId],
        sharedWithIds: [user1.id],
        role: PersonUserRole.Read,
      });

      await expect(sut.getById(factory.auth({ user: user1 }), person.personGroupId)).resolves.toEqual(
        expect.objectContaining({ name: 'User1 name', birthDate: '2000-02-02' }),
      );
    });
  });

  describe('removeUsersFromPeople', () => {
    it('should work with an empty list', async () => {
      const { sut, ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: sharedWith } = await ctx.newUser({ clusterGroupId: owner.clusterGroupId });
      const { person } = await ctx.newPerson({ ownerId: owner.id });
      const auth = factory.auth({ user: owner });

      await sut.upsertPeopleUsers(auth, {
        personIds: [person.personGroupId],
        sharedWithIds: [sharedWith.id],
        role: PersonUserRole.Read,
      });

      await sut.removeUsersFromPeople(auth, []);

      await expect(sut.getUsersForPeople(auth, {})).resolves.toHaveLength(1);
    });

    it('should throw an error when there is no access', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: owner } = await ctx.newUser({ clusterGroupId: user.clusterGroupId });
      const { person } = await ctx.newPerson({ ownerId: owner.id });
      const auth = factory.auth({ user });

      await expect(
        sut.removeUsersFromPeople(auth, [{ personId: person.personGroupId, sharedWithId: user.id }]),
      ).rejects.toThrow('Not found or no person.update access');
    });

    it('should delete only the requested person and user pairs', async () => {
      const { sut, ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: user1 } = await ctx.newUser({ clusterGroupId: owner.clusterGroupId });
      const { user: user2 } = await ctx.newUser({ clusterGroupId: owner.clusterGroupId });
      const { person: person1 } = await ctx.newPerson({ ownerId: owner.id });
      const { person: person2 } = await ctx.newPerson({ ownerId: owner.id });
      const auth = factory.auth({ user: owner });

      await sut.upsertPeopleUsers(auth, {
        personIds: [person1.personGroupId, person2.personGroupId],
        sharedWithIds: [user1.id, user2.id],
        role: PersonUserRole.Read,
      });

      await expect(sut.getUsersForPeople(auth, {})).resolves.toHaveLength(4);

      await sut.removeUsersFromPeople(auth, [
        { personId: person1.personGroupId, sharedWithId: user1.id },
        { personId: person2.personGroupId, sharedWithId: user2.id },
      ]);

      const shares = await sut.getUsersForPeople(auth, {});
      expect(shares).toHaveLength(2);
      expect(shares).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ personId: person1.personGroupId, sharedWithId: user2.id }),
          expect.objectContaining({ personId: person2.personGroupId, sharedWithId: user1.id }),
        ]),
      );
    });

    it('should not delete the same pair shared by another user', async () => {
      const { sut, ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: otherOwner } = await ctx.newUser({ clusterGroupId: owner.clusterGroupId });
      const { user: sharedWith } = await ctx.newUser({ clusterGroupId: owner.clusterGroupId });
      const { person } = await ctx.newPerson({ ownerId: owner.id });
      await ctx.newPerson({ ownerId: otherOwner.id, personGroupId: person.personGroupId });

      const auth = factory.auth({ user: owner });
      const otherAuth = factory.auth({ user: otherOwner });
      const dto = { personIds: [person.personGroupId], sharedWithIds: [sharedWith.id], role: PersonUserRole.Read };

      await sut.upsertPeopleUsers(auth, dto);
      await sut.upsertPeopleUsers(otherAuth, dto);

      await sut.removeUsersFromPeople(auth, [{ personId: person.personGroupId, sharedWithId: sharedWith.id }]);

      await expect(sut.getUsersForPeople(auth, {})).resolves.toEqual([]);
      await expect(sut.getUsersForPeople(otherAuth, {})).resolves.toEqual([
        expect.objectContaining({ personId: person.personGroupId, sharedWithId: sharedWith.id }),
      ]);
    });
  });
  describe('shared people and locks', () => {
    it("sharee without own thumbnail does not get a shared thumbnail sourced from the sharer's locked album", async () => {
      const { ctx, sut } = setup();
      const { owner, sharee, personGroupId } = await newSharedPerson(ctx);
      const hidden = await newFaceOn(ctx, { ownerId: owner.id, personGroupId, locked: true });
      await publishPair(ctx, { ownerId: owner.id, personGroupId, faceId: hidden.face.id, path: '/owner-h.jpeg' });

      for (const [label, auth] of shareeAuths(sharee, [hidden.album.id])) {
        await expectWithheld(sut, auth, personGroupId, label);
      }
    });

    it('sharee with own visible thumbnail is served their own', async () => {
      const { ctx, sut } = setup();
      const { owner, sharee, personGroupId } = await newSharedPerson(ctx);
      const hidden = await newFaceOn(ctx, { ownerId: owner.id, personGroupId, locked: true });
      await publishPair(ctx, { ownerId: owner.id, personGroupId, faceId: hidden.face.id, path: '/owner-h.jpeg' });
      const own = await newFaceOn(ctx, { ownerId: sharee.id, personGroupId });
      await publishPair(ctx, { ownerId: sharee.id, personGroupId, faceId: own.face.id, path: '/sharee-own.jpeg' });

      for (const [label, auth] of shareeAuths(sharee, [hidden.album.id])) {
        await expectServed(sut, auth, personGroupId, '/sharee-own.jpeg', label);
      }
    });

    it('multiple sharers: falls back to a visible candidate when the first is hidden', async () => {
      const { ctx, sut } = setup();
      const { user: sharee } = await ctx.newUser();
      const { user: ownerA } = await ctx.newUser({ clusterGroupId: sharee.clusterGroupId });
      const { user: ownerB } = await ctx.newUser({ clusterGroupId: sharee.clusterGroupId });
      // shared candidates are ordered by owner id; make the first one the hidden one
      const [first, second] = [ownerA, ownerB].toSorted((a, b) => a.id.localeCompare(b.id));
      const { person } = await ctx.newPerson({ ownerId: first.id, thumbnailPath: '' });
      const personGroupId = person.personGroupId;
      await ctx.newPerson({ ownerId: second.id, personGroupId, thumbnailPath: '' });
      await ctx.newPersonUser({ personGroupId, sharedById: first.id, sharedWithId: sharee.id });
      await ctx.newPersonUser({ personGroupId, sharedById: second.id, sharedWithId: sharee.id });

      const hidden = await newFaceOn(ctx, { ownerId: first.id, personGroupId, locked: true });
      const visible = await newFaceOn(ctx, { ownerId: second.id, personGroupId });
      await publishPair(ctx, { ownerId: first.id, personGroupId, faceId: hidden.face.id, path: '/first.jpeg' });
      await publishPair(ctx, { ownerId: second.id, personGroupId, faceId: visible.face.id, path: '/second.jpeg' });

      for (const [label, auth] of shareeAuths(sharee, [hidden.album.id])) {
        await expectServed(sut, auth, personGroupId, '/second.jpeg', label);
      }
    });

    it("face sourced from a third cluster member honours that member's locks", async () => {
      const { ctx, sut } = setup();
      const { owner, sharee, personGroupId } = await newSharedPerson(ctx);
      const { user: member } = await ctx.newUser({ clusterGroupId: owner.clusterGroupId });
      const memberFace = await newFaceOn(ctx, { ownerId: member.id, personGroupId, locked: true });
      await publishPair(ctx, { ownerId: owner.id, personGroupId, faceId: memberFace.face.id, path: '/member.jpeg' });

      for (const [label, auth] of [
        ...shareeAuths(sharee, [memberFace.album.id]),
        ...shareeAuths(owner, [memberFace.album.id]),
      ]) {
        await expectWithheld(sut, auth, personGroupId, label);
      }

      await ctx.get(LockRepository).unlockAlbum(member.id, memberFace.album.id);
      for (const [label, auth] of [...shareeAuths(sharee, []), ...shareeAuths(owner, [])]) {
        await expectServed(sut, auth, personGroupId, '/member.jpeg', label);
      }
    });

    it('locking after thumbnail generation hides an already-generated shared thumbnail', async () => {
      const { ctx, sut } = setup();
      const { owner, sharee, personGroupId } = await newSharedPerson(ctx);
      const source = await newFaceOn(ctx, { ownerId: owner.id, personGroupId });
      await publishPair(ctx, { ownerId: owner.id, personGroupId, faceId: source.face.id, path: '/owner.jpeg' });

      for (const [label, auth] of shareeAuths(sharee, [source.album.id])) {
        await expectServed(sut, auth, personGroupId, '/owner.jpeg', label);
      }

      await ctx.get(LockRepository).lockAlbum(owner.id, source.album.id);
      for (const [label, auth] of shareeAuths(sharee, [source.album.id])) {
        await expectWithheld(sut, auth, personGroupId, label);
      }
    });

    it('source face deleted → unverifiable → 404 for the person-row owner too', async () => {
      const { ctx, sut } = setup();
      const { owner, sharee, personGroupId } = await newSharedPerson(ctx);
      const source = await newFaceOn(ctx, { ownerId: owner.id, personGroupId });
      await publishPair(ctx, { ownerId: owner.id, personGroupId, faceId: source.face.id, path: '/owner.jpeg' });
      await expectServed(sut, factory.auth({ user: owner }), personGroupId, '/owner.jpeg');

      await ctx.get(PersonRepository).deleteAssetFace(source.face.id);

      const row = await ctx.database
        .selectFrom('person')
        .select(['thumbnailPath', 'thumbnailSourceFaceId'])
        .where('ownerId', '=', owner.id)
        .where('personGroupId', '=', personGroupId)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ thumbnailPath: '/owner.jpeg', thumbnailSourceFaceId: null });

      for (const [label, auth] of [...shareeAuths(sharee, []), ...shareeAuths(owner, [])]) {
        await expectWithheld(sut, auth, personGroupId, label);
      }
    });

    it('source face soft-deleted or edited out → unverifiable → 404 for everyone, and selected for regeneration', async () => {
      const { ctx, sut } = setup();
      const { owner, sharee, personGroupId } = await newSharedPerson(ctx);
      const personRepository = ctx.get(PersonRepository);
      const selected = async () => {
        const rows = await Array.fromAsync(personRepository.getAll({ withoutVerifiedThumbnail: true }));
        return rows.filter((row) => row.ownerId === owner.id).map(({ hasUsableFeatureFace }) => hasUsableFeatureFace);
      };

      for (const remove of [
        (faceId: string) => personRepository.softDeleteAssetFaces(faceId),
        (faceId: string) =>
          ctx.database.updateTable('asset_face').set({ isVisible: false }).where('id', '=', faceId).execute(),
      ]) {
        const source = await newFaceOn(ctx, { ownerId: owner.id, personGroupId });
        await publishPair(ctx, { ownerId: owner.id, personGroupId, faceId: source.face.id, path: '/owner.jpeg' });
        await ctx.database
          .updateTable('person')
          .set({ faceAssetId: source.face.id })
          .where('ownerId', '=', owner.id)
          .where('personGroupId', '=', personGroupId)
          .execute();
        await expectServed(sut, factory.auth({ user: owner }), personGroupId, '/owner.jpeg');
        await expect(selected()).resolves.toEqual([]);

        // e.g. deleteFace without force: the provenance stays recorded but no longer vouches for the crop
        await remove(source.face.id);

        for (const [label, auth] of [...shareeAuths(sharee, []), ...shareeAuths(owner, [])]) {
          await expectWithheld(sut, auth, personGroupId, label);
        }
        // the stateless regeneration pass picks the row up, and re-picks its unusable feature face
        await expect(selected()).resolves.toEqual([false]);
      }
    });

    it("sharer's reveal never reveals to the sharee", async () => {
      const { ctx, sut } = setup();
      const { owner, sharee, personGroupId } = await newSharedPerson(ctx);
      const hidden = await newFaceOn(ctx, { ownerId: owner.id, personGroupId, locked: true });
      await publishPair(ctx, { ownerId: owner.id, personGroupId, faceId: hidden.face.id, path: '/owner-h.jpeg' });

      const ownerRevealing = {
        ...factory.auth({ user: owner, session: { hasElevatedPermission: true } }),
        revealedLocks: { albumIds: [hidden.album.id], containerIds: [] },
      };
      // the sharer's own reveal applies to the sharer, in an elevated session only
      await expectServed(sut, ownerRevealing, personGroupId, '/owner-h.jpeg', 'owner revealing');
      await expectWithheld(sut, factory.auth({ user: owner }), personGroupId, 'owner non-elevated');
      await expectWithheld(
        sut,
        { ...factory.auth({ user: owner }), revealedLocks: { albumIds: [hidden.album.id], containerIds: [] } },
        personGroupId,
        'owner reveal without elevation',
      );

      for (const [label, auth] of shareeAuths(sharee, [hidden.album.id])) {
        await expectWithheld(sut, auth, personGroupId, label);
      }
    });

    it("sharee's own locks never hide the sharer's view", async () => {
      const { ctx, sut } = setup();
      const { owner, sharee, personGroupId } = await newSharedPerson(ctx);
      const source = await newFaceOn(ctx, { ownerId: owner.id, personGroupId });
      await publishPair(ctx, { ownerId: owner.id, personGroupId, faceId: source.face.id, path: '/owner.jpeg' });
      // the sharer's album is shared with the sharee, who locks it for themselves
      await ctx.newAlbumUser({ albumId: source.album.id, userId: sharee.id });
      await ctx.get(LockRepository).lockAlbum(sharee.id, source.album.id);

      for (const [label, auth] of shareeAuths(owner, [])) {
        await expectServed(sut, auth, personGroupId, '/owner.jpeg', label);
      }
      await expect(sut.getStatistics(factory.auth({ user: owner }), personGroupId)).resolves.toEqual({ assets: 1 });
    });

    it("person sharing does not grant browsing the sharer's library", async () => {
      const { ctx, sut } = setup();
      const { owner, sharee, personGroupId } = await newSharedPerson(ctx);
      const { user: partner } = await ctx.newUser({ clusterGroupId: owner.clusterGroupId });
      const { user: stranger } = await ctx.newUser({ clusterGroupId: owner.clusterGroupId });
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: sharee.id });

      // out of scope for the sharee: the sharer's private assets and a stranger's asset
      await newFaceOn(ctx, { ownerId: owner.id, personGroupId });
      await newFaceOn(ctx, { ownerId: owner.id, personGroupId });
      await newFaceOn(ctx, { ownerId: stranger.id, personGroupId });
      // in scope: own, partner, and an asset in an album the sharer shared with the sharee
      const own = await newFaceOn(ctx, { ownerId: sharee.id, personGroupId });
      const partnerFace = await newFaceOn(ctx, { ownerId: partner.id, personGroupId });
      const sharedAlbumFace = await newFaceOn(ctx, { ownerId: owner.id, personGroupId });
      await ctx.newAlbumUser({ albumId: sharedAlbumFace.album.id, userId: sharee.id });

      const faceCount = async (auth: AuthDto) => {
        const { people } = await sut.getAll(auth, { page: 1, size: 10, withHidden: true });
        expect(people.map(({ id }) => id)).toEqual([personGroupId]);
        const partnerIds = await getMyPartnerIds({ userId: auth.user.id, repository: ctx.get(PartnerRepository) });
        const lockVisibility = await ctx.get(LockRepository).getOwnerLockVisibility({
          viewerId: auth.user.id,
          ownerIds: [auth.user.id, ...partnerIds],
          revealed: auth.revealedLocks ?? { albumIds: [], containerIds: [] },
          isElevated: !!auth.session?.hasElevatedPermission,
        });
        const { items } = await ctx
          .get(PersonRepository)
          .getAllForUser({ take: 10, skip: 0 }, auth.user.id, { withHidden: true, partnerIds }, lockVisibility);
        return items[0]?.faceCount;
      };

      for (const [label, auth] of shareeAuths(sharee, [])) {
        await expect(sut.getStatistics(auth, personGroupId), label).resolves.toEqual({ assets: 3 });
        await expect(faceCount(auth), label).resolves.toBe(3);
      }

      // within that scope: own and partner faces follow their owner's locks; the shared-album face follows album-grant
      // rules, so the sharer locking the shared album changes nothing for the sharee (ruling R19)
      await ctx.get(LockRepository).lockAlbum(owner.id, sharedAlbumFace.album.id);
      await ctx.get(LockRepository).lockAlbum(partner.id, partnerFace.album.id);
      await ctx.get(LockRepository).lockAlbum(sharee.id, own.album.id);
      const revealAll = [sharedAlbumFace.album.id, partnerFace.album.id, own.album.id];
      const [[, plain], [, elevated], [, revealing]] = shareeAuths(sharee, revealAll);
      await expect(sut.getStatistics(plain, personGroupId)).resolves.toEqual({ assets: 1 });
      await expect(faceCount(plain)).resolves.toBe(1);
      await expect(sut.getStatistics(elevated, personGroupId)).resolves.toEqual({ assets: 1 });
      // the sharee's reveal un-hides only the sharee's own lock, never the partner's
      await expect(sut.getStatistics(revealing, personGroupId)).resolves.toEqual({ assets: 2 });
      await expect(faceCount(revealing)).resolves.toBe(2);
    });

    it("an album owner's lock never affects the sharee's album grant; the sharee's own lock does (R19)", async () => {
      const { ctx, sut } = setup();
      const { owner, sharee, personGroupId } = await newSharedPerson(ctx);
      const search = BaseService.create(SearchService, sut);
      const name = `Zebulon ${factory.uuid().slice(0, 8)}`;
      await ctx.database.updateTable('person').set({ name }).where('personGroupId', '=', personGroupId).execute();
      // the sharer is also the sharee's partner: the partner arm follows the sharer's locks, the album arm does not
      await ctx.newPartner({ sharedById: owner.id, sharedWithId: sharee.id });
      const shared = await newFaceOn(ctx, { ownerId: owner.id, personGroupId });
      await ctx.newAlbumUser({ albumId: shared.album.id, userId: sharee.id });
      const partnerOnly = await newFaceOn(ctx, { ownerId: owner.id, personGroupId });

      const view = async (auth: AuthDto) => {
        const [{ assets }, { people }, found] = await Promise.all([
          sut.getStatistics(auth, personGroupId),
          sut.getAll(auth, { page: 1, size: 10, withHidden: true }),
          search.searchPerson(auth, { name, withHidden: true }),
        ]);
        return { assets, listed: people.length, found: found.length };
      };

      for (const [label, auth] of shareeAuths(sharee, [])) {
        await expect(view(auth), label).resolves.toEqual({ assets: 2, listed: 1, found: 1 });
      }

      // A locks both albums for themselves: the partner-only asset hides, the shared album's asset stays granted
      await ctx.get(LockRepository).lockAlbum(owner.id, shared.album.id);
      await ctx.get(LockRepository).lockAlbum(owner.id, partnerOnly.album.id);
      for (const [label, auth] of shareeAuths(sharee, [shared.album.id, partnerOnly.album.id])) {
        await expect(view(auth), label).resolves.toEqual({ assets: 1, listed: 1, found: 1 });
      }

      // converse: B locks the shared album for themselves - its faces disappear for B unless B reveals it
      await ctx.get(LockRepository).lockAlbum(sharee.id, shared.album.id);
      const [[, plain], [, elevated], [, revealing]] = shareeAuths(sharee, [shared.album.id]);
      await expect(view(plain)).resolves.toEqual({ assets: 0, listed: 0, found: 0 });
      await expect(view(elevated)).resolves.toEqual({ assets: 0, listed: 0, found: 0 });
      await expect(view(revealing)).resolves.toEqual({ assets: 1, listed: 1, found: 1 });
    });

    it('name search hides a person whose only faces are on archived or trashed assets in a locked album', async () => {
      const { ctx, sut } = setup();
      const search = BaseService.create(SearchService, sut);
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      for (const hide of [
        (assetId: string) =>
          ctx.database
            .updateTable('asset')
            .set({ visibility: AssetVisibility.Archive })
            .where('id', '=', assetId)
            .execute(),
        (assetId: string) => ctx.softDeleteAsset(assetId),
      ]) {
        const name = `Quillon ${factory.uuid().slice(0, 8)}`;
        const { person } = await ctx.newPerson({ ownerId: user.id, name });
        const face = await newFaceOn(ctx, { ownerId: user.id, personGroupId: person.personGroupId });
        await hide(face.asset.id);
        const found = async () => {
          const people = await search.searchPerson(auth, { name, withHidden: true });
          return people.map(({ id }) => id);
        };

        await expect(found()).resolves.toEqual([person.personGroupId]);
        await ctx.get(LockRepository).lockAlbum(user.id, face.album.id);
        await expect(found()).resolves.toEqual([]);
        await ctx.get(LockRepository).unlockAlbum(user.id, face.album.id);
        await expect(found()).resolves.toEqual([person.personGroupId]);
      }
    });

    it("the sharee's own locked share does not surface through the shared-album arm", async () => {
      const { ctx, sut } = setup();
      const { owner, sharee, personGroupId } = await newSharedPerson(ctx);
      const sharedAlbumFace = await newFaceOn(ctx, { ownerId: owner.id, personGroupId });
      await ctx.newAlbumUser({ albumId: sharedAlbumFace.album.id, userId: sharee.id });

      await expect(sut.getStatistics(factory.auth({ user: sharee }), personGroupId)).resolves.toEqual({ assets: 1 });
      await ctx.get(LockRepository).lockAlbum(sharee.id, sharedAlbumFace.album.id);
      const [[, plain], [, elevated], [, revealing]] = shareeAuths(sharee, [sharedAlbumFace.album.id]);
      await expect(sut.getStatistics(plain, personGroupId)).resolves.toEqual({ assets: 0 });
      await expect(sut.getStatistics(elevated, personGroupId)).resolves.toEqual({ assets: 0 });
      await expect(sut.getStatistics(revealing, personGroupId)).resolves.toEqual({ assets: 1 });
    });

    it('createNewFeaturePhoto never picks a hidden face', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: member } = await ctx.newUser({ clusterGroupId: owner.clusterGroupId });
      const { person } = await ctx.newPerson({ ownerId: owner.id, thumbnailPath: '' });
      const personGroupId = person.personGroupId;
      await newFaceOn(ctx, { ownerId: owner.id, personGroupId, locked: true });
      await newFaceOn(ctx, { ownerId: member.id, personGroupId, locked: true });
      await newFaceOn(ctx, { ownerId: owner.id, personGroupId, locked: true });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      await sut.createNewFeaturePhoto([{ ownerId: owner.id, personGroupId }]);
      const before = await ctx.get(PersonRepository).getByGroupId({ ownerId: owner.id, personGroupId });
      expect(before?.faceAssetId).toBeNull();

      const visible = await newFaceOn(ctx, { ownerId: member.id, personGroupId });
      await newFaceOn(ctx, { ownerId: member.id, personGroupId, locked: true });
      await sut.createNewFeaturePhoto([{ ownerId: owner.id, personGroupId }]);
      const after = await ctx.get(PersonRepository).getByGroupId({ ownerId: owner.id, personGroupId });
      expect(after?.faceAssetId).toBe(visible.face.id);
      expect(ctx.getMock(JobRepository).queueAll).toHaveBeenLastCalledWith([
        { name: JobName.PersonGenerateThumbnail, data: { ownerId: owner.id, personGroupId } },
      ]);
    });

    it('smart albums filtering a personGroupId are invalidated on reassign, merge, delete and cluster reassignment', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser({ clusterGroupId: user.clusterGroupId });
      const auth = factory.auth({ user });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      ctx.getMock(StorageRepository).unlink.mockResolvedValue();

      const { person: target } = await ctx.newPerson({ ownerId: user.id });
      const { person: source } = await ctx.newPerson({ ownerId: user.id });
      const { person: toDelete } = await ctx.newPerson({ ownerId: user.id });
      const { person: shared } = await ctx.newPerson({ ownerId: user.id });
      await ctx.newPerson({ ownerId: other.id, personGroupId: shared.personGroupId });
      const { album } = await ctx.newAlbum({
        ownerId: user.id,
        kind: AlbumKind.Smart,
        filter: {
          personIds: [target.personGroupId, source.personGroupId, toDelete.personGroupId, shared.personGroupId],
        } as any,
      });
      const { face } = await newFaceOn(ctx, { ownerId: user.id, personGroupId: source.personGroupId });

      // each path bumps the album's cache revision in SQL (R3); a bumped revision makes the cache stale
      let revision = await getCacheRevision(ctx, album.id);
      const expectInvalidated = async (label: string) => {
        const next = await getCacheRevision(ctx, album.id);
        expect(next, label).toBeGreaterThan(revision);
        revision = next;
      };

      await sut.reassignFacesById(auth, target.personGroupId, { id: face.id });
      await expectInvalidated('reassign');

      await sut.mergePeople(auth, { ids: [target.personGroupId, source.personGroupId] });
      await expectInvalidated('merge');

      await sut.deleteAll(auth, { ids: [toDelete.personGroupId] });
      await expectInvalidated('delete');

      // cluster reassignment (leaving remaps the leaver's shared person groups to new ids)
      await BaseService.create(ClusterGroupService, sut).leave(auth, user.clusterGroupId);
      await expectInvalidated('cluster reassignment');

      // D12: none of these rewrote the filter - the merged-away and deleted ids stay in place, dangling, and zero-match
      await expect(getFilter(ctx, album.id)).resolves.toHaveProperty('personIds', [
        target.personGroupId,
        source.personGroupId,
        toDelete.personGroupId,
        shared.personGroupId,
      ]);
    });
  });

  describe('smart album filters keep dangling person ids (D12)', () => {
    it('deleting one of several referenced people does not broaden a shared smart album', async () => {
      const { ctx, sut } = setup();
      ctx.getMock(StorageRepository).unlink.mockResolvedValue();
      const { user: owner } = await ctx.newUser();
      const { user: recipient } = await ctx.newUser();
      const { person: p } = await ctx.newPerson({ ownerId: owner.id });
      const { person: q } = await ctx.newPerson({ ownerId: owner.id });
      const { asset: both } = await ctx.newAsset({ ownerId: owner.id });
      const { asset: onlyP } = await ctx.newAsset({ ownerId: owner.id });
      const { asset: onlyQ } = await ctx.newAsset({ ownerId: owner.id });
      await ctx.newAssetFace({ assetId: both.id, personGroupId: p.personGroupId });
      await ctx.newAssetFace({ assetId: both.id, personGroupId: q.personGroupId });
      await ctx.newAssetFace({ assetId: onlyP.id, personGroupId: p.personGroupId });
      await ctx.newAssetFace({ assetId: onlyQ.id, personGroupId: q.personGroupId });
      const album = await newSharedSmartAlbum(ctx, owner.id, recipient.id, {
        personIds: [p.personGroupId, q.personGroupId],
      });
      const recipientAuth = factory.auth({ user: recipient });
      const candidates = [both.id, onlyP.id, onlyQ.id];

      const before = await readableAssetIds(ctx, recipientAuth, candidates);
      expect(before).toEqual([both.id]);

      await sut.deleteAll(factory.auth({ user: owner }), { ids: [p.personGroupId] });

      const after = await readableAssetIds(ctx, recipientAuth, candidates);
      expect(
        after.filter((id) => !before.includes(id)),
        'newly readable',
      ).toEqual([]);
      expect(after).not.toContain(onlyQ.id);
      await expect(getFilter(ctx, album.id)).resolves.toHaveProperty('personIds', [p.personGroupId, q.personGroupId]);
    });

    it('deleting the last referenced person/tag while another criterion remains yields zero matches', async () => {
      const { ctx, sut } = setup();
      ctx.getMock(StorageRepository).unlink.mockResolvedValue();
      const { user: owner } = await ctx.newUser();
      const { user: recipient } = await ctx.newUser();
      const { person: p } = await ctx.newPerson({ ownerId: owner.id });
      const { asset: favoriteWithP } = await ctx.newAsset({ ownerId: owner.id, isFavorite: true });
      const { asset: favoriteOnly } = await ctx.newAsset({ ownerId: owner.id, isFavorite: true });
      await ctx.newAssetFace({ assetId: favoriteWithP.id, personGroupId: p.personGroupId });
      const album = await newSharedSmartAlbum(ctx, owner.id, recipient.id, {
        personIds: [p.personGroupId],
        isFavorite: true,
      });
      const ownerAuth = factory.auth({ user: owner });
      const recipientAuth = factory.auth({ user: recipient });
      const candidates = [favoriteWithP.id, favoriteOnly.id];

      await expect(readableAssetIds(ctx, recipientAuth, candidates)).resolves.toEqual([favoriteWithP.id]);
      await expect(listedAssetCount(sut, ownerAuth, album.id)).resolves.toBe(1);
      await expect(listedAssetCount(sut, recipientAuth, album.id)).resolves.toBe(1);

      await sut.deleteAll(ownerAuth, { ids: [p.personGroupId] });

      await expect(readableAssetIds(ctx, recipientAuth, candidates)).resolves.toEqual([]);
      // the list-view cache recompute evaluates the dangling id without error, to zero
      await expect(listedAssetCount(sut, ownerAuth, album.id)).resolves.toBe(0);
      await expect(listedAssetCount(sut, recipientAuth, album.id)).resolves.toBe(0);
      expect(await getFilter(ctx, album.id)).toEqual({ personIds: [p.personGroupId], isFavorite: true });
    });

    it('an unlocked smart album with a dangling id cannot rescue locked assets', async () => {
      const { ctx, sut } = setup();
      ctx.getMock(StorageRepository).unlink.mockResolvedValue();
      const { user: owner } = await ctx.newUser();
      const { person: p } = await ctx.newPerson({ ownerId: owner.id });
      const { person: q } = await ctx.newPerson({ ownerId: owner.id });
      const { asset: hidden } = await newFaceOn(ctx, {
        ownerId: owner.id,
        personGroupId: q.personGroupId,
        locked: true,
      });
      const { album } = await ctx.newAlbum({
        ownerId: owner.id,
        kind: AlbumKind.Smart,
        filter: { personIds: [p.personGroupId, q.personGroupId] } as any,
      });
      const ownerAuth = factory.auth({ user: owner });

      await expect(readableAssetIds(ctx, ownerAuth, [hidden.id])).resolves.toEqual([]);

      await sut.deleteAll(ownerAuth, { ids: [p.personGroupId] });

      await expect(readableAssetIds(ctx, ownerAuth, [hidden.id])).resolves.toEqual([]);
      await expect(getFilter(ctx, album.id)).resolves.toHaveProperty('personIds', [p.personGroupId, q.personGroupId]);

      // control: the album with the dangling id pruned away would rescue the asset, so the checks above are meaningful
      await ctx.database
        .updateTable('album')
        .set({ filter: { personIds: [q.personGroupId] } as any })
        .where('id', '=', album.id)
        .execute();
      await expect(readableAssetIds(ctx, ownerAuth, [hidden.id])).resolves.toEqual([hidden.id]);
    });
  });

  describe('fork locks: face edits on hidden assets (§15.2)', () => {
    it('deleteFace refuses a face on a hidden asset outside elevation like a missing face', async () => {
      const { ctx, sut } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { face: hiddenFace } = await newFaceOn(ctx, {
        ownerId: user.id,
        personGroupId: person.personGroupId,
        locked: true,
      });
      const { face: visibleFace } = await newFaceOn(ctx, { ownerId: user.id, personGroupId: person.personGroupId });
      const auth = factory.auth({ user });

      for (const force of [false, true]) {
        await expect(sut.deleteFace(auth, hiddenFace.id, { force })).rejects.toThrow(
          'Not found or no face.delete access',
        );
      }
      await expect(personOf(ctx, hiddenFace.id)).resolves.toEqual({
        personGroupId: person.personGroupId,
        deletedAt: null,
      });
      await expect(sut.deleteFace(auth, newUuid(), { force: true })).rejects.toThrow(
        'Not found or no face.delete access',
      );

      await expect(sut.deleteFace(auth, visibleFace.id, { force: true })).resolves.toBeUndefined();
      const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });
      await expect(sut.deleteFace(elevated, hiddenFace.id, { force: true })).resolves.toBeUndefined();
      await expect(personOf(ctx, hiddenFace.id)).resolves.toBeUndefined();
    });

    it('deleteFace guards a soft-deleted face on a hidden asset too (both delete paths)', async () => {
      const { ctx, sut } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const invalidate = vi.spyOn(AlbumService.prototype, 'invalidateSmartAlbumsForAssetIdsSafe');
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset, face } = await newFaceOn(ctx, { ownerId: user.id, personGroupId: person.personGroupId });
      const auth = factory.auth({ user, session: { hasElevatedPermission: false } });

      // soft-delete while visible, then the asset becomes hidden (its album is locked)
      await sut.deleteFace(auth, face.id, { force: false });
      const softDeleted = await personOf(ctx, face.id);
      const softDeletedAt = softDeleted?.deletedAt;
      expect(softDeletedAt).not.toBeNull();
      const [{ albumId }] = await ctx.database
        .selectFrom('album_asset')
        .select('albumId')
        .where('assetId', '=', asset.id)
        .execute();
      await ctx.get(LockRepository).lockAlbum(user.id, albumId);
      invalidate.mockClear();

      const missing = await sut.deleteFace(auth, newUuid(), { force: true }).catch((error: Error) => error);
      expect(missing).toBeInstanceOf(Error);
      for (const force of [true, false]) {
        const refused = await sut.deleteFace(auth, face.id, { force }).catch((error: Error) => error);
        // the face permission's message, identical to a missing face (R32)
        expect(refused).toEqual(missing);
        expect((refused as Error).message).toBe('Not found or no face.delete access');
      }
      // nothing deleted, nothing invalidated
      await expect(personOf(ctx, face.id)).resolves.toEqual({
        personGroupId: person.personGroupId,
        deletedAt: softDeletedAt,
      });
      expect(invalidate).not.toHaveBeenCalled();

      // an elevated session may permanently delete it, and the asset's smart albums are invalidated
      const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });
      await expect(sut.deleteFace(elevated, face.id, { force: true })).resolves.toBeUndefined();
      await expect(personOf(ctx, face.id)).resolves.toBeUndefined();
      expect(invalidate).toHaveBeenCalledWith([asset.id]);
      invalidate.mockRestore();
    });

    it('deleteFace fails closed when the face lookup errors', async () => {
      const { ctx, sut } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { face } = await newFaceOn(ctx, { ownerId: user.id, personGroupId: person.personGroupId });
      const auth = factory.auth({ user, session: { hasElevatedPermission: true } });
      const lookup = vi
        .spyOn(ctx.get(PersonRepository), 'getFaceAssetId')
        .mockRejectedValue(new Error('connection reset'));

      for (const force of [true, false]) {
        await expect(sut.deleteFace(auth, face.id, { force })).rejects.toThrow('connection reset');
      }
      await expect(personOf(ctx, face.id)).resolves.toEqual({ personGroupId: person.personGroupId, deletedAt: null });
      lookup.mockRestore();
    });

    it('reassignFacesById refuses a face on a hidden asset outside elevation like a missing face', async () => {
      const { ctx, sut } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { person: source } = await ctx.newPerson({ ownerId: user.id });
      const { person: target } = await ctx.newPerson({ ownerId: user.id });
      const { face } = await newFaceOn(ctx, { ownerId: user.id, personGroupId: source.personGroupId, locked: true });
      const auth = factory.auth({ user });

      await expect(sut.reassignFacesById(auth, target.personGroupId, { id: face.id })).rejects.toThrow(
        'Not found or no person.create access',
      );
      await expect(personOf(ctx, face.id)).resolves.toEqual({ personGroupId: source.personGroupId, deletedAt: null });

      const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });
      await sut.reassignFacesById(elevated, target.personGroupId, { id: face.id });
      await expect(personOf(ctx, face.id)).resolves.toEqual({ personGroupId: target.personGroupId, deletedAt: null });
    });

    it('reassignFaces skips faces on hidden assets outside elevation', async () => {
      const { ctx, sut } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { person: source } = await ctx.newPerson({ ownerId: user.id });
      const { person: target } = await ctx.newPerson({ ownerId: user.id });
      const hidden = await newFaceOn(ctx, { ownerId: user.id, personGroupId: source.personGroupId, locked: true });
      const visible = await newFaceOn(ctx, { ownerId: user.id, personGroupId: source.personGroupId });
      const data = [hidden, visible].map(({ asset }) => ({ personId: source.personGroupId, assetId: asset.id }));

      await sut.reassignFaces(factory.auth({ user }), target.personGroupId, { data });
      await expect(personOf(ctx, hidden.face.id)).resolves.toEqual({
        personGroupId: source.personGroupId,
        deletedAt: null,
      });
      await expect(personOf(ctx, visible.face.id)).resolves.toEqual({
        personGroupId: target.personGroupId,
        deletedAt: null,
      });

      const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });
      await sut.reassignFaces(elevated, target.personGroupId, { data: data.slice(0, 1) });
      await expect(personOf(ctx, hidden.face.id)).resolves.toEqual({
        personGroupId: target.personGroupId,
        deletedAt: null,
      });
    });
  });
});
