import { Injectable } from '@nestjs/common';
import {
  type ExpressionBuilder,
  type Insertable,
  type Kysely,
  type SqlBool,
  type Updateable,
  expressionBuilder,
  sql,
} from 'kysely';
import { jsonArrayFrom, jsonObjectFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import { AssetFace, PersonUser, columns } from 'src/database.js';
import { Chunked, ChunkedArray, DummyValue, GenerateSql } from 'src/decorators.js';
import { PersonUserRole } from 'src/dtos/person.dto.js';
import { AssetFileType, AssetVisibility, SourceType, UserMetadataKey } from 'src/enum.js';
import { type YearMonthDay } from 'src/repositories/asset.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetFaceTable } from 'src/schema/tables/asset-face.table.js';
import { FaceSearchTable } from 'src/schema/tables/face-search.table.js';
import { PersonGroupTable } from 'src/schema/tables/person-group.table.js';
import { PersonTable } from 'src/schema/tables/person.table.js';
import {
  type OwnerLockVisibility,
  anyUuid,
  dummy,
  faceLockVisible,
  getViewerHiddenAlbumIds,
  inSharedAlbum,
  joinDeduplicationPlugin,
  removeUndefinedKeys,
  withFilePath,
} from 'src/utils/database.js';
import { isLeapDayObserved } from 'src/utils/date.js';
import { type PaginationOptions, paginationHelper } from 'src/utils/pagination.js';

export interface PersonFilterOptions {
  sharedById?: string;
  sharedWithId?: string;
  isFavorite?: boolean;
  isHidden?: boolean;
  name?: string;
}

export interface PersonSearchOptions extends PersonFilterOptions {
  partnerIds: string[];
  withHidden: boolean;
  closestFaceAssetId?: string;
  /** order by similarity to this person's face instead; takes precedence over closestFaceAssetId */
  closestPersonId?: string;
}

export interface PersonNameSearchOptions {
  withHidden?: boolean;
  /** fork: scopes the lock check to the faces the viewer can see (own + partner + shared-album) */
  partnerIds?: string[];
}

export interface PersonNameResponse {
  personGroupId: string;
  name: string;
}

export interface AssetFaceId {
  assetId: string;
  personGroupId: string;
}

export interface UpdateGroupIdData {
  oldPersonGroupId: string;
  ownerId: string;
  newPersonGroupId: string;
}

export interface UpdateFacesData {
  oldPersonGroupId?: string;
  faceIds?: string[];
  ownerId?: string;
  newPersonGroupId: string;
}

export interface PersonStatistics {
  assets: number;
}

export interface DeleteFacesOptions {
  sourceType: SourceType;
}

export interface GetAllPeopleOptions {
  ownerId?: string;
  thumbnailPath?: string;
  faceAssetId?: string | null;
  isHidden?: boolean;
  /**
   * fork: rows without a verified thumbnail - none at all (`thumbnailPath = ''`) or one whose source is unknown
   * (`thumbnailSourceFaceId IS NULL`: pre-upgrade crops, deleted source faces, failed or stale generations)
   */
  withoutVerifiedThumbnail?: boolean;
}

/** fork: where a candidate thumbnail's crop came from, resolved from the candidate row's `thumbnailSourceFaceId` */
export interface ThumbnailProvenance {
  faceId: string | null;
  assetId: string | null;
  assetOwnerId: string | null;
}

export interface ThumbnailCandidate {
  path: string;
  provenance: ThumbnailProvenance;
}

export interface PublishThumbnailRequest extends PersonId {
  /** the feature face the job read at its start and cropped */
  faceId: string;
  path: string;
}

export interface MoveThumbnailRequest extends PersonId {
  oldPath: string;
  newPath: string;
  sourceFaceId: string | null;
}

export interface RandomFaceOptions {
  /** only faces on assets of these owners are eligible */
  eligibleOwnerIds: string[];
  /** per-owner lock entries the chosen face's asset must pass */
  lockVisibility?: OwnerLockVisibility[];
}

export interface GetAllFacesOptions {
  personGroupId?: string | null;
  assetId?: string;
  sourceType?: SourceType;
  clusterGroupId?: string;
}

export type UnassignFacesOptions = DeleteFacesOptions & { clusterGroupId?: string };

export type GetFacesOptions = WithPersonOptions & { isVisible?: boolean };

/** a person is identified by its owner and the group it belongs to */
export type PersonId = { ownerId: string; personGroupId: string };

export type ReassignCluster = { userId: string; newClusterId: string };

export type WithPersonOptions = {
  /** whose version of the person to select */
  viewingUserId: string;
};

const withSharing = (userId: string) => (eb: ExpressionBuilder<DB, 'person'>) => [
  jsonArrayFrom(
    eb
      .selectFrom('person as other')
      .innerJoin('person_user', (join) =>
        join
          .onRef('person_user.personGroupId', '=', 'other.personGroupId')
          .onRef('person_user.sharedById', '=', 'other.ownerId')
          .on('person_user.sharedWithId', '=', userId),
      )
      .select(['person_user.sharedById', 'person_user.role', 'other.name', 'other.birthDate'])
      .whereRef('other.personGroupId', '=', 'person.personGroupId'),
  ).as('otherPeople'),
  jsonArrayFrom(
    eb
      .selectFrom('person_user')
      .innerJoin('user', (join) =>
        join.onRef('user.id', '=', 'person_user.sharedById').on('user.deletedAt', 'is', null),
      )
      .select(columns.user)
      .select('person_user.role')
      .whereRef('person_user.personGroupId', '=', 'person.personGroupId')
      .where('person_user.sharedWithId', '=', userId)
      .orderBy('user.name'),
  )
    .$castTo<PersonUser[]>()
    .as('sharedBy'),
  jsonArrayFrom(
    eb
      .selectFrom('person_user')
      .innerJoin('user', (join) =>
        join.onRef('user.id', '=', 'person_user.sharedWithId').on('user.deletedAt', 'is', null),
      )
      .select(columns.user)
      .select('person_user.role')
      .whereRef('person_user.personGroupId', '=', 'person.personGroupId')
      .where('person_user.sharedById', '=', userId)
      .orderBy('user.name'),
  )
    .$castTo<PersonUser[]>()
    .as('sharedWith'),
];

// computing the operand as an initplan sets the threshold first while the index can still be used
const unaccentWithThreshold = (name: string) =>
  sql<string>`(select f_unaccent(${name}) where set_config('pg_trgm.word_similarity_threshold', '0.5', true) is not null)`;

const { fn, lit, selectFrom } = expressionBuilder<DB>();
const minimumFaces = (userId: string) =>
  fn.coalesce(
    selectFrom('user_metadata')
      .select((eb) => eb.cast<number>(sql`value -> 'people' ->> 'minimumFaces'`, 'integer').as('value'))
      .where('userId', '=', userId)
      .where('key', '=', sql.lit(UserMetadataKey.Preferences)),
    lit(3),
  );

const visibleFaces = selectFrom('asset_face')
  .where('asset_face.deletedAt', 'is', null)
  .where('asset_face.isVisible', 'is', true)
  .where('asset_face.assetVisibility', '=', sql.lit(AssetVisibility.Timeline))
  .where('asset_face.assetDeletedAt', 'is', null);

const withPerson = ({ viewingUserId }: WithPersonOptions) => {
  return (eb: ExpressionBuilder<DB, 'asset_face'>) =>
    jsonObjectFrom(
      eb
        .selectFrom('person')
        .selectAll('person')
        .select(withSharing(viewingUserId))
        .whereRef('person.personGroupId', '=', 'asset_face.personGroupId')
        .where('person.ownerId', '=', viewingUserId),
    ).as('person');
};

const withFaceSearch = (eb: ExpressionBuilder<DB, 'asset_face'>) => {
  return jsonObjectFrom(
    eb.selectFrom('face_search').selectAll('face_search').whereRef('face_search.faceId', '=', 'asset_face.id'),
  ).as('faceSearch');
};

@Injectable()
export class PersonRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [{ oldPersonGroupId: DummyValue.UUID, newPersonGroupId: DummyValue.UUID }] })
  async reassignFaces({ oldPersonGroupId, faceIds, ownerId, newPersonGroupId }: UpdateFacesData): Promise<number> {
    const result = await this.db
      .updateTable('asset_face')
      .from('asset')
      .whereRef('asset_face.assetId', '=', 'asset.id')
      .set({ personGroupId: newPersonGroupId })
      .$if(!!oldPersonGroupId, (qb) => qb.where('asset_face.personGroupId', '=', oldPersonGroupId!))
      .$if(!!faceIds, (qb) => qb.where('asset_face.id', 'in', faceIds!))
      .$if(!!ownerId, (qb) => qb.where('asset.ownerId', '=', ownerId!))
      .executeTakeFirst();

    return Number(result.numUpdatedRows ?? 0);
  }

  @GenerateSql({ params: [{ oldPersonGroupId: DummyValue.UUID, newPersonGroupId: DummyValue.UUID }] })
  updateGroupId({ oldPersonGroupId, ownerId, newPersonGroupId }: UpdateGroupIdData) {
    return this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('asset_face')
        .from('asset')
        .whereRef('asset_face.assetId', '=', 'asset.id')
        .set({ personGroupId: newPersonGroupId })
        .where('asset_face.personGroupId', '=', oldPersonGroupId)
        .where('asset.ownerId', '=', ownerId)
        .executeTakeFirst();

      return trx
        .updateTable('person')
        .set({ personGroupId: newPersonGroupId })
        .where('person.personGroupId', '=', oldPersonGroupId)
        .where('person.ownerId', '=', ownerId)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  @GenerateSql({ params: [{ sourceType: SourceType.MachineLearning, clusterGroupId: DummyValue.UUID }] })
  async unassignFaces({ sourceType, clusterGroupId }: UnassignFacesOptions): Promise<void> {
    await this.db
      .updateTable('asset_face')
      .set({ personGroupId: null })
      .from('asset')
      .whereRef('asset_face.assetId', '=', 'asset.id')
      .where('asset_face.sourceType', '=', sourceType)
      .$if(!!clusterGroupId, (qb) =>
        qb.innerJoin('user', 'user.id', 'asset.ownerId').where('user.clusterGroupId', '=', clusterGroupId!),
      )
      .execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID], DummyValue.UUID] })
  @Chunked()
  async delete(personGroupIds: string[], ownerId?: string) {
    if (personGroupIds.length === 0) {
      return [];
    }

    return this.db
      .deleteFrom('person')
      .$if(!!ownerId, (qb) => qb.where('ownerId', '=', ownerId!))
      .where('person.personGroupId', 'in', personGroupIds)
      .returning(['personGroupId', 'ownerId', 'thumbnailPath'])
      .execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  @Chunked()
  async deleteGroups(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    await this.db.deleteFrom('person_group').where('person_group.id', 'in', ids).execute();
  }

  @GenerateSql()
  async deleteEmptyGroups(): Promise<number> {
    const result = await this.db
      .deleteFrom('person_group')
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('person')
              .whereRef('person.personGroupId', '=', 'person_group.id')
              .select('person.personGroupId'),
          ),
        ),
      )
      .executeTakeFirst();

    return Number(result.numDeletedRows);
  }

  @GenerateSql()
  async deleteOrphanedClusterGroups(): Promise<number> {
    const result = await this.db
      .deleteFrom('cluster_group')
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('user').whereRef('user.clusterGroupId', '=', 'cluster_group.id').select('user.id'))),
      )
      .executeTakeFirst();

    return Number(result.numDeletedRows);
  }

  async deleteFaces({ sourceType }: DeleteFacesOptions): Promise<void> {
    await this.db.deleteFrom('asset_face').where('asset_face.sourceType', '=', sourceType).execute();
  }

  @GenerateSql({
    params: [{ personGroupId: null, sourceType: SourceType.MachineLearning, clusterGroupId: DummyValue.UUID }],
    stream: true,
  })
  getAllFaces(options: GetAllFacesOptions = {}) {
    return this.db
      .selectFrom('asset_face')
      .selectAll('asset_face')
      .$if(options.personGroupId === null, (qb) => qb.where('asset_face.personGroupId', 'is', null))
      .$if(!!options.personGroupId, (qb) => qb.where('asset_face.personGroupId', '=', options.personGroupId!))
      .$if(!!options.sourceType, (qb) => qb.where('asset_face.sourceType', '=', options.sourceType!))
      .$if(!!options.assetId, (qb) => qb.where('asset_face.assetId', '=', options.assetId!))
      .$if(!!options.clusterGroupId, (qb) =>
        qb
          .innerJoin('asset', 'asset.id', 'asset_face.assetId')
          .innerJoin('user', 'user.id', 'asset.ownerId')
          .where('user.clusterGroupId', '=', options.clusterGroupId!),
      )
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', 'is', true)
      .stream();
  }

  getAll(options: GetAllPeopleOptions = {}) {
    return this.db
      .selectFrom('person')
      .selectAll('person')
      .$if(!!options.ownerId, (qb) => qb.where('person.ownerId', '=', options.ownerId!))
      .$if(options.thumbnailPath !== undefined, (qb) => qb.where('person.thumbnailPath', '=', options.thumbnailPath!))
      .$if(options.faceAssetId === null, (qb) => qb.where('person.faceAssetId', 'is', null))
      .$if(!!options.faceAssetId, (qb) => qb.where('person.faceAssetId', '=', options.faceAssetId!))
      .$if(options.isHidden !== undefined, (qb) => qb.where('person.isHidden', '=', options.isHidden!))
      .$if(!!options.withoutVerifiedThumbnail, (qb) =>
        qb.where((eb) => eb.or([eb('person.thumbnailPath', '=', ''), eb('person.thumbnailSourceFaceId', 'is', null)])),
      )
      .stream();
  }

  /**
   * fork: whether any row holds a thumbnail with no verifiable source. Probes the partial index
   * `person_thumbnail_unverified_idx`; the startup regeneration pass runs this on every start.
   */
  @GenerateSql()
  async hasUnverifiedThumbnails(): Promise<boolean> {
    const row = await this.db
      .selectFrom('person')
      .select(sql.lit(1).as('one'))
      .where('person.thumbnailPath', '<>', sql.lit(''))
      .where('person.thumbnailSourceFaceId', 'is', null)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  // FORK-PORT: lock-audit — new upstream query (d6d094738 birthday memories): selects the owner's named people with
  // a birthday today; the memory job then pulls their assets. Background jobs are never elevated, so people/assets
  // hidden by the owner's album/folder locks must not seed a birthday memory.
  @GenerateSql(
    { params: [DummyValue.UUID, { year: 2025, month: 1, day: 1 }] },
    { name: 'leap day fallback', params: [DummyValue.UUID, { year: 2025, month: 2, day: 28 }] },
  )
  async forBirthdayMemories(ownerId: string, { year, month, day }: YearMonthDay) {
    const isLeapDayBirthday = isLeapDayObserved({ year, month, day });

    const people = await this.db
      .selectFrom('person')
      .select(['person.personGroupId', 'person.name'])
      .select(sql<number>`date_part('year', person."birthDate")::int`.as('birthYear'))
      .select(sql<number>`date_part('month', person."birthDate")::int`.as('birthMonth'))
      .select(sql<number>`date_part('day', person."birthDate")::int`.as('birthDay'))
      .where('person.ownerId', '=', ownerId)
      .where('person.isHidden', '=', false)
      .where('person.name', '!=', '')
      .where('person.birthDate', 'is not', null)
      .where((eb) => {
        const bornOn = (month: number, day: number) =>
          eb.and([
            eb(sql`date_part('month', person."birthDate")::int`, '=', month),
            eb(sql`date_part('day', person."birthDate")::int`, '=', day),
          ]);

        return isLeapDayBirthday ? eb.or([bornOn(month, day), bornOn(2, 29)]) : bornOn(month, day);
      })
      .where(sql`date_part('year', person."birthDate")::int`, '<', year)
      .execute();

    return people.map(({ personGroupId, name, birthYear, birthMonth, birthDay }) => ({
      personGroupId,
      name,
      birthDate: { year: birthYear, month: birthMonth, day: birthDay },
    }));
  }

  @GenerateSql()
  getFileSamples() {
    return this.db
      .selectFrom('person')
      .select(['ownerId', 'personGroupId', 'thumbnailPath'])
      .where('thumbnailPath', '!=', sql.lit(''))
      .limit(sql.lit(3))
      .execute();
  }

  /**
   * Fork (D10): `lockVisibility` holds entries for every source owner that has locks (see getAllOwnersLockVisibility).
   * Upstream's scope is kept - own + partner faces, plus faces on assets in albums shared with the viewer - and inside
   * it each face counts only when its asset passes ITS OWNER's locks; the shared-album arm also skips shares the
   * viewer locked for themselves. People whose every in-scope face is hidden drop out of the list and of
   * total/hidden. Without any lock entries the query is upstream's, on the timeline face index.
   */
  @GenerateSql(
    { params: [{ take: 1, skip: 0 }, DummyValue.UUID, { withHidden: false, partnerIds: [DummyValue.UUID] }] },
    {
      name: 'closest person',
      params: [
        { take: 1, skip: 0 },
        DummyValue.UUID,
        { withHidden: false, partnerIds: [], closestPersonId: DummyValue.UUID },
      ],
    },
  )
  async getAllForUser(
    pagination: PaginationOptions,
    userId: string,
    options: PersonSearchOptions,
    lockVisibility: OwnerLockVisibility[] = [],
  ) {
    const ownerIds = anyUuid([userId, ...options.partnerIds]);
    const hasLocks = lockVisibility.length > 0;
    const groupFaces = visibleFaces
      .select('asset_face.personGroupId')
      .where('asset_face.personGroupId', 'in', (eb) =>
        eb.selectFrom('person').select('person.personGroupId').where('person.ownerId', '=', userId),
      )
      .$if(hasLocks, (qb) => qb.where((eb) => faceLockVisible(eb, this.db, lockVisibility)));
    const hiddenSharedAlbumIds = getViewerHiddenAlbumIds(userId, lockVisibility);

    const { people, total, hidden } = await this.db
      .with('faces', (db) =>
        db
          .selectFrom(
            groupFaces
              .where('asset_face.ownerId', '=', ownerIds)
              .unionAll(
                groupFaces
                  .where((eb) => eb.not(eb('asset_face.ownerId', '=', ownerIds)))
                  .where(inSharedAlbum(userId, 'asset_face.assetId', hiddenSharedAlbumIds)),
              )
              .as('visible'),
          )
          .select('visible.personGroupId')
          .select((eb) => eb.fn.countAll<number>().as('faceCount'))
          .groupBy('visible.personGroupId'),
      )
      .with('people', (db) =>
        db
          .selectFrom('person')
          .innerJoin('faces', 'faces.personGroupId', 'person.personGroupId')
          .selectAll('person')
          .select('faces.faceCount')
          .where('person.ownerId', '=', userId)
          .where((eb) => eb.or([eb('person.name', '!=', ''), eb('faces.faceCount', '>=', minimumFaces(userId))]))
          .$if(!!options.sharedById || !!options.sharedWithId, (qb) =>
            qb.where((eb) =>
              eb.exists(
                eb
                  .selectFrom('person_user')
                  .whereRef('person_user.personGroupId', '=', 'person.personGroupId')
                  .where((eb) =>
                    eb.or([eb('person_user.sharedById', '=', userId), eb('person_user.sharedWithId', '=', userId)]),
                  )
                  .$if(!!options.sharedById, (qb) => qb.where('person_user.sharedById', '=', options.sharedById!))
                  .$if(!!options.sharedWithId, (qb) =>
                    qb.where('person_user.sharedWithId', '=', options.sharedWithId!),
                  ),
              ),
            ),
          )
          .$if(options.isFavorite !== undefined, (qb) => qb.where('person.isFavorite', '=', options.isFavorite!))
          .$if(options.isHidden !== undefined, (qb) => qb.where('person.isHidden', '=', options.isHidden!))
          .$if(options.name !== undefined, (qb) =>
            qb.where(sql<SqlBool>`f_unaccent("person"."name") %> ${unaccentWithThreshold(options.name!)}`),
          ),
      )
      .with('page', (db) =>
        db
          .selectFrom('people')
          .selectAll('people')
          .$if(!options.withHidden && options.isHidden === undefined, (qb) => qb.where('people.isHidden', '=', false))
          .orderBy('people.isHidden', 'asc')
          .orderBy('people.isFavorite', 'desc')
          .$if(!!options.closestPersonId || !!options.closestFaceAssetId, (qb) =>
            qb.orderBy((eb) => {
              const embedding = eb.selectFrom('face_search').select('face_search.embedding');
              return eb(
                embedding.whereRef('face_search.faceId', '=', 'people.faceAssetId'),
                '<=>',
                options.closestPersonId
                  ? embedding
                      .innerJoin('person as closest', 'closest.faceAssetId', 'face_search.faceId')
                      .where('closest.ownerId', '=', userId)
                      .where('closest.personGroupId', '=', options.closestPersonId)
                  : embedding.where('face_search.faceId', '=', options.closestFaceAssetId!),
              );
            }),
          )
          .orderBy((eb) => eb('people.name', '=', sql.lit('')))
          .orderBy('people.faceCount', 'desc')
          .orderBy('people.name')
          .orderBy('people.createdAt')
          .orderBy('people.personGroupId')
          .offset(pagination.skip ?? 0)
          .limit(pagination.take + 1),
      )
      .selectFrom((eb) =>
        eb
          .selectFrom('people')
          .select((eb) => [
            eb.fn.countAll<number>().as('total'),
            eb.fn.countAll<number>().filterWhere('people.isHidden', '=', true).as('hidden'),
          ])
          .as('counts'),
      )
      .select(['counts.total', 'counts.hidden'])
      .select((eb) =>
        jsonArrayFrom(eb.selectFrom('page as person').selectAll('person').select(withSharing(userId))).as('people'),
      )
      // embedded lock-visibility subqueries rely on the root query for join deduplication
      .$if(hasLocks, (qb) => qb.withPlugin(joinDeduplicationPlugin))
      .executeTakeFirstOrThrow();

    return { ...paginationHelper(people, pagination.take), total, hidden };
  }

  @GenerateSql()
  getAllWithoutFaces() {
    return this.db
      .selectFrom('person')
      .selectAll('person')
      .leftJoin('asset_face', 'asset_face.personGroupId', 'person.personGroupId')
      .where('asset_face.deletedAt', 'is', null)
      .where((eb) => eb.or([eb('asset_face.isVisible', 'is', null), eb('asset_face.isVisible', '=', true)]))
      .having((eb) => eb.fn.count('asset_face.assetId'), '=', 0)
      .groupBy(['person.ownerId', 'person.personGroupId'])
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, { viewingUserId: DummyValue.UUID, isVisible: true }] })
  getFaces(assetId: string, options: GetFacesOptions) {
    const { viewingUserId, isVisible } = options;

    return this.db
      .selectFrom('asset_face')
      .selectAll('asset_face')
      .select(withPerson({ viewingUserId }))
      .where('asset_face.assetId', '=', assetId)
      .where('asset_face.deletedAt', 'is', null)
      .$if(isVisible !== undefined, (qb) => qb.where('asset_face.isVisible', '=', isVisible!))
      .orderBy('asset_face.boundingBoxX1', 'asc')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, { viewingUserId: DummyValue.UUID }] })
  getFaceById(id: string, { viewingUserId }: WithPersonOptions) {
    // TODO return null instead of find or fail
    return this.db
      .selectFrom('asset_face')
      .selectAll('asset_face')
      .select(withPerson({ viewingUserId }))
      .where('asset_face.id', '=', id)
      .where('asset_face.deletedAt', 'is', null)
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getFaceForFacialRecognitionJob(id: string) {
    return this.db
      .selectFrom('asset_face')
      .select(['asset_face.id', 'asset_face.personGroupId', 'asset_face.sourceType'])
      .select((eb) =>
        jsonObjectFrom(
          eb
            .selectFrom('asset')
            .innerJoin('user', 'user.id', 'asset.ownerId')
            .select(['asset.ownerId', 'asset.visibility', 'asset.fileCreatedAt', 'user.clusterGroupId'])
            .whereRef('asset.id', '=', 'asset_face.assetId'),
        ).as('asset'),
      )
      .select(withFaceSearch)
      .where('asset_face.id', '=', id)
      .where('asset_face.deletedAt', 'is', null)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [{ ownerId: DummyValue.UUID, personGroupId: DummyValue.UUID }] })
  getDataForThumbnailGenerationJob({ ownerId, personGroupId }: PersonId) {
    return this.db
      .selectFrom('person')
      .innerJoin('asset_face', 'asset_face.id', 'person.faceAssetId')
      .innerJoin('asset', 'asset_face.assetId', 'asset.id')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'person.ownerId',
        'asset_face.id as faceId',
        'asset_face.boundingBoxX1 as x1',
        'asset_face.boundingBoxY1 as y1',
        'asset_face.boundingBoxX2 as x2',
        'asset_face.boundingBoxY2 as y2',
        'asset_face.imageWidth as oldWidth',
        'asset_face.imageHeight as oldHeight',
        'asset.type',
        'asset.originalPath',
        'asset_exif.orientation as exifOrientation',
      ])
      .select((eb) => withFilePath(eb, AssetFileType.Preview).as('previewPath'))
      .where('person.ownerId', '=', ownerId)
      .where('person.personGroupId', '=', personGroupId)
      .where('asset_face.deletedAt', 'is', null)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async reassignFace(assetFaceId: string, newPersonGroupId: string): Promise<number> {
    const result = await this.db
      .updateTable('asset_face')
      .set({ personGroupId: newPersonGroupId })
      .where('asset_face.id', '=', assetFaceId)
      .executeTakeFirst();

    return Number(result.numChangedRows ?? 0);
  }

  @GenerateSql({ params: [{ ownerId: DummyValue.UUID, personGroupId: DummyValue.UUID }] })
  getByGroupId({ ownerId, personGroupId }: PersonId) {
    return this.db
      .selectFrom('person')
      .selectAll('person')
      .select(withSharing(ownerId))
      .where('person.personGroupId', '=', personGroupId)
      .where('person.ownerId', '=', ownerId)
      .executeTakeFirst();
  }

  /**
   * Fork: every thumbnail candidate for the viewer, own row first, then each sharer's row (by owner id). Each
   * candidate carries the provenance of ITS OWN row - the face recorded together with the file in
   * `thumbnailSourceFaceId`, never `faceAssetId` (which can run ahead of the file) - resolved to that face's asset and
   * the asset's owner. A null `faceId` means unverifiable (pre-upgrade crop, or the source face was deleted).
   */
  @GenerateSql({ params: [{ ownerId: DummyValue.UUID, personGroupId: DummyValue.UUID }] })
  async getForThumbnail({ ownerId, personGroupId }: PersonId): Promise<ThumbnailCandidate[]> {
    const rows = await this.db
      .selectFrom('person')
      .leftJoin('asset_face', 'asset_face.id', 'person.thumbnailSourceFaceId')
      .leftJoin('asset', 'asset.id', 'asset_face.assetId')
      .select([
        'person.thumbnailPath as path',
        'person.thumbnailSourceFaceId as faceId',
        'asset.id as assetId',
        'asset.ownerId as assetOwnerId',
      ])
      .where('person.personGroupId', '=', personGroupId)
      .where('person.thumbnailPath', '!=', sql.lit(''))
      .where((eb) =>
        eb.or([
          eb('person.ownerId', '=', ownerId),
          eb.exists(
            eb
              .selectFrom('person_user')
              .select('person_user.personGroupId')
              .whereRef('person_user.personGroupId', '=', 'person.personGroupId')
              .whereRef('person_user.sharedById', '=', 'person.ownerId')
              .where('person_user.sharedWithId', '=', ownerId),
          ),
        ]),
      )
      .orderBy((eb) => eb('person.ownerId', '=', ownerId), 'desc')
      .orderBy('person.ownerId', 'asc')
      .execute();

    return rows.map(({ path, faceId, assetId, assetOwnerId }) => ({
      path,
      provenance: { faceId, assetId: faceId ? assetId : null, assetOwnerId: faceId ? assetOwnerId : null },
    }));
  }

  /**
   * Fork: publish a generation - the new file and the face it was cropped from - as one compare-and-set. It applies
   * only while the row's feature face is still the face the job cropped; otherwise the feature face changed while the
   * job ran (stale job) and nothing is written. The old path comes from a locked CTE because RETURNING yields new
   * values. Returns the previously published path, or undefined when the job was stale.
   */
  @GenerateSql({
    params: [
      { ownerId: DummyValue.UUID, personGroupId: DummyValue.UUID, faceId: DummyValue.UUID, path: DummyValue.STRING },
    ],
  })
  async publishThumbnail({
    ownerId,
    personGroupId,
    faceId,
    path,
  }: PublishThumbnailRequest): Promise<{ previousPath: string } | undefined> {
    const { rows } = await sql<{ previousPath: string }>`
      WITH old AS (
        SELECT "thumbnailPath"
        FROM "person"
        WHERE "ownerId" = ${ownerId} AND "personGroupId" = ${personGroupId} AND "faceAssetId" = ${faceId}
        FOR UPDATE
      )
      UPDATE "person" p
      SET "thumbnailPath" = ${path}, "thumbnailSourceFaceId" = ${faceId}
      FROM old
      WHERE p."ownerId" = ${ownerId} AND p."personGroupId" = ${personGroupId}
      RETURNING old."thumbnailPath" AS "previousPath"
    `.execute(this.db);
    return rows[0];
  }

  /**
   * Fork: a storage move's publish. Only the path changes, and only while the row still holds the generation the move
   * read (path AND source unchanged); a concurrent regeneration therefore always wins. Returns whether it applied.
   */
  @GenerateSql({
    params: [
      {
        ownerId: DummyValue.UUID,
        personGroupId: DummyValue.UUID,
        oldPath: DummyValue.STRING,
        newPath: DummyValue.STRING,
        sourceFaceId: DummyValue.UUID,
      },
    ],
  })
  async updateThumbnailPathIfUnchanged({
    ownerId,
    personGroupId,
    oldPath,
    newPath,
    sourceFaceId,
  }: MoveThumbnailRequest): Promise<boolean> {
    const result = await this.db
      .updateTable('person')
      .set({ thumbnailPath: newPath })
      .where('person.ownerId', '=', ownerId)
      .where('person.personGroupId', '=', personGroupId)
      .where('person.thumbnailPath', '=', oldPath)
      .where(sql<SqlBool>`"person"."thumbnailSourceFaceId" IS NOT DISTINCT FROM ${sourceFaceId}::uuid`)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  /** Fork: the row's current published pair. */
  @GenerateSql({ params: [{ ownerId: DummyValue.UUID, personGroupId: DummyValue.UUID }] })
  getThumbnailPair({ ownerId, personGroupId }: PersonId) {
    return this.db
      .selectFrom('person')
      .select(['person.thumbnailPath', 'person.thumbnailSourceFaceId'])
      .where('person.ownerId', '=', ownerId)
      .where('person.personGroupId', '=', personGroupId)
      .executeTakeFirst();
  }

  /** Fork: whether any person row references this file; such a file must never be unlinked. */
  @GenerateSql({ params: [DummyValue.STRING] })
  async isThumbnailPathReferenced(path: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('person')
      .select(sql.lit(1).as('one'))
      .where('person.thumbnailPath', '=', path)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Fork (D10): with lock entries (every source owner's, see getAllOwnersLockVisibility), a person whose every face in
   * the viewer's scope (own + partner + shared-album, as in getAllForUser) is hidden by its asset owner's locks does not
   * surface. People with no in-scope faces at all are left as upstream returns them - only locks remove a name.
   */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING, { withHidden: true }] })
  getByName(
    userId: string,
    personName: string,
    { withHidden, partnerIds = [] }: PersonNameSearchOptions,
    lockVisibility: OwnerLockVisibility[] = [],
  ) {
    const ownerIds = anyUuid([userId, ...partnerIds]);
    const hiddenSharedAlbumIds = getViewerHiddenAlbumIds(userId, lockVisibility);
    const inScopeFaces = (eb: ExpressionBuilder<DB, 'person'>) =>
      eb
        .selectFrom('asset_face')
        .select('asset_face.id')
        .whereRef('asset_face.personGroupId', '=', 'person.personGroupId')
        .where('asset_face.deletedAt', 'is', null)
        .where('asset_face.isVisible', 'is', true)
        .where('asset_face.assetVisibility', '=', sql.lit(AssetVisibility.Timeline))
        .where('asset_face.assetDeletedAt', 'is', null)
        .where((eb) =>
          eb.or([
            eb('asset_face.ownerId', '=', ownerIds),
            inSharedAlbum(userId, 'asset_face.assetId', hiddenSharedAlbumIds),
          ]),
        );

    return this.db
      .selectFrom('person')
      .selectAll('person')
      .select(withSharing(userId))
      .where('person.ownerId', '=', userId)
      .where(sql<SqlBool>`f_unaccent("person"."name") %> ${unaccentWithThreshold(personName)}`)
      .orderBy(sql`f_unaccent("person"."name") <->>> f_unaccent(${personName})`)
      .limit(100)
      .$if(!withHidden, (qb) => qb.where('person.isHidden', '=', false))
      .$if(lockVisibility.length > 0, (qb) =>
        qb
          .where((eb) =>
            eb.or([
              eb.not(eb.exists(inScopeFaces(eb))),
              eb.exists(inScopeFaces(eb).where((eb) => faceLockVisible(eb, this.db, lockVisibility))),
            ]),
          )
          // embedded lock-visibility subqueries rely on the root query for join deduplication
          .withPlugin(joinDeduplicationPlugin),
      )
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, { withHidden: true }] })
  getDistinctNames(userId: string, { withHidden }: PersonNameSearchOptions): Promise<PersonNameResponse[]> {
    return this.db
      .selectFrom('person')
      .select(['person.personGroupId', 'person.name'])
      .distinctOn((eb) => eb.fn('lower', ['person.name']))
      .where((eb) => eb.and([eb('person.ownerId', '=', userId), eb('person.name', '!=', '')]))
      .$if(!withHidden, (qb) => qb.where('person.isHidden', '=', false))
      .execute();
  }

  /** Fork (D10): upstream's asset scope, with each source owner's locks applied inside it (see getAllForUser). */
  @GenerateSql({ params: [DummyValue.UUID, { ownerId: DummyValue.UUID, partnerIds: [DummyValue.UUID] }] })
  getStatistics(
    personGroupId: string,
    { ownerId, partnerIds }: { ownerId: string; partnerIds: string[] },
    lockVisibility: OwnerLockVisibility[] = [],
  ): Promise<PersonStatistics> {
    const ownerIds = anyUuid([ownerId, ...partnerIds]);
    const hasLocks = lockVisibility.length > 0;
    const groupFaces = visibleFaces
      .select('asset_face.assetId')
      .where('asset_face.personGroupId', '=', personGroupId)
      .$if(hasLocks, (qb) => qb.where((eb) => faceLockVisible(eb, this.db, lockVisibility)));
    return this.db
      .selectFrom(
        groupFaces
          .where('asset_face.ownerId', '=', ownerIds)
          .unionAll(
            groupFaces
              .where((eb) => eb.not(eb('asset_face.ownerId', '=', ownerIds)))
              .where(inSharedAlbum(ownerId, 'asset_face.assetId', getViewerHiddenAlbumIds(ownerId, lockVisibility))),
          )
          .as('visible'),
      )
      .select((eb) => eb.fn.count<number>('visible.assetId').distinct().as('assets'))
      .$if(hasLocks, (qb) => qb.withPlugin(joinDeduplicationPlugin))
      .executeTakeFirstOrThrow();
  }

  create(person: Insertable<PersonTable>) {
    return this.db
      .insertInto('person')
      .values(person)
      .returningAll()
      .returning(withSharing(person.ownerId))
      .executeTakeFirstOrThrow();
  }

  async createAll(people: Insertable<PersonTable>[]) {
    if (people.length === 0) {
      return [];
    }

    return this.db.insertInto('person').values(people).returningAll().execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  createGroup(ownerId: string) {
    return this.db
      .insertInto('person_group')
      .columns(['clusterGroupId'])
      .expression((eb) => eb.selectFrom('user').select('user.clusterGroupId').where('user.id', '=', ownerId))
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [{ userId: DummyValue.UUID, newClusterId: DummyValue.UUID }] })
  async reassignCluster({ userId, newClusterId }: ReassignCluster): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      // a group nobody else has people in moves across as it is
      await trx
        .updateTable('person_group')
        .set({ clusterGroupId: newClusterId })
        .where('person_group.id', 'in', (eb) =>
          eb.selectFrom('person').select('person.personGroupId').where('person.ownerId', '=', userId),
        )
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('person')
                .select('person.personGroupId')
                .whereRef('person.personGroupId', '=', 'person_group.id')
                .where('person.ownerId', '!=', userId),
            ),
          ),
        )
        .execute();

      // the rest is shared with someone else, so this user gets a group of their own for each
      const mapping = await trx
        .with('shared', (db) =>
          db
            .selectFrom('person')
            .select('person.personGroupId as oldId')
            .distinct()
            .where('person.ownerId', '=', userId)
            .where(({ exists, selectFrom }) =>
              exists(
                selectFrom('person as other')
                  .select('other.personGroupId')
                  .whereRef('other.personGroupId', '=', 'person.personGroupId')
                  .where('other.ownerId', '!=', userId),
              ),
            ),
        )
        .with(
          (cte) => cte('mapping').materialized(),
          (db) => db.selectFrom('shared').select(['shared.oldId', sql<string>`uuid_generate_v4()`.as('newId')]),
        )
        .with('created', (db) =>
          db
            .insertInto('person_group')
            .columns(['id', 'clusterGroupId'])
            .expression((eb) =>
              eb.selectFrom('mapping').select(['mapping.newId', sql.val(newClusterId).as('clusterGroupId')]),
            ),
        )
        .selectFrom('mapping')
        .select(['mapping.oldId', 'mapping.newId'])
        .execute();

      if (mapping.length === 0) {
        return;
      }

      const oldIds = mapping.map(({ oldId }) => oldId);
      const newIds = mapping.map(({ newId }) => newId);
      const remapped = sql<{
        oldId: string;
        newId: string;
      }>`(select unnest(${`{${oldIds}}`}::uuid[]) as "oldId", unnest(${`{${newIds}}`}::uuid[]) as "newId")`.as(
        'mapping',
      );

      await trx
        .updateTable('person')
        .from(remapped)
        .set((eb) => ({ personGroupId: eb.ref('mapping.newId') }))
        .whereRef('person.personGroupId', '=', 'mapping.oldId')
        .where('person.ownerId', '=', userId)
        .execute();

      await trx
        .updateTable('asset_face')
        .from(remapped)
        .set((eb) => ({ personGroupId: eb.ref('mapping.newId') }))
        .whereRef('asset_face.personGroupId', '=', 'mapping.oldId')
        .where(({ exists, selectFrom }) =>
          exists(
            selectFrom('asset')
              .select('asset.id')
              .whereRef('asset.id', '=', 'asset_face.assetId')
              .where('asset.ownerId', '=', userId),
          ),
        )
        .execute();
    });
  }

  @GenerateSql({ params: [DummyValue.UUID, 2] })
  async createGroups(personGroups: Insertable<PersonGroupTable>[]) {
    if (personGroups.length === 0) {
      return [];
    }

    return this.db.insertInto('person_group').values(personGroups).returningAll().execute();
  }

  @GenerateSql({ params: [[], [], [{ faceId: DummyValue.UUID, embedding: DummyValue.VECTOR }]] })
  async refreshFaces(
    facesToAdd: (Insertable<AssetFaceTable> & { assetId: string })[],
    faceIdsToRemove: string[],
    embeddingsToAdd?: Insertable<FaceSearchTable>[],
  ): Promise<void> {
    let query = this.db;
    if (facesToAdd.length > 0) {
      (query as any) = query.with('added', (db) => db.insertInto('asset_face').values(facesToAdd).returning('id'));
    }

    if (faceIdsToRemove.length > 0) {
      (query as any) = query.with('removed', (db) =>
        db
          .deleteFrom('asset_face')
          .where('asset_face.id', '=', (eb) => eb.fn.any(eb.val(faceIdsToRemove)))
          // ensure insert happens first to prevent deadlock on concurrent updates
          .$if(facesToAdd.length > 0, (qb) => qb.where(sql<SqlBool>`exists (select from added)`)),
      );
    }

    if (embeddingsToAdd?.length) {
      (query as any) = query.with('added_embeddings', (db) => db.insertInto('face_search').values(embeddingsToAdd));
    }

    await query.selectFrom(dummy).execute();
  }

  /**
   * Fork: never writes the thumbnail. (thumbnailPath, thumbnailSourceFaceId) is a provenance pair written only by
   * publishThumbnail (both, together) and updateThumbnailPathIfUnchanged (a move of the same generation).
   */
  async update(person: Omit<Updateable<PersonTable>, 'thumbnailPath' | 'thumbnailSourceFaceId'> & PersonId) {
    return this.db
      .updateTable('person')
      .set(person)
      .where('person.ownerId', '=', person.ownerId)
      .where('person.personGroupId', '=', person.personGroupId)
      .returningAll()
      .returning(withSharing(person.ownerId))
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [{ userId: DummyValue.UUID, personGroupId: DummyValue.UUID }, { name: DummyValue.STRING }] })
  async updateForWritableOwners(
    { userId, personGroupId }: { userId: string; personGroupId: string },
    person: Pick<Updateable<PersonTable>, 'name' | 'birthDate'>,
  ): Promise<void> {
    await this.db
      .updateTable('person')
      .set(person)
      .where('person.personGroupId', '=', personGroupId)
      .where('person.ownerId', 'in', (eb) =>
        eb
          .selectFrom('person_user')
          .select('person_user.sharedById')
          .where('person_user.personGroupId', '=', personGroupId)
          .where('person_user.sharedWithId', '=', userId)
          .where('person_user.role', 'in', [PersonUserRole.Write, PersonUserRole.Admin]),
      )
      .execute();
  }

  async updateAll(people: Insertable<PersonTable>[]): Promise<void> {
    if (people.length === 0) {
      return;
    }

    await this.db
      .insertInto('person')
      .values(people)
      .onConflict((oc) =>
        oc.columns(['ownerId', 'personGroupId']).doUpdateSet((eb) =>
          removeUndefinedKeys(
            {
              name: eb.ref('excluded.name'),
              birthDate: eb.ref('excluded.birthDate'),
              thumbnailPath: eb.ref('excluded.thumbnailPath'),
              // fork: the provenance pair is copied together; a copied path never keeps the old row's source
              thumbnailSourceFaceId: eb.ref('excluded.thumbnailSourceFaceId'),
              faceAssetId: eb.ref('excluded.faceAssetId'),
              isHidden: eb.ref('excluded.isHidden'),
              isFavorite: eb.ref('excluded.isFavorite'),
              color: eb.ref('excluded.color'),
            },
            // fork: the template decides which columns are copied; the source travels with the path
            { ...people[0], thumbnailSourceFaceId: people[0].thumbnailPath === undefined ? undefined : null },
          ),
        ),
      )
      .execute();
  }

  @GenerateSql({
    params: [[{ assetId: DummyValue.UUID, personGroupId: DummyValue.UUID }], { viewingUserId: DummyValue.UUID }],
  })
  @ChunkedArray()
  getFacesByIds(ids: AssetFaceId[], { viewingUserId }: WithPersonOptions) {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }

    const assetIds: string[] = [];
    const personGroupIds: string[] = [];
    for (const { assetId, personGroupId } of ids) {
      assetIds.push(assetId);
      personGroupIds.push(personGroupId);
    }

    return this.db
      .selectFrom('asset_face')
      .selectAll('asset_face')
      .select(withPerson({ viewingUserId }))
      .where('asset_face.assetId', 'in', assetIds)
      .where('asset_face.personGroupId', 'in', personGroupIds)
      .where('asset_face.deletedAt', 'is', null)
      .execute();
  }

  /**
   * Fork: a feature-face candidate restricted to `eligibleOwnerIds` and, with lock entries, to faces whose asset passes
   * its owner's locks. Callers run in job context (never elevated, no reveal). The asset is joined only when entries
   * exist.
   */
  @GenerateSql({ params: [DummyValue.UUID, { eligibleOwnerIds: [DummyValue.UUID] }] })
  getRandomFace(personGroupId: string, { eligibleOwnerIds, lockVisibility = [] }: RandomFaceOptions) {
    if (eligibleOwnerIds.length === 0) {
      return Promise.resolve(undefined);
    }

    return this.db
      .selectFrom('asset_face')
      .selectAll('asset_face')
      .where('asset_face.personGroupId', '=', personGroupId)
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', 'is', true)
      .where('asset_face.ownerId', '=', anyUuid(eligibleOwnerIds))
      .$if(lockVisibility.length > 0, (qb) =>
        qb.where((eb) => faceLockVisible(eb, this.db, lockVisibility)).withPlugin(joinDeduplicationPlugin),
      )
      .executeTakeFirst();
  }

  /**
   * Fork: the users whose faces may become `ownerId`'s feature face - the members of the owner's cluster group (person
   * groups are clustered per cluster group), including the owner.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getClusterMemberIds(ownerId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('user')
      .select('user.id')
      .where('user.deletedAt', 'is', null)
      .where('user.clusterGroupId', '=', (eb) =>
        eb.selectFrom('user as owner').select('owner.clusterGroupId').where('owner.id', '=', ownerId),
      )
      .execute();
    return rows.map(({ id }) => id);
  }

  @GenerateSql()
  async getLatestFaceDate(): Promise<string | undefined> {
    const result = (await this.db
      .selectFrom('asset_job_status')
      .select((eb) => sql`${eb.fn.max('asset_job_status.facesRecognizedAt')}::text`.as('latestDate'))
      .executeTakeFirst()) as { latestDate: string } | undefined;

    return result?.latestDate;
  }

  async createAssetFace(face: Insertable<AssetFaceTable>): Promise<void> {
    await this.db.insertInto('asset_face').values(face).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async deleteAssetFace(id: string): Promise<void> {
    await this.db.deleteFrom('asset_face').where('asset_face.id', '=', id).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async softDeleteAssetFaces(id: string): Promise<void> {
    await this.db.updateTable('asset_face').set({ deletedAt: new Date() }).where('asset_face.id', '=', id).execute();
  }

  @GenerateSql({ params: [[], []] })
  async updateVisibility(visible: AssetFace[], hidden: AssetFace[]): Promise<void> {
    if (visible.length === 0 && hidden.length === 0) {
      return;
    }

    await this.db.transaction().execute(async (trx) => {
      if (visible.length > 0) {
        await trx
          .updateTable('asset_face')
          .set({ isVisible: true })
          .where(
            'asset_face.id',
            'in',
            visible.map(({ id }) => id),
          )
          .execute();
      }

      if (hidden.length > 0) {
        await trx
          .updateTable('asset_face')
          .set({ isVisible: false })
          .where(
            'asset_face.id',
            'in',
            hidden.map(({ id }) => id),
          )
          .execute();
      }
    });
  }

  @GenerateSql({ params: [{ personGroupId: DummyValue.UUID, assetId: DummyValue.UUID }] })
  getForFeatureFaceUpdate({ personGroupId, assetId }: { personGroupId: string; assetId: string }) {
    return this.db
      .selectFrom('asset_face')
      .select('asset_face.id')
      .where('asset_face.assetId', '=', assetId)
      .where('asset_face.personGroupId', '=', personGroupId)
      .where('asset_face.deletedAt', 'is', null)
      .innerJoin('asset', (join) => join.onRef('asset.id', '=', 'asset_face.assetId').on('asset.isOffline', '=', false))
      .executeTakeFirst();
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  getForMergePerson(personGroupIds: string[]) {
    return this.db
      .selectFrom('person')
      .selectAll('person')
      .where('person.personGroupId', 'in', personGroupIds)
      .execute();
  }
}
