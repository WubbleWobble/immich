import { Kysely } from 'kysely';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { OutputInfo } from 'sharp';
import type { JobItem } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { PersonUserRole } from 'src/dtos/person.dto.js';
import { JobName, PersonPathType, StorageFolder } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ClusterGroupRepository } from 'src/repositories/cluster-group.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LockRepository } from 'src/repositories/lock.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { MoveRepository } from 'src/repositories/move.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { PersonUserRepository } from 'src/repositories/person-user.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import * as provenanceMigration from 'src/schema/migrations/1792300000000-AddPersonThumbnailSourceFace.js';
import { BaseService } from 'src/services/base.service.js';
import { MediaService } from 'src/services/media.service.js';
import { PersonService } from 'src/services/person.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory, newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;
let mediaLocation: string;

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

const setup = (db?: Kysely<DB>) => {
  StorageCore.reset();
  StorageCore.setMediaLocation(mediaLocation);
  const { sut, ctx } = newMediumService(MediaService, {
    database: db || defaultDatabase,
    real: [
      AccessRepository,
      AlbumRepository,
      AlbumUserRepository,
      AssetJobRepository,
      AssetRepository,
      ClusterGroupRepository,
      ConfigRepository,
      CryptoRepository,
      DatabaseRepository,
      LockRepository,
      MoveRepository,
      PartnerRepository,
      PersonRepository,
      PersonUserRepository,
      StorageRepository,
      SystemMetadataRepository,
      UserRepository,
    ],
    mock: [JobRepository, LoggingRepository, MediaRepository],
  });

  // The "crop" of a face is the bytes `crop:<source asset original path>`, so every served file can be traced back to
  // the face it was cut from. `gates` pauses a generation after its file is written and before it publishes.
  const gates = new Map<string, Promise<void>>();
  const faults = new Set<string>();
  const media = ctx.getMock(MediaRepository);
  media.decodeImage.mockImplementation((input) =>
    Promise.resolve({ data: Buffer.from(`crop:${String(input)}`), info: { width: 10, height: 10 } as OutputInfo }),
  );
  media.generateThumbnail.mockImplementation(async (decoded, _options, output) => {
    const source = decoded.data.toString().slice('crop:'.length);
    if (faults.has(source)) {
      throw new Error(`injected crop failure for ${source}`);
    }
    await writeFile(output, decoded.data);
    await gates.get(source);
  });

  const queued: JobItem[] = [];
  const job = ctx.getMock(JobRepository);
  job.queue.mockImplementation((item) => {
    queued.push(item);
    return Promise.resolve();
  });
  job.queueAll.mockImplementation((items) => {
    queued.push(...items);
    return Promise.resolve();
  });

  const people = BaseService.create(PersonService, sut);
  return { sut, ctx, people, gates, faults, queued };
};

type Context = ReturnType<typeof setup>;
type Ctx = Context['ctx'];

const thumbsOf = (ownerId: string) => StorageCore.getFolderLocation(StorageFolder.Thumbnails, ownerId);

/** Every file under the owner's thumbs folder whose basename belongs to the person group. */
const generationFiles = async (ownerId: string, personGroupId: string) => {
  const root = thumbsOf(ownerId);
  if (!existsSync(root)) {
    return [];
  }
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(personGroupId))
    .map((entry) => join(entry.parentPath, entry.name))
    .toSorted();
};

const newFaceOn = async (
  ctx: Ctx,
  { ownerId, personGroupId, locked = false }: { ownerId: string; personGroupId: string; locked?: boolean },
) => {
  const { asset } = await ctx.newAsset({ ownerId, originalPath: `/photos/${newUuid()}.jpg` });
  const { assetFace: face } = await ctx.newAssetFace({ assetId: asset.id, personGroupId });
  const { album } = await ctx.newAlbum({ ownerId }, [asset.id]);
  if (locked) {
    await ctx.get(LockRepository).lockAlbum(ownerId, album.id);
  }
  return { asset, face, album, crop: `crop:${asset.originalPath}` };
};

const getPair = (ctx: Ctx, ownerId: string, personGroupId: string) =>
  ctx.database
    .selectFrom('person')
    .select(['thumbnailPath', 'thumbnailSourceFaceId', 'faceAssetId'])
    .where('ownerId', '=', ownerId)
    .where('personGroupId', '=', personGroupId)
    .executeTakeFirstOrThrow();

const setFeatureFace = (ctx: Ctx, ownerId: string, personGroupId: string, faceId: string) =>
  ctx.database
    .updateTable('person')
    .set({ faceAssetId: faceId })
    .where('ownerId', '=', ownerId)
    .where('personGroupId', '=', personGroupId)
    .execute();

