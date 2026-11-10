import { DatabaseConnectionParams, createPostgres } from '@immich/sql-tools';
import {
  AliasedRawBuilder,
  DeduplicateJoinsPlugin,
  Expression,
  ExpressionBuilder,
  Kysely,
  KyselyConfig,
  NotNull,
  OperandValueExpression,
  ReferenceExpression,
  SelectQueryBuilder,
  Selectable,
  ShallowDehydrateObject,
  SqlBool,
  expressionBuilder,
  sql,
} from 'kysely';
import { jsonArrayFrom, jsonObjectFrom } from 'kysely/helpers/postgres';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { Notice, PostgresError } from 'postgres';
import type { AudioStreamInfo, VectorExtension, VideoFormat, VideoPacketInfo, VideoStreamInfo } from 'src/types.js';
import { LockableProperty, Person, columns, lockableProperties } from 'src/database.js';
import { DummyValue, GenerateSqlQueries } from 'src/decorators.js';
import { AssetEditActionItem } from 'src/dtos/editing.dto.js';
import {
  DEFAULT_SEARCH_ORDER,
  IdsFilter,
  SearchFilterBranch,
  SearchOrder,
  StringFilter,
  StringPatternFilter,
  isAlbumConfined,
} from 'src/dtos/search.dto.js';
import {
  AssetFileType,
  AssetOrder,
  AssetOrderBy,
  AssetVisibility,
  DatabaseExtension,
  ExifOrientation,
  SearchOrderField,
} from 'src/enum.js';
import {
  AssetSearchBuilderOptions,
  AssetSearchBuilderV3Options,
  AssetSearchScope,
} from 'src/repositories/search.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetExifTable } from 'src/schema/tables/asset-exif.table.js';
import { fromChecksum } from 'src/utils/request.js';

export const getKyselyConfig = (connection: DatabaseConnectionParams): KyselyConfig => {
  return {
    dialect: new PostgresJSDialect({
      postgres: createPostgres({
        connection,
        onNotice: (notice: Notice) => {
          if (notice['severity'] !== 'NOTICE') {
            console.warn('Postgres notice:', notice);
          }
        },
      }),
    }),
    log(event) {
      if (event.level !== 'error') {
        return;
      }

      if (isAssetChecksumConstraint(event.error)) {
        return;
      }

      console.error('Query failed :', {
        durationMs: event.queryDurationMillis,
        error: event.error,
        sql: event.query.sql,
        params: event.query.parameters,
      });
    },
  };
};

const uniqueIds = (ids: string[]) => [...new Set(ids)];

export const asUuid = (id: string | Expression<string>) => sql<string>`${id}::uuid`;

export const anyUuid = (ids: string[]) => sql<string>`any(${`{${ids}}`}::uuid[])`;

export const unnest = (array: string[]) => sql<Record<string, string>>`unnest(array[${sql.join(array)}]::text[])`;

export const removeUndefinedKeys = <T extends object>(update: T, template: unknown) => {
  for (const key in update) {
    if ((template as T)[key] === undefined) {
      delete update[key];
    }
  }

  return update;
};

export const ASSET_CHECKSUM_CONSTRAINT = 'UQ_assets_owner_checksum';
export const VIDEO_STREAM_SESSION_PK_CONSTRAINT = 'video_stream_session_pkey';

export const isAssetChecksumConstraint = (error: unknown) =>
  (error as PostgresError)?.constraint_name === ASSET_CHECKSUM_CONSTRAINT;

export const isVideoStreamSessionPkConstraint = (error: unknown) =>
  (error as PostgresError)?.constraint_name === VIDEO_STREAM_SESSION_PK_CONSTRAINT;

export function withDefaultVisibility<O>(qb: SelectQueryBuilder<DB, 'asset', O>) {
  return qb.where('asset.visibility', 'in', [sql.lit(AssetVisibility.Archive), sql.lit(AssetVisibility.Timeline)]);
}

const selectExifInfo = (eb: AssetExpressionBuilder) =>
  eb.fn
    .toJson(eb.table('asset_exif'))
    .$castTo<ShallowDehydrateObject<Selectable<AssetExifTable>> | null>()
    .as('exifInfo');

// TODO come up with a better query that only selects the fields we need
export function withExif<O>(qb: SelectQueryBuilder<DB, 'asset', O>) {
  return qb.leftJoin('asset_exif', 'asset.id', 'asset_exif.assetId').select(selectExifInfo);
}

export function withExifInner<O>(qb: SelectQueryBuilder<DB, 'asset', O>) {
  return qb
    .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
    .select((eb) => eb.fn.toJson(eb.table('asset_exif')).as('exifInfo'))
    .$narrowType<{ exifInfo: NotNull }>();
}

export const dummy = sql`(select 1)`.as('dummy');

export function withAudioStream(eb: ExpressionBuilder<DB, 'asset_exif' | 'asset_audio'>) {
  return jsonObjectFrom(
    eb
      .selectFrom(dummy)
      .select(['asset_audio.index', 'asset_audio.codecName', 'asset_audio.profile', 'asset_audio.bitrate'])
      .where('asset_audio.assetId', 'is not', sql.lit(null))
      .$castTo<AudioStreamInfo | null>(),
  );
}

export function withVideoStream(eb: ExpressionBuilder<DB, 'asset_exif' | 'asset_video'>) {
  return jsonObjectFrom(
    eb
      .selectFrom(dummy)
      .select((eb) => [
        'asset_video.index',
        'asset_video.codecName',
        'asset_video.profile',
        'asset_video.level',
        'asset_video.bitrate',
        'asset_exif.exifImageWidth as width',
        'asset_exif.exifImageHeight as height',
        'asset_video.pixelFormat',
        'asset_video.frameCount',
        'asset_exif.fps as frameRate',
        'asset_video.timeBase',
        eb
          .case()
          .when('asset_exif.orientation', '=', sql.lit(ExifOrientation.Rotate90CW.toString()))
          .then(sql.lit(-90))
          .when('asset_exif.orientation', '=', sql.lit(ExifOrientation.Rotate270CW.toString()))
          .then(sql.lit(90))
          .when('asset_exif.orientation', '=', sql.lit(ExifOrientation.Rotate180.toString()))
          .then(sql.lit(180))
          .else(0)
          .end()
          .as('rotation'),
        'asset_video.colorPrimaries',
        'asset_video.colorMatrix',
        'asset_video.colorTransfer',
        'asset_video.dvProfile',
        'asset_video.dvLevel',
        'asset_video.dvBlSignalCompatibilityId',
      ])
      .where('asset_video.assetId', 'is not', sql.lit(null)),
  ).$castTo<(VideoStreamInfo & { timeBase: number }) | null>();
}

export function withVideoFormat(eb: ExpressionBuilder<DB, 'asset' | 'asset_video'>) {
  return jsonObjectFrom(
    eb
      .selectFrom(dummy)
      .select(['asset_video.formatName', 'asset_video.formatLongName', 'asset.duration', 'asset_video.bitrate'])
      .where('asset_video.assetId', 'is not', sql.lit(null)),
  ).$castTo<VideoFormat | null>();
}

export function withVideoPackets(eb: ExpressionBuilder<DB, 'asset' | 'asset_keyframe'>) {
  return jsonObjectFrom(
    eb
      .selectFrom(dummy)
      .where('asset_keyframe.assetId', 'is not', sql.lit(null))
      .select([
        'asset_keyframe.pts as keyframePts',
        'asset_keyframe.accDuration as keyframeAccDuration',
        'asset_keyframe.ownDuration as keyframeOwnDuration',
        'asset_keyframe.totalDuration',
        'asset_keyframe.packetCount',
        'asset_keyframe.outputFrames',
      ]),
  ).$castTo<VideoPacketInfo | null>();
}

export function withSmartSearch<O>(qb: SelectQueryBuilder<DB, 'asset', O>) {
  return qb
    .leftJoin('smart_search', 'asset.id', 'smart_search.assetId')
    .select((eb) => jsonObjectFrom(eb.table('smart_search')).as('smartSearch'));
}

export function withFaces(eb: ExpressionBuilder<DB, 'asset'>, withHidden?: boolean, withDeletedFace?: boolean) {
  return jsonArrayFrom(
    eb
      .selectFrom('asset_face')
      .selectAll('asset_face')
      .whereRef('asset_face.assetId', '=', 'asset.id')
      .$if(!withDeletedFace, (qb) => qb.where('asset_face.deletedAt', 'is', null))
      .$if(!withHidden, (qb) => qb.where('asset_face.isVisible', '=', true)),
  ).as('faces');
}

export function withFiles(eb: ExpressionBuilder<DB, 'asset'>, type?: AssetFileType) {
  return jsonArrayFrom(
    eb
      .selectFrom('asset_file')
      .select(columns.assetFiles)
      .whereRef('asset_file.assetId', '=', 'asset.id')
      .$if(!!type, (qb) => qb.where('asset_file.type', '=', type!)),
  ).as('files');
}

export function withFilePath(eb: ExpressionBuilder<DB, 'asset'>, type: AssetFileType, isEdited = false) {
  return eb
    .selectFrom('asset_file')
    .select('asset_file.path')
    .whereRef('asset_file.assetId', '=', 'asset.id')
    .where('asset_file.type', '=', sql.lit(type))
    .where('asset_file.isEdited', '=', sql.lit(isEdited));
}

export type WithFacesAndPeopleOptions = {
  /** whose version of the person to select */
  viewingUserId?: string;
  withHidden?: boolean;
  withDeletedFace?: boolean;
};

export function withFacesAndPeople({ viewingUserId, withHidden, withDeletedFace }: WithFacesAndPeopleOptions) {
  return (eb: ExpressionBuilder<DB, 'asset'>) =>
    jsonArrayFrom(
      eb
        .selectFrom('asset_face')
        .leftJoinLateral(
          (eb) =>
            eb
              .selectFrom('person')
              .selectAll('person')
              .whereRef('person.personGroupId', '=', 'asset_face.personGroupId')
              .$if(!viewingUserId, (qb) => qb.whereRef('person.ownerId', '=', 'asset.ownerId'))
              .$if(!!viewingUserId, (qb) => qb.where('person.ownerId', '=', viewingUserId!))
              .as('person'),
          (join) => join.onTrue(),
        )
        .selectAll('asset_face')
        .select((eb) => eb.table('person').$castTo<ShallowDehydrateObject<Person>>().as('person'))
        .whereRef('asset_face.assetId', '=', 'asset.id')
        .$if(!withDeletedFace, (qb) => qb.where('asset_face.deletedAt', 'is', null))
        .$if(!withHidden, (qb) => qb.where('asset_face.isVisible', 'is', true)),
    ).as('faces');
}

export function hasPeople<O>(qb: SelectQueryBuilder<DB, 'asset', O>, personGroupIds: string[]) {
  return qb.innerJoin(
    (eb) =>
      eb
        .selectFrom('asset_face')
        .select('assetId')
        .where('personGroupId', '=', anyUuid(personGroupIds!))
        .where('deletedAt', 'is', null)
        .where('isVisible', 'is', true)
        .groupBy('assetId')
        .having((eb) => eb.fn.count('personGroupId').distinct(), '=', personGroupIds.length)
        .as('has_people'),
    (join) => join.onRef('has_people.assetId', '=', 'asset.id'),
  );
}

/**
 * Fork: `hiddenAlbumIds` are the viewer's own effectively hidden albums (their lock entry, reveal already applied).
 * A share the viewer locked for themselves must not surface its assets through this path (spec §15.1), while another,
 * unlocked share of the same asset still counts.
 */
export function inSharedAlbum(
  userId: string,
  assetId: 'asset.id' | 'asset_face.assetId',
  hiddenAlbumIds: string[] = [],
) {
  const eb = expressionBuilder<DB, 'asset' | 'asset_face'>();
  return eb.exists(
    eb
      .selectFrom('album_asset')
      .select(sql.lit(1).as('exists'))
      .innerJoin('album', (join) =>
        join.onRef('album.id', '=', 'album_asset.albumId').on('album.deletedAt', 'is', null),
      )
      .innerJoin('album_user', (join) =>
        join.onRef('album_user.albumId', '=', 'album.id').on('album_user.userId', '=', userId),
      )
      .whereRef('album_asset.assetId', '=', assetId)
      .$if(hiddenAlbumIds.length > 0, (qb) => qb.where((eb) => eb.not(eb('album.id', '=', anyUuid(hiddenAlbumIds))))),
  );
}

export function inAlbums<O>(qb: SelectQueryBuilder<DB, 'asset', O>, albumIds: string[]) {
  return qb.innerJoin(
    (eb) =>
      eb
        .selectFrom('album_asset')
        .select('assetId')
        .where('albumId', '=', anyUuid(albumIds!))
        .groupBy('assetId')
        .having((eb) => eb.fn.count('albumId').distinct(), '=', albumIds.length)
        .as('has_album'),
    (join) => join.onRef('has_album.assetId', '=', 'asset.id'),
  );
}

export function hasTags<O>(qb: SelectQueryBuilder<DB, 'asset', O>, tagIds: string[]) {
  return qb.innerJoin(
    (eb) =>
      eb
        .selectFrom('tag_asset')
        .select('assetId')
        .innerJoin('tag_closure', 'tag_asset.tagId', 'tag_closure.id_descendant')
        .where('tag_closure.id_ancestor', '=', anyUuid(tagIds))
        .groupBy('assetId')
        .having((eb) => eb.fn.count('tag_closure.id_ancestor').distinct(), '>=', tagIds.length)
        .as('has_tags'),
    (join) => join.onRef('has_tags.assetId', '=', 'asset.id'),
  );
}

export function withOwner(eb: ExpressionBuilder<DB, 'asset'>) {
  return jsonObjectFrom(eb.selectFrom('user').select(columns.user).whereRef('user.id', '=', 'asset.ownerId')).as(
    'owner',
  );
}

export function withLibrary(eb: ExpressionBuilder<DB, 'asset'>) {
  return jsonObjectFrom(
    eb.selectFrom('library').selectAll('library').whereRef('library.id', '=', 'asset.libraryId'),
  ).as('library');
}

export function withTags(eb: ExpressionBuilder<DB, 'asset'>) {
  return jsonArrayFrom(
    eb
      .selectFrom('tag')
      .select(columns.tag)
      .innerJoin('tag_asset', 'tag.id', 'tag_asset.tagId')
      .whereRef('asset.id', '=', 'tag_asset.assetId'),
  ).as('tags');
}