/** A published pair whose file lives in a legacy, non-nested folder of the owner's thumbs (a pending migration). */
const seedPublishedFile = async (
  ctx: Ctx,
  {
    ownerId,
    personGroupId,
    faceId,
    crop,
    folder = 'legacy',
  }: { ownerId: string; personGroupId: string; faceId: string; crop: string; folder?: string },
) => {
  const path = join(thumbsOf(ownerId), folder, `${personGroupId}-${newUuid()}.jpeg`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, crop);
  await ctx.database
    .updateTable('person')
    .set({ thumbnailPath: path, thumbnailSourceFaceId: faceId, faceAssetId: faceId })
    .where('ownerId', '=', ownerId)
    .where('personGroupId', '=', personGroupId)
    .execute();
  return path;
};

const servedBytes = async (people: PersonService, auth: AuthDto, personGroupId: string) => {
  const file = await people.getThumbnail(auth, personGroupId);
  const bytes = await readFile(file.path, 'utf8');
  return { path: file.path, bytes };
};

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

const runQueuedPersonThumbnails = async ({ sut, queued }: Context) => {
  const jobs = queued.splice(0).filter((item) => item.name === JobName.PersonGenerateThumbnail);
  for (const item of jobs) {
    await sut.handleGeneratePersonThumbnail(item.data);
  }
  return jobs.map(({ data }) => data);
};

/** A shares group G with B (the share trigger gives B a person row without a thumbnail). */
const newSharedPerson = async (ctx: Ctx) => {
  const { user: owner } = await ctx.newUser();
  const { user: sharee } = await ctx.newUser({ clusterGroupId: owner.clusterGroupId });
  const { person } = await ctx.newPerson({ ownerId: owner.id, thumbnailPath: '' });
  await ctx.newPersonUser({ personGroupId: person.personGroupId, sharedById: owner.id, sharedWithId: sharee.id });
  return { owner, sharee, personGroupId: person.personGroupId };
};

/** move_history rows of these owners' person rows in the group, plus any legacy row keyed by the bare group id. */
const moveHistory = (ctx: Ctx, ownerIds: string[], personGroupId: string) =>
  ctx.database
    .selectFrom('move_history')
    .selectAll()
    .where('entityId', 'in', [
      personGroupId,
      ...ownerIds.map((ownerId) => StorageCore.getPersonMoveKey(ownerId, personGroupId)),
    ])
    .execute();

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
  mediaLocation = await mkdtemp(join(tmpdir(), 'immich-person-thumbnails-'));
});