export function truncatedDate<O>(order: AssetOrderBy = AssetOrderBy.TakenAt, size?: 'DAY' | 'MONTH') {
  return sql<O>`date_trunc(${sql.lit(size ?? 'MONTH')}, ${sql.ref(order === AssetOrderBy.CreatedAt ? 'asset.createdAt' : 'localDateTime')} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
}

export function withTagId<O>(qb: SelectQueryBuilder<DB, 'asset', O>, tagId: string) {
  return qb.where((eb) =>
    eb.exists(
      eb
        .selectFrom('tag_closure')
        .innerJoin('tag_asset', 'tag_asset.tagId', 'tag_closure.id_descendant')
        .whereRef('tag_asset.assetId', '=', 'asset.id')
        .where('tag_closure.id_ancestor', '=', tagId),
    ),
  );
}

const isCJK = (c: number): boolean =>
  (c >= 0x4e_00 && c <= 0x9f_ff) ||
  (c >= 0xac_00 && c <= 0xd7_af) ||
  (c >= 0x30_40 && c <= 0x30_9f) ||
  (c >= 0x30_a0 && c <= 0x30_ff) ||
  (c >= 0x34_00 && c <= 0x4d_bf);

export const tokenizeForSearch = (text: string): string[] => {
  /* eslint-disable unicorn/prefer-code-point */
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c <= 32) {
      i++;
      continue;
    }

    const start = i;
    if (isCJK(c)) {
      while (i < text.length && isCJK(text.charCodeAt(i))) {
        i++;
      }
      if (i - start === 1) {
        tokens.push(text[start]);
      } else {
        for (let k = start; k < i - 1; k++) {
          tokens.push(text[k] + text[k + 1]);
        }
      }
    } else {
      while (i < text.length && text.charCodeAt(i) > 32 && !isCJK(text.charCodeAt(i))) {
        i++;
      }
      tokens.push(text.slice(start, i));
    }
  }
  return tokens;
};

// needed to properly type the return with the EditActionItem discriminated union type
type AliasedEditActions = AliasedRawBuilder<AssetEditActionItem[], 'edits'>;
export function withEdits(eb: ExpressionBuilder<DB, 'asset'>): AliasedEditActions {
  return jsonArrayFrom(
    eb
      .selectFrom('asset_edit')
      .select(['asset_edit.action', 'asset_edit.parameters'])
      .whereRef('asset_edit.assetId', '=', 'asset.id'),
  ).as('edits') as AliasedEditActions;
}

// Also attached at query level by consumers that embed searchAssetBuilder() output as a
// subquery: an embedded builder's own plugins do not run, only the root query's do.
export const joinDeduplicationPlugin = new DeduplicateJoinsPlugin();
/** TODO: This should only be used for search-related queries, not as a general purpose query builder */

/**
 * Single-column (asset.id) form of searchAssetBuilder for embedding as an `IN (...)` subquery.
 * The embedding root query must attach {@link joinDeduplicationPlugin} — an embedded builder's
 * own plugins do not run.
 */
export function searchAssetIdSubquery(
  kysely: Kysely<DB>,
  options: AssetSearchBuilderOptions,
): SelectQueryBuilder<DB, 'asset', { id: string }> {
  // Smart-album filters are stored in the legacy options shape, so they evaluate via the
  // legacy builder (kept by upstream for the v1 search APIs).
  return searchAssetBuilderLegacy(kysely, options).select('asset.id').$castTo<{ id: string }>() as SelectQueryBuilder<
    DB,
    'asset',
    { id: string }
  >;
}

/**
 * Per-owner locked-content visibility, precomputed once per request (see
 * utils/lock-visibility.ts). An entry exists only for owners with at least one effectively
 * hidden album; owners without an entry are untouched by the filter.
 */
export interface OwnerLockVisibility {
  ownerId: string;
  /** Effectively hidden album row ids (regular and smart), after reveal subtraction. */
  hiddenAlbumIds: string[];
  /** Owner-scoped, evaluable filters of the owner's HIDDEN smart albums. */
  hiddenSmartFilters: AssetSearchBuilderOptions[];
  /** Owner-scoped, evaluable filters of the owner's VISIBLE smart albums. */
  visibleSmartFilters: AssetSearchBuilderOptions[];
}

/**
 * Locked-content asset filter (spec §7.3): an asset of a lock-holding owner is visible iff
 * at least one of its containers is unlocked - a regular-album membership pointing at a
 * non-hidden album, or a match by a visible smart album - or it has no containers at all
 * (not in any live album and matched by no smart album; zero-container assets are never
 * hidden by the lock mechanism).
 *
 * Assets of owners without an entry pass through untouched. Smart-album membership is
 * embedded as id subqueries; the ROOT query must therefore attach
 * {@link joinDeduplicationPlugin} (searchAssetBuilder-rooted queries already do).
 *
 * Note on the spec's fast-path 3 ("skip visible-smart evaluation when no smart album is
 * locked"): that shortcut is unsound - an unlocked smart album can rescue an asset whose
 * regular albums are all locked - so visible-smart subqueries are included whenever the
 * owner has anything hidden.
 */
export function withLockVisibility<O>(
  qb: SelectQueryBuilder<DB, 'asset', O>,
  db: Kysely<DB>,
  entries: OwnerLockVisibility[],
): SelectQueryBuilder<DB, 'asset', O> {
  if (entries.length === 0) {
    return qb;
  }
  return qb.where((eb) => lockVisibilityExpression(eb, db, entries));
}

/**
 * The predicate behind {@link withLockVisibility}, for callers that combine it with other grants (e.g. person
 * timelines, where an album shared with the viewer grants an asset regardless of the album owner's locks). Requires a
 * non-empty `entries`.
 */
export function lockVisibilityExpression(
  eb: ExpressionBuilder<DB, 'asset'>,
  db: Kysely<DB>,
  entries: OwnerLockVisibility[],
) {
  const ownersWithLocks = entries.map(({ ownerId }) => ownerId);
  const unionSmart = (filters: AssetSearchBuilderOptions[]) => {
    let union = searchAssetIdSubquery(db, filters[0]);
    for (const filter of filters.slice(1)) {
      union = union.union(searchAssetIdSubquery(db, filter));
    }
    return union;
  };

  // Fork (7A.2, audit 2): a Live Photo motion part M (visibility=hidden, referenced by still.livePhotoVideoId) usually
  // has no container of its own, so judged alone it passed the zero-container clause and escaped its still's lock.
  // M is therefore judged together with the stills referencing it, as one unit: visible iff some member of the unit
  // has a visible container, or no member has any container. So a container-less M is hidden iff every still is
  // hidden, an independent visible container of M itself still grants, and a visible Live Photo keeps its motion
  // part (M is never rejected merely for being hidden). M's own memberships count too, so an M filed only into a
  // locked album stays hidden even beside an uncontained still. Stills share M's owner (live photos are only linked
  // within one library), so the unit is judged under that owner's entry. Rows that are not hidden-visibility skip the
  // still lookup (one-time filter); every other asset's unit is just itself, which reproduces the plain rule.
  const motionStills = () =>
    eb
      .selectFrom('asset as still')
      .select('still.id')
      .whereRef('still.livePhotoVideoId', '=', 'asset.id')
      .where('asset.visibility', '=', sql.lit(AssetVisibility.Hidden));
  const unit = () => sql<{ id: string }>`(select ${eb.ref('asset.id')} as id union all ${motionStills()})`.as('unit');
  const inSmart = (filters: AssetSearchBuilderOptions[]) =>
    eb.or([
      eb('asset.id', 'in', unionSmart(filters)),
      eb.exists(motionStills().where('still.id', 'in', unionSmart(filters))),
    ]);

  // Container memberships only count when the lock owner can see the album - via their
  // own album_user row (owner or sharee) OR via a folder share on an ancestor container
  // (album_container_user + closure), mirroring checkAlbumAccess. A membership in a
  // stranger's album must neither rescue an asset from the owner's locks nor count
  // against the zero-container clause: the owner's privacy cannot depend on albums they
  // cannot see or control. The cascade branch matters for lockable folder shares: an
  // asset whose only lock-owner-visible container is a cascade-shared album must count
  // that album (and hide when the folder is locked), not read as zero-container.
  //
  // One aggregate decides the regular-album side: NULL when the unit has no such membership (zero-container), true
  // when some membership is in a non-hidden album, false when all are hidden. Folding the visible and zero-container
  // probes into one subquery keeps the per-row cost (and so the planner's estimate) at a single membership lookup.
  const regularVerdict = (entry: OwnerLockVisibility) =>
    eb
      .selectFrom(unit())
      .innerJoin('album_asset', 'album_asset.assetId', 'unit.id')
      .innerJoin('album', (join) =>
        join.onRef('album.id', '=', 'album_asset.albumId').on('album.deletedAt', 'is', null),
      )
      .select((eb2) =>
        eb2.fn
          .agg<boolean>('bool_or', [eb2.not(eb2('album_asset.albumId', '=', anyUuid(entry.hiddenAlbumIds)))])
          .as('visible'),
      )
      .where((eb2) =>
        eb2.or([
          eb2.exists(
            eb2
              .selectFrom('album_user')
              .select('album_user.userId')
              .whereRef('album_user.albumId', '=', 'album.id')
              .where('album_user.userId', '=', asUuid(entry.ownerId)),
          ),
          eb2.exists(
            eb2
              .selectFrom('album_container_closure as lock_closure')
              .innerJoin(
                'album_container_user as lock_folder_user',
                'lock_folder_user.albumContainerId',
                'lock_closure.id_ancestor',
              )
              .select('lock_closure.id_descendant')
              .whereRef('lock_closure.id_descendant', '=', 'album.containerId')
              .where('lock_folder_user.userId', '=', asUuid(entry.ownerId)),
          ),
        ]),
      );

  return eb.or([
    eb.not(eb('asset.ownerId', '=', anyUuid(ownersWithLocks))),
    ...entries.map((entry) => {
      // Visible via an unlocked (live) regular-album membership; with no membership at all, visible unless a hidden
      // smart album matches (zero-container rule).
      const zeroContainer =
        entry.hiddenSmartFilters.length > 0 ? eb.not(inSmart(entry.hiddenSmartFilters)) : sql.lit(true);
      const ownerClauses = [eb.fn.coalesce(regularVerdict(entry), zeroContainer)];
      // Visible via a match by a visible smart album.
      if (entry.visibleSmartFilters.length > 0) {
        ownerClauses.push(inSmart(entry.visibleSmartFilters));
      }
      return eb.and([eb('asset.ownerId', '=', asUuid(entry.ownerId)), eb.or(ownerClauses)]);
    }),
  ]);
}

/**
 * Fork: {@link withLockVisibility} for a face row - the face passes when its asset passes the asset owner's locks.
 * Faces of owners without an entry short-circuit on the denormalized `asset_face.ownerId`, and the `asset` row is
 * only consulted when entries exist, so callers apply this only when `entries` is non-empty (no locks anywhere keeps
 * the `asset_face_personGroupId_ownerId_assetId_timeline_idx` fast path). The root query must attach
 * {@link joinDeduplicationPlugin}.
 */
export function faceLockVisible(
  eb: ExpressionBuilder<DB, 'asset_face'>,
  db: Kysely<DB>,
  entries: OwnerLockVisibility[],
) {
  return eb.or([
    eb.not(eb('asset_face.ownerId', '=', anyUuid(entries.map(({ ownerId }) => ownerId)))),
    eb.exists(
      withLockVisibility(
        eb.selectFrom('asset').select('asset.id').whereRef('asset.id', '=', 'asset_face.assetId'),
        db,
        entries,
      ),
    ),
  ]);
}

/**
 * Fork (ruling R71): the inverse of {@link faceLockVisible} for writes - true for a face whose asset is hidden for
 * its owner under `entries` (job-context entries: the owner's own locks, no reveal). Classification rebuilds exclude
 * these faces so a locked smart album filtering by person keeps matching. Callers apply it only when `entries` is
 * non-empty, and the root query must attach {@link joinDeduplicationPlugin}.
 */
export function faceLockHidden(
  eb: ExpressionBuilder<DB, 'asset_face'>,
  db: Kysely<DB>,
  entries: OwnerLockVisibility[],
) {
  return eb.not(faceLockVisible(eb, db, entries));
}

/**
 * Fork (ruling R56): a lock-filtered list's `livePhotoVideoId` for the `asset` row - the still's motion part id when
 * that motion part passes the same `entries` (judged as the 7A.2 Live Photo unit by its owner's entry), otherwise
 * null, so a visible still never enumerates a hidden motion part. `grant` is the list's album arm, if it has one: a
 * still granted through an album reaches its motion part the same way (checkAlbumAccess grants it through the still).
 * An empty `entries` returns the column untouched, so lists without lock entries pay nothing.
 *
 * The motion part is aliased in a middle query because {@link withLockVisibility} judges the table named `asset`,
 * which shadows the outer row.
 */
export function lockVisibleLivePhotoVideoId(
  eb: ExpressionBuilder<DB, 'asset'>,
  db: Kysely<DB>,
  entries: OwnerLockVisibility[],
  grant?: Expression<SqlBool>,
) {
  if (entries.length === 0) {
    return eb.ref('asset.livePhotoVideoId');
  }
  const motionVisible = eb.exists(
    eb
      .selectFrom('asset as motion_part')
      .select('motion_part.id')
      .whereRef('motion_part.id', '=', 'asset.livePhotoVideoId')
      .where((eb2) =>
        eb2.exists(
          withLockVisibility(
            db.selectFrom('asset').select('asset.id').where('asset.id', '=', sql.ref<string>('motion_part.id')),
            db,
            entries,
          ),
        ),
      ),
  );
  return eb
    .case()
    .when(grant ? eb.or([grant, motionVisible]) : motionVisible)
    .then(eb.ref('asset.livePhotoVideoId'))
    .end();
}

/** The viewer's own effectively hidden album ids from a lock-visibility list (empty when the viewer hides nothing). */
export const getViewerHiddenAlbumIds = (viewerId: string, entries: OwnerLockVisibility[] | undefined) =>
  entries?.find(({ ownerId }) => ownerId === viewerId)?.hiddenAlbumIds ?? [];

/**
 * Fork (R56 follow-up): with lock entries, "is a Live Photo" means the same as the output column - a still whose motion
 * part is hidden counts as no Live Photo, so `isMotion` is no existence oracle for the hidden motion part.
 */
const isLivePhotoPredicate = (
  eb: ExpressionBuilder<DB, 'asset'>,
  kysely: Kysely<DB>,
  entries: OwnerLockVisibility[],
  isMotion: boolean,
) => eb(lockVisibleLivePhotoVideoId(eb, kysely, entries), isMotion ? 'is not' : 'is', null);

export function searchAssetBuilderLegacy(kysely: Kysely<DB>, options: AssetSearchBuilderOptions) {
  options.withDeleted ||= !!(options.trashedAfter || options.trashedBefore || options.isOffline);

  return kysely
    .withPlugin(joinDeduplicationPlugin)
    .selectFrom('asset')
    .$if(!!options.visibility, (qb) =>
      options.visibility === 'not-locked'
        ? qb.where('asset.visibility', '!=', AssetVisibility.Locked)
        : qb.where('asset.visibility', '=', options.visibility!),
    )
    .$if(!!options.albumIds && options.albumIds.length > 0, (qb) => inAlbums(qb, options.albumIds!))
    .$if(!!options.tagIds && options.tagIds.length > 0, (qb) => hasTags(qb, options.tagIds!))
    .$if(options.tagIds === null, (qb) =>
      qb.where((eb) => eb.not(eb.exists((eb) => eb.selectFrom('tag_asset').whereRef('assetId', '=', 'asset.id')))),
    )
    .$if(!!options.personIds && options.personIds.length > 0, (qb) => hasPeople(qb, options.personIds!))
    .$if(!!options.createdBefore, (qb) => qb.where('asset.createdAt', '<=', options.createdBefore!))
    .$if(!!options.createdAfter, (qb) => qb.where('asset.createdAt', '>=', options.createdAfter!))
    .$if(!!options.updatedBefore, (qb) => qb.where('asset.updatedAt', '<=', options.updatedBefore!))
    .$if(!!options.updatedAfter, (qb) => qb.where('asset.updatedAt', '>=', options.updatedAfter!))
    .$if(!!options.trashedBefore, (qb) => qb.where('asset.deletedAt', '<=', options.trashedBefore!))
    .$if(!!options.trashedAfter, (qb) => qb.where('asset.deletedAt', '>=', options.trashedAfter!))
    .$if(!!options.takenBefore, (qb) => qb.where('asset.fileCreatedAt', '<=', options.takenBefore!))
    .$if(!!options.takenAfter, (qb) => qb.where('asset.fileCreatedAt', '>=', options.takenAfter!))
    .$if(options.city !== undefined, (qb) =>
      qb
        .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .where('asset_exif.city', options.city === null ? 'is' : '=', options.city!),
    )
    .$if(options.state !== undefined, (qb) =>
      qb
        .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .where('asset_exif.state', options.state === null ? 'is' : '=', options.state!),
    )
    .$if(options.country !== undefined, (qb) =>
      qb
        .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .where('asset_exif.country', options.country === null ? 'is' : '=', options.country!),
    )
    .$if(options.make !== undefined, (qb) =>
      qb
        .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .where('asset_exif.make', options.make === null ? 'is' : '=', options.make!),
    )
    .$if(options.model !== undefined, (qb) =>
      qb
        .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .where('asset_exif.model', options.model === null ? 'is' : '=', options.model!),
    )
    .$if(options.lensModel !== undefined, (qb) =>
      qb
        .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .where('asset_exif.lensModel', options.lensModel === null ? 'is' : '=', options.lensModel!),
    )
    .$if(options.rating !== undefined, (qb) =>
      qb
        .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .where('asset_exif.rating', options.rating === null ? 'is' : '=', options.rating!),
    )
    .$if(!!options.checksum, (qb) => qb.where('asset.checksum', '=', options.checksum!))
    .$if(!!options.id, (qb) => qb.where('asset.id', '=', asUuid(options.id!)))
    .$if(!!options.libraryId, (qb) => qb.where('asset.libraryId', '=', asUuid(options.libraryId!)))
    .$if(!!options.userIds, (qb) => qb.where('asset.ownerId', '=', anyUuid(options.userIds!)))
    .$if(!!options.encodedVideoPath, (qb) =>
      qb
        .innerJoin('asset_file', (join) =>
          join
            .onRef('asset.id', '=', 'asset_file.assetId')
            .on('asset_file.type', '=', AssetFileType.EncodedVideo)
            .on('asset_file.isEdited', '=', false),
        )
        .where('asset_file.path', '=', options.encodedVideoPath!),
    )
    .$if(!!options.originalPath, (qb) =>
      qb.where(sql`f_unaccent(asset."originalPath")`, 'ilike', sql`'%' || f_unaccent(${options.originalPath}) || '%'`),
    )
    .$if(!!options.originalFileName, (qb) =>
      qb.where(
        sql`f_unaccent(asset."originalFileName")`,
        'ilike',
        sql`'%' || f_unaccent(${options.originalFileName}) || '%'`,
      ),
    )
    .$if(!!options.description, (qb) =>
      qb
        .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .where(sql`f_unaccent(asset_exif.description)`, 'ilike', sql`'%' || f_unaccent(${options.description}) || '%'`),
    )
    .$if(!!options.ocr, (qb) =>
      qb
        .innerJoin('ocr_search', 'asset.id', 'ocr_search.assetId')
        .where(() => sql`f_unaccent(ocr_search.text) %>> f_unaccent(${tokenizeForSearch(options.ocr!).join(' ')})`),
    )
    .$if(!!options.type, (qb) => qb.where('asset.type', '=', options.type!))
    .$if(options.isFavorite !== undefined, (qb) => qb.where('asset.isFavorite', '=', options.isFavorite!))
    .$if(options.isOffline !== undefined, (qb) => qb.where('asset.isOffline', '=', options.isOffline!))
    .$if(options.isEncoded !== undefined, (qb) =>
      qb.where((eb) => {
        const exists = eb.exists((eb) =>
          eb
            .selectFrom('asset_file')
            .whereRef('assetId', '=', 'asset.id')
            .where('type', '=', AssetFileType.EncodedVideo),
        );
        return options.isEncoded ? exists : eb.not(exists);
      }),
    )
    .$if(options.isMotion !== undefined, (qb) =>
      qb.where((eb) => isLivePhotoPredicate(eb, kysely, options.lockVisibility ?? [], options.isMotion!)),
    )
    .$if(!!options.isNotInAlbum && (!options.albumIds || options.albumIds.length === 0), (qb) =>
      qb.where((eb) => eb.not(eb.exists((eb) => eb.selectFrom('album_asset').whereRef('assetId', '=', 'asset.id')))),
    )
    .$if(options.withStacked === false, (qb) => qb.where('asset.stackId', 'is', null))
    .$if(!!options.withExif, withExifInner)
    .$if(!!(options.withFaces || options.withPeople), (qb) =>
      qb.select(withFacesAndPeople({ viewingUserId: options.viewingUserId! })),
    )
    .$if(!options.withDeleted, (qb) => qb.where('asset.deletedAt', 'is', null))
    .$if(!!options.lockVisibility && options.lockVisibility.length > 0, (qb) =>
      withLockVisibility(qb, kysely, options.lockVisibility!),
    );
}

type AssetExpressionBuilder = ExpressionBuilder<DB, 'asset' | 'asset_exif'>;

const albumAssets = (eb: AssetExpressionBuilder) =>
  eb.selectFrom('album_asset').whereRef('album_asset.assetId', '=', 'asset.id');

const visibleFaces = (eb: AssetExpressionBuilder) =>
  eb
    .selectFrom('asset_face')
    .whereRef('asset_face.assetId', '=', 'asset.id')
    .where('asset_face.deletedAt', 'is', null)
    .where('asset_face.isVisible', '=', true);

const tagAssets = (eb: AssetExpressionBuilder) =>
  eb.selectFrom('tag_asset').whereRef('tag_asset.assetId', '=', 'asset.id');

// shared any/all/none mechanics; `matchesAll` only receives deduplicated multi-id lists,
// so its `count(distinct id) = ids.length` check stays satisfiable
function idsPredicates(
  eb: AssetExpressionBuilder,
  { any, all, none }: IdsFilter = {},
  ops: {
    matchesAny: (ids: string[]) => Expression<SqlBool>;
    matchesAll: (ids: string[]) => Expression<SqlBool>;
  },
) {
  const predicates: Expression<SqlBool>[] = [];
  if (any) {
    predicates.push(ops.matchesAny(any));
  }
  if (all) {
    const ids = uniqueIds(all);
    predicates.push(ids.length === 1 ? ops.matchesAny(ids) : ops.matchesAll(ids));
  }
  if (none) {
    predicates.push(eb.not(ops.matchesAny(none)));
  }
  return predicates;
}

function albumIdsPredicates(eb: AssetExpressionBuilder, filter?: IdsFilter) {
  const matching = (ids: string[]) => albumAssets(eb).where('album_asset.albumId', '=', anyUuid(ids));
  return idsPredicates(eb, filter, {
    matchesAny: (ids) => eb.exists(matching(ids)),
    matchesAll: (ids) =>
      eb.exists(
        matching(ids)
          .select('album_asset.assetId')
          .groupBy('album_asset.assetId')
          .having((eb) => eb.fn.count('album_asset.albumId').distinct(), '=', ids.length),
      ),
  });
}

function personIdsPredicates(eb: AssetExpressionBuilder, filter?: IdsFilter) {
  const matching = (ids: string[]) => visibleFaces(eb).where('asset_face.personGroupId', '=', anyUuid(ids));
  return idsPredicates(eb, filter, {
    matchesAny: (ids) => eb.exists(matching(ids)),
    matchesAll: (ids) =>
      eb.exists(
        matching(ids)
          .select('asset_face.assetId')
          .groupBy('asset_face.assetId')
          .having((eb) => eb.fn.count('asset_face.personGroupId').distinct(), '=', ids.length),
      ),
  });
}

function tagIdsPredicates(eb: AssetExpressionBuilder, filter?: IdsFilter) {
  const matching = (ids: string[]) =>
    tagAssets(eb)
      .innerJoin('tag_closure', 'tag_asset.tagId', 'tag_closure.id_descendant')
      .where('tag_closure.id_ancestor', '=', anyUuid(ids));
  return idsPredicates(eb, filter, {
    matchesAny: (ids) => eb.exists(matching(ids)),
    matchesAll: (ids) =>
      eb.exists(
        matching(ids)
          .select('tag_asset.assetId')
          .groupBy('tag_asset.assetId')
          .having((eb) => eb.fn.count('tag_closure.id_ancestor').distinct(), '=', ids.length),
      ),
  });
}

type ComparisonFilter<T> = {
  eq?: T | null;
  ne?: T | null;
  lt?: T;
  lte?: T;
  gt?: T;
  gte?: T;
  in?: T[];
  notIn?: T[];
};

// one operator dispatch for every filter shape; the DTO schemas constrain which
// operators (and null literals) each filter can actually carry
function comparisonPredicates<TB extends keyof DB, RE extends ReferenceExpression<DB, TB>>(
  eb: ExpressionBuilder<DB, TB>,
  column: RE,
  filter: ComparisonFilter<OperandValueExpression<DB, TB, RE>> = {},
) {
  const predicates: Expression<SqlBool>[] = [];
  if (filter.eq !== undefined) {
    predicates.push(filter.eq === null ? eb(column, 'is', null) : eb(column, '=', filter.eq));
  }
  if (filter.ne !== undefined) {
    predicates.push(filter.ne === null ? eb(column, 'is not', null) : eb(column, '!=', filter.ne));
  }
  if (filter.lt !== undefined) {
    predicates.push(eb(column, '<', filter.lt));
  }
  if (filter.lte !== undefined) {
    predicates.push(eb(column, '<=', filter.lte));
  }
  if (filter.gt !== undefined) {
    predicates.push(eb(column, '>', filter.gt));
  }
  if (filter.gte !== undefined) {
    predicates.push(eb(column, '>=', filter.gte));
  }
  if (filter.in !== undefined) {
    predicates.push(eb(column, 'in', filter.in));
  }
  if (filter.notIn !== undefined) {
    predicates.push(eb(column, 'not in', filter.notIn));
  }
  return predicates;
}

type StringColumn =
  | 'asset_exif.city'
  | 'asset_exif.state'
  | 'asset_exif.country'
  | 'asset_exif.make'
  | 'asset_exif.model'
  | 'asset_exif.lensModel'
  | 'asset_exif.description'
  | 'asset.originalFileName'
  | 'asset.originalPath';

function stringPatternPredicates(eb: AssetExpressionBuilder, column: StringColumn, filter: StringPatternFilter = {}) {
  const ref = sql.ref(column);
  const predicates = comparisonPredicates(eb, column, filter);
  if (filter.like !== undefined) {
    predicates.push(sql<SqlBool>`f_unaccent(${ref}) ilike ('%' || f_unaccent(${filter.like}) || '%')`);
  }
  if (filter.notLike !== undefined) {
    predicates.push(sql<SqlBool>`f_unaccent(${ref}) not ilike ('%' || f_unaccent(${filter.notLike}) || '%')`);
  }
  if (filter.startsWith !== undefined) {
    predicates.push(sql<SqlBool>`f_unaccent(${ref}) ilike (f_unaccent(${filter.startsWith}) || '%')`);
  }
  if (filter.endsWith !== undefined) {
    predicates.push(sql<SqlBool>`f_unaccent(${ref}) ilike ('%' || f_unaccent(${filter.endsWith}))`);
  }
  return predicates;
}

function checksumPredicates(eb: AssetExpressionBuilder, filter: StringFilter = {}) {
  return comparisonPredicates(eb, 'asset.checksum', {
    eq: filter.eq === undefined ? undefined : fromChecksum(filter.eq),
    ne: filter.ne === undefined ? undefined : fromChecksum(filter.ne),
    in: filter.in?.map((checksum) => fromChecksum(checksum)),
    notIn: filter.notIn?.map((checksum) => fromChecksum(checksum)),
  });
}

const encodedVideoFiles = (eb: AssetExpressionBuilder) =>
  eb
    .selectFrom('asset_file')
    .whereRef('asset_file.assetId', '=', 'asset.id')
    .where('asset_file.type', '=', AssetFileType.EncodedVideo);

function existsPredicates(
  eb: AssetExpressionBuilder,
  filter: { eq: boolean } | undefined,
  subquery: () => Expression<unknown>,
): Expression<SqlBool>[] {
  if (!filter) {
    return [];
  }
  const exists = eb.exists(subquery());
  return [filter.eq ? exists : eb.not(exists)];
}

// predicates are collected as expressions rather than chained `where` calls so the same
// helpers can build each `or` branch, which must compose into eb.and/eb.or
/** `motion` is the still's reachable motion id (see searchMotionColumn); it decides `isMotion`. */
function branchPredicates(
  eb: AssetExpressionBuilder,
  branch: SearchFilterBranch,
  motion: Expression<string | null> = eb.ref('asset.livePhotoVideoId'),
) {
  const { encodedVideoPath } = branch;
  return [
    ...comparisonPredicates(eb, 'asset.id', branch.id),
    ...comparisonPredicates(eb, 'asset.libraryId', branch.libraryId),
    ...comparisonPredicates(eb, 'asset.type', branch.type),
    ...comparisonPredicates(eb, 'asset.visibility', branch.visibility),
    ...(branch.isFavorite ? [eb('asset.isFavorite', '=', branch.isFavorite.eq)] : []),
    ...(branch.isOffline ? [eb('asset.isOffline', '=', branch.isOffline.eq)] : []),
    ...(branch.isMotion ? [eb(motion, branch.isMotion.eq ? 'is not' : 'is', null)] : []),
    ...existsPredicates(eb, branch.isEncoded, () => encodedVideoFiles(eb)),
    ...existsPredicates(eb, branch.hasAlbums, () => albumAssets(eb)),
    ...existsPredicates(eb, branch.hasPeople, () => visibleFaces(eb)),
    ...existsPredicates(eb, branch.hasTags, () => tagAssets(eb)),
    ...comparisonPredicates(eb, 'asset_exif.city', branch.city),
    ...comparisonPredicates(eb, 'asset_exif.state', branch.state),
    ...comparisonPredicates(eb, 'asset_exif.country', branch.country),
    ...comparisonPredicates(eb, 'asset_exif.make', branch.make),
    ...comparisonPredicates(eb, 'asset_exif.model', branch.model),
    ...comparisonPredicates(eb, 'asset_exif.lensModel', branch.lensModel),
    ...stringPatternPredicates(eb, 'asset_exif.description', branch.description),
    ...stringPatternPredicates(eb, 'asset.originalFileName', branch.originalFileName),
    ...stringPatternPredicates(eb, 'asset.originalPath', branch.originalPath),
    ...(branch.ocr
      ? [
          eb.exists(
            eb
              .selectFrom('ocr_search')
              .whereRef('ocr_search.assetId', '=', 'asset.id')
              .where(
                sql<SqlBool>`f_unaccent(ocr_search.text) %>> f_unaccent(${tokenizeForSearch(branch.ocr.matches).join(' ')})`,
              ),
          ),
        ]
      : []),
    ...comparisonPredicates(eb, 'asset_exif.rating', branch.rating),
    ...comparisonPredicates(eb, 'asset_exif.fileSizeInByte', branch.fileSizeInBytes),
    ...comparisonPredicates(eb, 'asset.fileCreatedAt', branch.takenAt),
    ...comparisonPredicates(eb, 'asset.createdAt', branch.createdAt),
    ...comparisonPredicates(eb, 'asset.updatedAt', branch.updatedAt),
    ...comparisonPredicates(eb, 'asset.deletedAt', branch.trashedAt),
    ...albumIdsPredicates(eb, branch.albumIds),
    ...personIdsPredicates(eb, branch.personIds),
    ...tagIdsPredicates(eb, branch.tagIds),
    ...checksumPredicates(eb, branch.checksum),
    ...(encodedVideoPath
      ? [
          eb.exists(
            encodedVideoFiles(eb)
              .where('asset_file.isEdited', '=', false)
              .where((eb) => eb.and(comparisonPredicates(eb, 'asset_file.path', encodedVideoPath))),
          ),
        ]
      : []),
  ];
}

/**
 * Fork (D5): the lock-aware search universe, composed by the server outside the user's filter tree. An asset passes
 * when it is reachable through
 * - the timeline/partner arm: owned by a `userIds` owner and visible under that owner's locks, or
 * - the album arm: a member of a validated album grant (album-grant rules: the album owner's locks never affect it).
 * Upstream's per-branch ownership narrowing still applies inside the tree, using the same lock-aware arm, so no `or`
 * branch can widen past this predicate.
 */
function searchUniversePredicates(eb: AssetExpressionBuilder, kysely: Kysely<DB>, scope: AssetSearchScope) {
  const owned = eb('asset.ownerId', '=', anyUuid(scope.userIds));
  const ownerArm =
    scope.lockVisibility && scope.lockVisibility.length > 0
      ? eb.and([owned, lockVisibilityExpression(eb, kysely, scope.lockVisibility)])
      : owned;
  const albumArm =
    scope.grantedAlbumIds.length > 0
      ? eb.exists(albumAssets(eb).where('album_asset.albumId', '=', anyUuid(scope.grantedAlbumIds)))
      : undefined;
  return { ownerArm, albumArm, universe: albumArm ? eb.or([ownerArm, albumArm]) : ownerArm };
}

/**
 * Fork (R56 follow-up): the V3 search's reachable motion id - the column the response presents (withheld under the
 * owner-arm lock entries unless the album arm grants the still) - so `isMotion` filters on the same reachability and
 * a still whose motion part is hidden counts as no Live Photo. Untouched without lock entries.
 */
function searchMotionColumn(eb: AssetExpressionBuilder, kysely: Kysely<DB>, scope: AssetSearchScope) {
  const { albumArm } = searchUniversePredicates(eb, kysely, scope);
  // like the post-query album arm (getVisibleMotionIds), only a live still is granted through its album
  return lockVisibleLivePhotoVideoId(
    eb,
    kysely,
    scope.lockVisibility ?? [],
    albumArm ? eb.and([eb('asset.deletedAt', 'is', null), albumArm]) : undefined,
  );
}

// ordering is deliberately left to the caller so aggregate-only consumers (counts, stats)
// can compose the same filters without stripping an order by
export function searchAssetBuilder(kysely: Kysely<DB>, options: AssetSearchBuilderV3Options, scope: AssetSearchScope) {
  const filter = options.filter ?? {};
  const branches = filter.or ?? [];
  // search universe: own+partner assets unless album-confined, which searches the albums instead;
  // ownership lands nowhere (top level confined), per unconfined branch, or globally (the universe predicate)
  const topConfined = isAlbumConfined(filter);
  const anyBranchConfined = branches.some((branch) => isAlbumConfined(branch));
  const scopePerBranch = !topConfined && anyBranchConfined;

  return (
    kysely
      .withPlugin(joinDeduplicationPlugin)
      .selectFrom('asset')
      // postgres eliminates the left join when no exif column is referenced, so unused joins are free
      .leftJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
      .$if(!!options.withExif, (qb) => qb.select(selectExifInfo))
      .where((eb) => searchUniversePredicates(eb, kysely, scope).universe)
      .$if(!!(options.withFaces || options.withPeople), (qb) =>
        qb.select(withFacesAndPeople({ viewingUserId: scope.viewingUserId! })),
      )
      .$if(options.withStacked === false, (qb) => qb.where('asset.stackId', 'is', null))
      .where((eb) => {
        const motion = searchMotionColumn(eb, kysely, scope);
        const predicates = branchPredicates(eb, filter, motion);
        if (branches.length > 0) {
          const { ownerArm } = searchUniversePredicates(eb, kysely, scope);
          predicates.push(
            eb.or(
              branches.map((branch) =>
                eb.and([
                  ...branchPredicates(eb, branch, motion),
                  ...(scopePerBranch && !isAlbumConfined(branch) ? [ownerArm] : []),
                ]),
              ),
            ),
          );
        }
        return predicates.length > 0 ? eb.and(predicates) : eb.lit(true);
      })
  );
}

const searchOrderColumns = {
  [SearchOrderField.FileCreatedAt]: { column: 'asset.fileCreatedAt', nullable: false },
  [SearchOrderField.LocalDateTime]: { column: 'asset.localDateTime', nullable: false },
  [SearchOrderField.FileSizeInBytes]: { column: 'asset_exif.fileSizeInByte', nullable: true },
  [SearchOrderField.Rating]: { column: 'asset_exif.rating', nullable: true },
} as const;

export function withSearchOrder(qb: ReturnType<typeof searchAssetBuilder>, order?: SearchOrder) {
  const { field, direction } = order ?? DEFAULT_SEARCH_ORDER;
  const { column, nullable } = searchOrderColumns[field];
  return (
    qb
      .orderBy(column, (ob) => {
        const ordered = direction === AssetOrder.Asc ? ob.asc() : ob.desc();
        // nulls last: assets without an asset_exif row would otherwise lead descending results
        return nullable ? ordered.nullsLast() : ordered;
      })
      // id tie-break for deterministic pagination
      .orderBy('asset.id', direction)
  );
}

const scopeExample: AssetSearchScope = { userIds: [DummyValue.UUID], grantedAlbumIds: [] };

export const searchMetadataV3Examples: GenerateSqlQueries[] = [
  { name: 'baseline', params: [{ take: 100 }, {}, scopeExample] },
  {
    name: 'or-mixed-scope',
    params: [
      { take: 100 },
      {
        filter: { or: [{ albumIds: { any: [DummyValue.UUID] } }, { city: { eq: DummyValue.STRING } }] },
      },
      scopeExample,
    ],
  },
  {
    name: 'or-exif-only',
    params: [
      { take: 100 },
      {
        filter: { or: [{ city: { eq: DummyValue.STRING } }] },
      },
      scopeExample,
    ],
  },
  {
    name: 'string-eq-null',
    params: [{ take: 100 }, { filter: { city: { eq: null } } }, scopeExample],
  },
  {
    name: 'string-pattern-like',
    params: [
      { take: 100 },
      {
        filter: { description: { like: DummyValue.STRING } },
      },
      scopeExample,
    ],
  },
  {
    name: 'string-pattern-notLike',
    params: [
      { take: 100 },
      {
        filter: { description: { notLike: DummyValue.STRING } },
      },
      scopeExample,
    ],
  },
  {
    name: 'string-pattern-startsWith',
    params: [
      { take: 100 },
      {
        filter: { originalFileName: { startsWith: DummyValue.STRING } },
      },
      scopeExample,
    ],
  },
  {
    name: 'string-similarity-ocr',
    params: [{ take: 100 }, { filter: { ocr: { matches: DummyValue.STRING } } }, scopeExample],
  },
  {
    name: 'ids-any',
    params: [{ take: 100 }, { filter: { albumIds: { any: [DummyValue.UUID] } } }, scopeExample],
  },
  {
    name: 'ids-all',
    params: [
      { take: 100 },
      {
        filter: { personIds: { all: [DummyValue.UUID, DummyValue.UUID_1] } },
      },
      scopeExample,
    ],
  },
  {
    name: 'ids-all-single',
    params: [{ take: 100 }, { filter: { albumIds: { all: [DummyValue.UUID] } } }, scopeExample],
  },
  {
    name: 'ids-none',
    params: [{ take: 100 }, { filter: { tagIds: { none: [DummyValue.UUID] } } }, scopeExample],
  },
  {
    name: 'ids-tags-all',
    params: [
      { take: 100 },
      {
        filter: { tagIds: { all: [DummyValue.UUID, DummyValue.UUID_1] } },
      },
      scopeExample,
    ],
  },
  {
    name: 'has-albums-false',
    params: [{ take: 100 }, { filter: { hasAlbums: { eq: false } } }, scopeExample],
  },
  {
    name: 'is-encoded',
    params: [{ take: 100 }, { filter: { isEncoded: { eq: true } } }, scopeExample],
  },
  {
    name: 'number-range',
    params: [
      { take: 100 },
      {
        filter: { fileSizeInBytes: { gte: 100, lte: 1000 } },
      },
      scopeExample,
    ],
  },
  {
    name: 'date-eq',
    params: [{ take: 100 }, { filter: { takenAt: { eq: DummyValue.DATE } } }, scopeExample],
  },
  {
    name: 'date-range',
    params: [
      { take: 100 },
      {
        filter: { takenAt: { gte: DummyValue.DATE, lt: DummyValue.DATE } },
      },
      scopeExample,
    ],
  },
  {
    name: 'order-fileSize-noExif',
    params: [
      { take: 100 },
      {
        order: { field: SearchOrderField.FileSizeInBytes, direction: AssetOrder.Desc },
        withExif: false,
      },
      scopeExample,
    ],
  },
  {
    name: 'order-rating-withExif',
    params: [
      { take: 100 },
      {
        order: { field: SearchOrderField.Rating, direction: AssetOrder.Asc },
        withExif: true,
      },
      scopeExample,
    ],
  },
  {
    name: 'or-branches',
    params: [
      { take: 100 },
      {
        filter: {
          or: [{ isFavorite: { eq: true } }, { personIds: { any: [DummyValue.UUID] } }],
        },
      },
      scopeExample,
    ],
  },
  {
    name: 'or-with-top-level',
    params: [
      { take: 100 },
      {
        filter: {
          takenAt: { gte: DummyValue.DATE, lt: DummyValue.DATE },
          or: [{ isFavorite: { eq: true } }, { albumIds: { any: [DummyValue.UUID] } }],
        },
      },
      scopeExample,
    ],
  },
  {
    name: 'cursor-offset',
    params: [{ take: 100, skip: 100 }, { filter: { isFavorite: { eq: true } } }, scopeExample],
  },
];

export const searchRandomV3Examples: GenerateSqlQueries[] = [
  { name: 'baseline', params: [100, {}, scopeExample] },
  {
    name: 'with-filter',
    params: [100, { filter: { isFavorite: { eq: true } } }, scopeExample],
  },
];

export const searchSmartV3Examples: GenerateSqlQueries[] = [
  {
    name: 'baseline',
    params: [{ take: 100 }, { embedding: DummyValue.VECTOR }, scopeExample],
  },
  {
    name: 'with-filter',
    params: [
      { take: 100 },
      {
        embedding: DummyValue.VECTOR,
        filter: { takenAt: { gte: DummyValue.DATE, lt: DummyValue.DATE } },
      },
      scopeExample,
    ],
  },
  {
    name: 'cursor-offset',
    params: [{ take: 100, skip: 100 }, { embedding: DummyValue.VECTOR }, scopeExample],
  },
];

export const searchStatisticsV3Examples: GenerateSqlQueries[] = [
  { name: 'baseline', params: [{}, scopeExample] },
  {
    name: 'with-filter',
    params: [
      {
        filter: {
          takenAt: { gte: DummyValue.DATE, lt: DummyValue.DATE },
          fileSizeInBytes: { gte: 100 },
        },
      },
      scopeExample,
    ],
  },
  {
    name: 'with-or',
    params: [
      {
        filter: {
          or: [{ isFavorite: { eq: true } }, { hasAlbums: { eq: false } }],
        },
      },
      scopeExample,
    ],
  },
];

export type ReindexVectorIndexOptions = { indexName: string; lists?: number };

type VectorIndexQueryOptions = { table: string; vectorExtension: VectorExtension } & ReindexVectorIndexOptions;

export function vectorIndexQuery({ vectorExtension, table, indexName, lists }: VectorIndexQueryOptions): string {
  switch (vectorExtension) {
    case DatabaseExtension.VectorChord: {
      return `
        CREATE INDEX IF NOT EXISTS ${indexName} ON ${table} USING vchordrq (embedding vector_cosine_ops) WITH (options = $$
        residual_quantization = false
        [build.internal]
        lists = [${lists ?? 1}]
        spherical_centroids = true
        build_threads = 4
        sampling_factor = 1024
        $$)`;
    }
    case DatabaseExtension.Vector: {
      return `
        CREATE INDEX IF NOT EXISTS ${indexName} ON ${table}
        USING hnsw (embedding vector_cosine_ops)
        WITH (ef_construction = 300, m = 16)`;
    }
    default: {
      throw new Error(`Unsupported vector extension: '${vectorExtension}'`);
    }
  }
}

export const updateLockedColumns = <T extends Record<string, unknown> & { lockedProperties?: LockableProperty[] }>(
  exif: T,
) => {
  exif.lockedProperties = lockableProperties.filter((property) => Object.hasOwn(exif, property));
  return exif;
};