describe(MediaService.name, () => {
  describe('shared people and locks', () => {
    it('regeneration pending: new visible feature face does not authorize the old hidden crop', async () => {
      const context = setup();
      const { ctx, people, sut } = context;
      const { owner, sharee, personGroupId } = await newSharedPerson(ctx);
      const hidden = await newFaceOn(ctx, { ownerId: owner.id, personGroupId, locked: true });
      const visible = await newFaceOn(ctx, { ownerId: owner.id, personGroupId });

      await setFeatureFace(ctx, owner.id, personGroupId, hidden.face.id);
      await sut.handleGeneratePersonThumbnail({ ownerId: owner.id, personGroupId });
      const { thumbnailPath: pathH } = await getPair(ctx, owner.id, personGroupId);
      expect(await readFile(pathH, 'utf8')).toBe(hidden.crop);
      context.queued.length = 0;

      // the owner picks the visible face; the job is queued but has not run
      await people.update(factory.auth({ user: owner }), personGroupId, { featureFaceAssetId: visible.asset.id });
      await expect(getPair(ctx, owner.id, personGroupId)).resolves.toEqual({
        thumbnailPath: pathH,
        thumbnailSourceFaceId: hidden.face.id,
        faceAssetId: visible.face.id,
      });
      for (const [label, auth] of [...shareeAuths(sharee, [hidden.album.id]), ...shareeAuths(owner, [])]) {
        await expect(people.getThumbnail(auth, personGroupId), label).rejects.toThrow('Not Found');
      }

      await expect(runQueuedPersonThumbnails(context)).resolves.toEqual([{ ownerId: owner.id, personGroupId }]);
      const pair = await getPair(ctx, owner.id, personGroupId);
      expect(pair.thumbnailSourceFaceId).toBe(visible.face.id);
      expect(existsSync(pathH)).toBe(false);
      for (const [label, auth] of [...shareeAuths(sharee, [hidden.album.id]), ...shareeAuths(owner, [])]) {
        await expect(servedBytes(people, auth, personGroupId), label).resolves.toEqual({
          path: pair.thumbnailPath,
          bytes: visible.crop,
        });
      }
    });

    it('pause between file write and publish serves the previously published pair only', async () => {
      for (const previousHidden of [false, true]) {
        const context = setup();
        const { ctx, people, sut, gates } = context;
        const { owner, sharee, personGroupId } = await newSharedPerson(ctx);
        const previous = await newFaceOn(ctx, { ownerId: owner.id, personGroupId, locked: previousHidden });
        const next = await newFaceOn(ctx, { ownerId: owner.id, personGroupId });
        const previousPath = await seedPublishedFile(ctx, {
          ownerId: owner.id,
          personGroupId,
          faceId: previous.face.id,
          crop: previous.crop,
          folder: 'published',
        });

        await setFeatureFace(ctx, owner.id, personGroupId, next.face.id);
        const gate = deferred();
        gates.set(next.asset.originalPath, gate.promise);
        const running = sut.handleGeneratePersonThumbnail({ ownerId: owner.id, personGroupId });
        await vi.waitFor(async () => expect(await generationFiles(owner.id, personGroupId)).toHaveLength(2));

        for (const [label, auth] of [...shareeAuths(sharee, [previous.album.id]), ...shareeAuths(owner, [])]) {
          const request = servedBytes(people, auth, personGroupId);
          await (previousHidden
            ? expect(request, label).rejects.toThrow('Not Found')
            : expect(request, label).resolves.toEqual({ path: previousPath, bytes: previous.crop }));
        }

        gate.resolve();
        await running;
        const pair = await getPair(ctx, owner.id, personGroupId);
        expect(pair.thumbnailSourceFaceId).toBe(next.face.id);
        await expect(servedBytes(people, factory.auth({ user: sharee }), personGroupId)).resolves.toEqual({
          path: pair.thumbnailPath,
          bytes: next.crop,
        });
        await expect(generationFiles(owner.id, personGroupId)).resolves.toEqual([pair.thumbnailPath]);
      }
    });

    it('overlapping jobs leave file and provenance consistent', async () => {
      const context = setup();
      const { ctx, people, sut, gates } = context;
      const { owner, sharee, personGroupId } = await newSharedPerson(ctx);
      const faceH = await newFaceOn(ctx, { ownerId: owner.id, personGroupId, locked: true });
      const faceV = await newFaceOn(ctx, { ownerId: owner.id, personGroupId });

      await setFeatureFace(ctx, owner.id, personGroupId, faceH.face.id);
      const gate = deferred();
      gates.set(faceH.asset.originalPath, gate.promise);
      const job1 = sut.handleGeneratePersonThumbnail({ ownerId: owner.id, personGroupId });
      await vi.waitFor(async () => expect(await generationFiles(owner.id, personGroupId)).toHaveLength(1));

      await setFeatureFace(ctx, owner.id, personGroupId, faceV.face.id);
      await sut.handleGeneratePersonThumbnail({ ownerId: owner.id, personGroupId });
      gate.resolve();
      await job1;

      const pair = await getPair(ctx, owner.id, personGroupId);
      expect(pair.thumbnailSourceFaceId).toBe(faceV.face.id);
      await expect(generationFiles(owner.id, personGroupId)).resolves.toEqual([pair.thumbnailPath]);
      for (const [label, auth] of [...shareeAuths(sharee, [faceH.album.id]), ...shareeAuths(owner, [])]) {
        await expect(servedBytes(people, auth, personGroupId), label).resolves.toEqual({
          path: pair.thumbnailPath,
          bytes: faceV.crop,
        });
      }
    });

    it('concurrent identical-face jobs publish consistent pairs', async () => {
      const context = setup();
      const { ctx, people, sut, gates } = context;
      const { owner, sharee, personGroupId } = await newSharedPerson(ctx);
      const face = await newFaceOn(ctx, { ownerId: owner.id, personGroupId });
      await setFeatureFace(ctx, owner.id, personGroupId, face.face.id);

      const gate = deferred();
      gates.set(face.asset.originalPath, gate.promise);
      const job1 = sut.handleGeneratePersonThumbnail({ ownerId: owner.id, personGroupId });
      const job2 = sut.handleGeneratePersonThumbnail({ ownerId: owner.id, personGroupId });
      await vi.waitFor(async () => expect(await generationFiles(owner.id, personGroupId)).toHaveLength(2));
      gate.resolve();
      await Promise.all([job1, job2]);

      const pair = await getPair(ctx, owner.id, personGroupId);
      expect(pair.thumbnailSourceFaceId).toBe(face.face.id);
      await expect(generationFiles(owner.id, personGroupId)).resolves.toEqual([pair.thumbnailPath]);
      for (const [label, auth] of [...shareeAuths(sharee, []), ...shareeAuths(owner, [])]) {
        await expect(servedBytes(people, auth, personGroupId), label).resolves.toEqual({
          path: pair.thumbnailPath,
          bytes: face.crop,
        });
      }
    });

    it('upgrade: existing thumbnails have null provenance and are withheld from everyone', async () => {
      const db = await isolatedDb();
      await provenanceMigration.down(db);

      const context = setup(db);
      const { ctx, people, sut } = context;
      const { user: owner } = await ctx.newUser();
      const { user: sharee } = await ctx.newUser({ clusterGroupId: owner.clusterGroupId });
      const group = await ctx.get(PersonRepository).createGroup(owner.id);
      const personGroupId = group.id;
      const hidden = await newFaceOn(ctx, { ownerId: owner.id, personGroupId, locked: true });
      const visible = await newFaceOn(ctx, { ownerId: owner.id, personGroupId });

      // pre-upgrade layout: one fixed file per (owner, group), here still holding the hidden crop while the feature
      // face already points at the visible face (the drift case)
      const legacyPath = StorageCore.getNestedPath(StorageFolder.Thumbnails, owner.id, `${personGroupId}.jpeg`);
      await mkdir(dirname(legacyPath), { recursive: true });
      await writeFile(legacyPath, hidden.crop);
      await db
        .insertInto('person')
        .values({ ownerId: owner.id, personGroupId, faceAssetId: visible.face.id, thumbnailPath: legacyPath })
        .execute();
      await db
        .insertInto('person_user')
        .values({ personGroupId, sharedById: owner.id, sharedWithId: sharee.id, role: PersonUserRole.Read })
        .execute();

      await provenanceMigration.up(db);
      await expect(getPair(ctx, owner.id, personGroupId)).resolves.toEqual({
        thumbnailPath: legacyPath,
        thumbnailSourceFaceId: null,
        faceAssetId: visible.face.id,
      });

      for (const [label, auth] of [
        ...shareeAuths(owner, [hidden.album.id]),
        ...shareeAuths(sharee, [hidden.album.id]),
      ]) {
        await expect(people.getThumbnail(auth, personGroupId), label).rejects.toThrow('Not Found');
      }

      await sut.onBootstrap();
      await runQueuedPersonThumbnails(context);

      const pair = await getPair(ctx, owner.id, personGroupId);
      expect(pair.thumbnailSourceFaceId).toBe(visible.face.id);
      expect(basename(pair.thumbnailPath)).toMatch(new RegExp(String.raw`^${personGroupId}-[0-9a-f-]{36}\.jpeg$`));
      expect(existsSync(legacyPath)).toBe(false);
      for (const [label, auth] of shareeAuths(owner, [])) {
        await expect(servedBytes(people, auth, personGroupId), label).resolves.toEqual({
          path: pair.thumbnailPath,
          bytes: visible.crop,
        });
      }
      // the sharee (no thumbnail of their own before) also ends up with a crop of the visible face only
      for (const [label, auth] of shareeAuths(sharee, [hidden.album.id])) {
        await expect(servedBytes(people, auth, personGroupId), label).resolves.toEqual(
          expect.objectContaining({ bytes: visible.crop }),
        );
      }
    });

    it('startup regeneration survives interruption', async () => {
      const context = setup(await isolatedDb());
      const { ctx, people, sut, queued } = context;
      const { user: owner } = await ctx.newUser();
      const rows: { personGroupId: string; crop: string; faceId: string }[] = [];
      for (let i = 0; i < 4; i++) {
        const { person } = await ctx.newPerson({ ownerId: owner.id, thumbnailPath: '' });
        const face = await newFaceOn(ctx, { ownerId: owner.id, personGroupId: person.personGroupId });
        const legacyPath = StorageCore.getNestedPath(
          StorageFolder.Thumbnails,
          owner.id,
          `${person.personGroupId}.jpeg`,
        );
        await mkdir(dirname(legacyPath), { recursive: true });
        await writeFile(legacyPath, 'legacy');
        await ctx.database
          .updateTable('person')
          .set({ thumbnailPath: legacyPath, faceAssetId: face.face.id })
          .where('personGroupId', '=', person.personGroupId)
          .execute();
        rows.push({ personGroupId: person.personGroupId, crop: face.crop, faceId: face.face.id });
      }

      // the first start enqueues only k = 2 jobs before enqueueing fails
      ctx.getMock(JobRepository).queueAll.mockImplementationOnce((items) => {
        queued.push(...items.slice(0, 2));
        return Promise.reject(new Error('queue went away'));
      });
      await sut.onBootstrap();
      const first = await runQueuedPersonThumbnails(context);
      expect(first).toHaveLength(2);

      // a job that survived the restart re-runs for an already-published row (duplicate work is allowed)
      await sut.handleGeneratePersonThumbnail(first[0]);

      await sut.onBootstrap();
      const second = await runQueuedPersonThumbnails(context);
      expect(second).toHaveLength(2);
      expect(second.map(({ personGroupId }) => personGroupId).toSorted()).toEqual(
        rows
          .map(({ personGroupId }) => personGroupId)
          .filter((id) => first.every((job) => job.personGroupId !== id))
          .toSorted(),
      );

      for (const row of rows) {
        const pair = await getPair(ctx, owner.id, row.personGroupId);
        expect(pair.thumbnailSourceFaceId).toBe(row.faceId);
        await expect(generationFiles(owner.id, row.personGroupId)).resolves.toEqual([pair.thumbnailPath]);
        await expect(servedBytes(people, factory.auth({ user: owner }), row.personGroupId)).resolves.toEqual({
          path: pair.thumbnailPath,
          bytes: row.crop,
        });
      }

      // nothing is left to select
      await sut.onBootstrap();
      expect(queued.filter((item) => item.name === JobName.PersonGenerateThumbnail)).toEqual([]);
    });

    it('failed generation stays retryable', async () => {
      const context = setup(await isolatedDb());
      const { ctx, people, sut, faults } = context;
      const { user: owner } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: owner.id, thumbnailPath: '/legacy/thumb.jpeg' });
      const personGroupId = person.personGroupId;
      const face = await newFaceOn(ctx, { ownerId: owner.id, personGroupId });
      await setFeatureFace(ctx, owner.id, personGroupId, face.face.id);
      faults.add(face.asset.originalPath);

      await sut.onBootstrap();
      const [jobData] = context.queued.splice(0).map(({ data }) => data as { ownerId: string; personGroupId: string });
      expect(jobData).toEqual({ ownerId: owner.id, personGroupId });
      await expect(sut.handleGeneratePersonThumbnail(jobData)).rejects.toThrow('injected crop failure');
      await expect(getPair(ctx, owner.id, personGroupId)).resolves.toEqual(
        expect.objectContaining({ thumbnailPath: '/legacy/thumb.jpeg', thumbnailSourceFaceId: null }),
      );
      await expect(generationFiles(owner.id, personGroupId)).resolves.toEqual([]);

      // selected again by the next start and by the regular "missing" queue-all
      await sut.onBootstrap();
      expect(context.queued.splice(0)).toEqual([
        { name: JobName.PersonGenerateThumbnail, data: { ownerId: owner.id, personGroupId } },
      ]);
      await sut.handleQueueGenerateThumbnails({ force: false });
      expect(context.queued.filter((item) => item.name === JobName.PersonGenerateThumbnail)).toEqual([
        { name: JobName.PersonGenerateThumbnail, data: { ownerId: owner.id, personGroupId } },
      ]);

      faults.clear();
      await runQueuedPersonThumbnails(context);
      const pair = await getPair(ctx, owner.id, personGroupId);
      expect(pair.thumbnailSourceFaceId).toBe(face.face.id);
      await expect(servedBytes(people, factory.auth({ user: owner }), personGroupId)).resolves.toEqual({
        path: pair.thumbnailPath,
        bytes: face.crop,
      });
    });
  });

  describe('soft-deleted source faces', () => {
    it('a soft-deleted source face is withheld and regenerated from a newly picked feature face', async () => {
      const context = setup(await isolatedDb());
      const { ctx, people, sut } = context;
      const { user: owner } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: owner.id, thumbnailPath: '' });
      const personGroupId = person.personGroupId;
      const removed = await newFaceOn(ctx, { ownerId: owner.id, personGroupId });
      await setFeatureFace(ctx, owner.id, personGroupId, removed.face.id);
      await sut.handleGeneratePersonThumbnail({ ownerId: owner.id, personGroupId });
      const replacement = await newFaceOn(ctx, { ownerId: owner.id, personGroupId });
      await expect(servedBytes(people, factory.auth({ user: owner }), personGroupId)).resolves.toEqual(
        expect.objectContaining({ bytes: removed.crop }),
      );

      // deleteFace without force soft-deletes the face
      await ctx.get(PersonRepository).softDeleteAssetFaces(removed.face.id);
      await expect(people.getThumbnail(factory.auth({ user: owner }), personGroupId)).rejects.toThrow('Not Found');

      await sut.onBootstrap();
      await expect(runQueuedPersonThumbnails(context)).resolves.toEqual([{ ownerId: owner.id, personGroupId }]);
      const pair = await getPair(ctx, owner.id, personGroupId);
      expect(pair).toEqual(
        expect.objectContaining({ faceAssetId: replacement.face.id, thumbnailSourceFaceId: replacement.face.id }),
      );
      await expect(servedBytes(people, factory.auth({ user: owner }), personGroupId)).resolves.toEqual({
        path: pair.thumbnailPath,
        bytes: replacement.crop,
      });
      await expect(generationFiles(owner.id, personGroupId)).resolves.toEqual([pair.thumbnailPath]);
    });
  });

  describe('person thumbnail moves', () => {
    it('media-location move preserves provenance', async () => {
      const { ctx, people } = setup();
      const { owner, sharee, personGroupId } = await newSharedPerson(ctx);
      const face = await newFaceOn(ctx, { ownerId: owner.id, personGroupId });
      const legacyPath = await seedPublishedFile(ctx, {
        ownerId: owner.id,
        personGroupId,
        faceId: face.face.id,
        crop: face.crop,
      });

      // storage migration: relocate into the nested layout
      await people.handlePersonMigration({ ownerId: owner.id, personGroupId });
      const moved = await getPair(ctx, owner.id, personGroupId);
      expect(moved.thumbnailPath).toBe(
        StorageCore.getNestedPath(StorageFolder.Thumbnails, owner.id, basename(legacyPath)),
      );
      expect(moved.thumbnailSourceFaceId).toBe(face.face.id);
      expect(existsSync(legacyPath)).toBe(false);
      await expect(moveHistory(ctx, [owner.id], personGroupId)).resolves.toEqual([]);
      for (const [label, auth] of [...shareeAuths(sharee, []), ...shareeAuths(owner, [])]) {
        await expect(servedBytes(people, auth, personGroupId), label).resolves.toEqual({
          path: moved.thumbnailPath,
          bytes: face.crop,
        });
      }

      // media-location change: the files are copied over and the stored paths rewritten in place
      const newLocation = await mkdtemp(join(tmpdir(), 'immich-person-thumbnails-moved-'));
      await cp(mediaLocation, newLocation, { recursive: true });
      await ctx.get(DatabaseRepository).migrateFilePaths(mediaLocation, newLocation);
      const rewritten = await getPair(ctx, owner.id, personGroupId);
      expect(rewritten.thumbnailPath).toBe(join(newLocation, relative(mediaLocation, moved.thumbnailPath)));
      expect(basename(rewritten.thumbnailPath)).toBe(basename(legacyPath));
      expect(rewritten.thumbnailSourceFaceId).toBe(face.face.id);
      await expect(servedBytes(people, factory.auth({ user: sharee }), personGroupId)).resolves.toEqual({
        path: rewritten.thumbnailPath,
        bytes: face.crop,
      });
      await ctx.get(DatabaseRepository).migrateFilePaths(newLocation, mediaLocation);
    });

    it('move paused before publish loses to a concurrent regeneration', async () => {
      const context = setup();
      const { ctx, people, sut } = context;
      const { owner, sharee, personGroupId } = await newSharedPerson(ctx);
      const faceH = await newFaceOn(ctx, { ownerId: owner.id, personGroupId, locked: true });
      const faceV = await newFaceOn(ctx, { ownerId: owner.id, personGroupId });
      const pathH = await seedPublishedFile(ctx, {
        ownerId: owner.id,
        personGroupId,
        faceId: faceH.face.id,
        crop: faceH.crop,
      });
      const relocatedH = StorageCore.getNestedPath(StorageFolder.Thumbnails, owner.id, basename(pathH));

      const personRepository = ctx.get(PersonRepository);
      const original = personRepository.updateThumbnailPathIfUnchanged.bind(personRepository);
      const paused = deferred();
      const resume = deferred();
      vi.spyOn(personRepository, 'updateThumbnailPathIfUnchanged').mockImplementationOnce(async (request) => {
        paused.resolve();
        await resume.promise;
        return original(request);
      });

      const move = people.handlePersonMigration({ ownerId: owner.id, personGroupId });
      await paused.promise;
      expect(existsSync(relocatedH)).toBe(true);

      // regeneration publishes (pathV, V) while the move is paused
      await setFeatureFace(ctx, owner.id, personGroupId, faceV.face.id);
      await sut.handleGeneratePersonThumbnail({ ownerId: owner.id, personGroupId });
      const regenerated = await getPair(ctx, owner.id, personGroupId);

      resume.resolve();
      await move;

      await expect(getPair(ctx, owner.id, personGroupId)).resolves.toEqual(regenerated);
      expect(regenerated.thumbnailSourceFaceId).toBe(faceV.face.id);
      expect(existsSync(relocatedH)).toBe(false);
      await expect(generationFiles(owner.id, personGroupId)).resolves.toEqual([regenerated.thumbnailPath]);
      await expect(moveHistory(ctx, [owner.id], personGroupId)).resolves.toEqual([]);
      for (const [label, auth] of [...shareeAuths(sharee, [faceH.album.id]), ...shareeAuths(owner, [])]) {
        await expect(servedBytes(people, auth, personGroupId), label).resolves.toEqual({
          path: regenerated.thumbnailPath,
          bytes: faceV.crop,
        });
      }
    });

    it('resumed move after crash uses the conditional publish', async () => {
      const context = setup();
      const { ctx, people, sut } = context;
      const { owner, sharee, personGroupId } = await newSharedPerson(ctx);
      const faceH = await newFaceOn(ctx, { ownerId: owner.id, personGroupId, locked: true });
      const faceV = await newFaceOn(ctx, { ownerId: owner.id, personGroupId });
      const pathH = await seedPublishedFile(ctx, {
        ownerId: owner.id,
        personGroupId,
        faceId: faceH.face.id,
        crop: faceH.crop,
      });
      // the crashed move had already relocated H's file
      const relocatedH = StorageCore.getNestedPath(StorageFolder.Thumbnails, owner.id, basename(pathH));
      await mkdir(dirname(relocatedH), { recursive: true });
      await cp(pathH, relocatedH);
      await ctx.get(MoveRepository).create({
        entityId: StorageCore.getPersonMoveKey(owner.id, personGroupId),
        pathType: PersonPathType.Face,
        oldPath: pathH,
        newPath: relocatedH,
      });

      await setFeatureFace(ctx, owner.id, personGroupId, faceV.face.id);
      await sut.handleGeneratePersonThumbnail({ ownerId: owner.id, personGroupId });
      const regenerated = await getPair(ctx, owner.id, personGroupId);
      expect(regenerated.thumbnailSourceFaceId).toBe(faceV.face.id);

      await people.handlePersonMigration({ ownerId: owner.id, personGroupId });

      await expect(getPair(ctx, owner.id, personGroupId)).resolves.toEqual(regenerated);
      expect(existsSync(relocatedH)).toBe(false);
      await expect(generationFiles(owner.id, personGroupId)).resolves.toEqual([regenerated.thumbnailPath]);
      await expect(moveHistory(ctx, [owner.id], personGroupId)).resolves.toEqual([]);
      for (const [label, auth] of [...shareeAuths(sharee, [faceH.album.id]), ...shareeAuths(owner, [])]) {
        await expect(servedBytes(people, auth, personGroupId), label).resolves.toEqual({
          path: regenerated.thumbnailPath,
          bytes: faceV.crop,
        });
      }
    });

    it('two owners of the same personGroupId keep separate move histories', async () => {
      const context = setup();
      const { ctx, people } = context;
      const { owner: ownerA, sharee: ownerB, personGroupId } = await newSharedPerson(ctx);
      const faceA = await newFaceOn(ctx, { ownerId: ownerA.id, personGroupId });
      const faceB = await newFaceOn(ctx, { ownerId: ownerB.id, personGroupId });
      const pathA = await seedPublishedFile(ctx, {
        ownerId: ownerA.id,
        personGroupId,
        faceId: faceA.face.id,
        crop: faceA.crop,
      });
      const pathB = await seedPublishedFile(ctx, {
        ownerId: ownerB.id,
        personGroupId,
        faceId: faceB.face.id,
        crop: faceB.crop,
      });
      const relocatedA = StorageCore.getNestedPath(StorageFolder.Thumbnails, ownerA.id, basename(pathA));
      const relocatedB = StorageCore.getNestedPath(StorageFolder.Thumbnails, ownerB.id, basename(pathB));

      // a legacy-style history row keyed by the shared group id must be ignored, files untouched
      const legacyOld = join(thumbsOf(ownerA.id), 'foreign', `${personGroupId}-legacy.jpeg`);
      const legacyNew = join(thumbsOf(ownerB.id), 'foreign', `${personGroupId}-legacy.jpeg`);
      await mkdir(dirname(legacyOld), { recursive: true });
      await writeFile(legacyOld, 'legacy');
      await ctx.get(MoveRepository).create({
        entityId: personGroupId,
        pathType: PersonPathType.Face,
        oldPath: legacyOld,
        newPath: legacyNew,
      });

      // A's move crashes after relocating the file and before its publish
      const personRepository = ctx.get(PersonRepository);
      vi.spyOn(personRepository, 'updateThumbnailPathIfUnchanged').mockRejectedValueOnce(new Error('crash'));
      await expect(people.handlePersonMigration({ ownerId: ownerA.id, personGroupId })).rejects.toThrow('crash');
      expect(existsSync(relocatedA)).toBe(true);

      // B's move runs to completion
      await people.handlePersonMigration({ ownerId: ownerB.id, personGroupId });
      await expect(getPair(ctx, ownerB.id, personGroupId)).resolves.toEqual(
        expect.objectContaining({ thumbnailPath: relocatedB, thumbnailSourceFaceId: faceB.face.id }),
      );
      expect(existsSync(relocatedA)).toBe(true);

      // A's move resumes
      await people.handlePersonMigration({ ownerId: ownerA.id, personGroupId });
      await expect(getPair(ctx, ownerA.id, personGroupId)).resolves.toEqual(
        expect.objectContaining({ thumbnailPath: relocatedA, thumbnailSourceFaceId: faceA.face.id }),
      );
      await expect(getPair(ctx, ownerB.id, personGroupId)).resolves.toEqual(
        expect.objectContaining({ thumbnailPath: relocatedB, thumbnailSourceFaceId: faceB.face.id }),
      );
      await expect(servedBytes(people, factory.auth({ user: ownerA }), personGroupId)).resolves.toEqual({
        path: relocatedA,
        bytes: faceA.crop,
      });
      await expect(servedBytes(people, factory.auth({ user: ownerB }), personGroupId)).resolves.toEqual({
        path: relocatedB,
        bytes: faceB.crop,
      });

      // only the foreign row is left, and its files were not touched
      await expect(moveHistory(ctx, [ownerA.id, ownerB.id], personGroupId)).resolves.toEqual([
        expect.objectContaining({ entityId: personGroupId }),
      ]);
      expect(await readFile(legacyOld, 'utf8')).toBe('legacy');
      expect(existsSync(legacyNew)).toBe(false);
      expect(ctx.getMock(LoggingRepository).warn).toHaveBeenCalledWith(
        expect.stringContaining('[fork] foreign move_history row ignored'),
      );
    });

    it('crash after publish but before history delete is recognised as completed', async () => {
      const context = setup();
      const { ctx, people } = context;
      const { owner, personGroupId } = await newSharedPerson(ctx);
      const face = await newFaceOn(ctx, { ownerId: owner.id, personGroupId });
      const oldPath = await seedPublishedFile(ctx, {
        ownerId: owner.id,
        personGroupId,
        faceId: face.face.id,
        crop: face.crop,
      });
      const newPath = StorageCore.getNestedPath(StorageFolder.Thumbnails, owner.id, basename(oldPath));

      vi.spyOn(ctx.get(MoveRepository), 'delete').mockRejectedValueOnce(new Error('crash'));
      await expect(people.handlePersonMigration({ ownerId: owner.id, personGroupId })).rejects.toThrow('crash');
      await expect(getPair(ctx, owner.id, personGroupId)).resolves.toEqual(
        expect.objectContaining({ thumbnailPath: newPath, thumbnailSourceFaceId: face.face.id }),
      );
      await expect(moveHistory(ctx, [owner.id], personGroupId)).resolves.toHaveLength(1);

      const unlink = vi.spyOn(ctx.get(StorageRepository), 'unlink');
      await people.handlePersonMigration({ ownerId: owner.id, personGroupId });

      await expect(getPair(ctx, owner.id, personGroupId)).resolves.toEqual(
        expect.objectContaining({ thumbnailPath: newPath, thumbnailSourceFaceId: face.face.id }),
      );
      expect(existsSync(newPath)).toBe(true);
      await expect(servedBytes(people, factory.auth({ user: owner }), personGroupId)).resolves.toEqual({
        path: newPath,
        bytes: face.crop,
      });
      await expect(moveHistory(ctx, [owner.id], personGroupId)).resolves.toEqual([]);
      expect(unlink).not.toHaveBeenCalled();
      await expect(generationFiles(owner.id, personGroupId)).resolves.toEqual([newPath]);
    });
  });
});
