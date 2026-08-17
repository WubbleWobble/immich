import { Kysely, sql } from 'kysely';
import { SmartAlbumFilter, toEvaluableSmartAlbumFilter } from 'src/dtos/smart-album-filter.dto';
import { AlbumKind, AlbumUserRole } from 'src/enum';
import { DB } from 'src/schema';
import { anyUuid, OwnerLockVisibility } from 'src/utils/database';

/**
 * Locked-content visibility derivation. Standalone db-taking functions so both services
 * (via LockRepository) and repositories (e.g. partner access checks) can share one source
 * of truth. See ../immich-specs/2026-05-24-locked-albums-and-folders-design.md §7.2.
 */

export interface RevealedLocks {
  albumIds: string[];
  containerIds: string[];
}

export const NO_REVEALED_LOCKS: RevealedLocks = { albumIds: [], containerIds: [] };

export async function hasAnyLocksQuery(db: Kysely<DB>, userId: string): Promise<boolean> {
  const row = await db
    .selectFrom('locked_album')
    .select(sql`1`.as('one'))
    .where('userId', '=', userId)
    .union((eb) =>
      eb
        .selectFrom('locked_container')
        .select(sql`1`.as('one'))
        .where('userId', '=', userId),
    )
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * The user's effectively-hidden album ids: directly-locked albums (minus the revealed set)
 * plus every live album inside a folder subtree whose root is locked (minus revealed
 * folders). Reveal is subtracted BEFORE closure expansion, so revealing a parent folder
 * does not reveal a separately-locked descendant, and reveal ids are intersected with the
 * user's own lock rows by construction - foreign ids cannot reveal anything.
 */
export async function getHiddenAlbumIdsQuery(
  db: Kysely<DB>,
  userId: string,
  revealed: RevealedLocks,
): Promise<string[]> {
  const rows = await db
    .selectFrom('locked_album')
    .select('albumId as id')
    .where('userId', '=', userId)
    .where((eb) => eb.not(eb('albumId', '=', anyUuid(revealed.albumIds))))
    .union((eb) =>
      eb
        .selectFrom('album')
        .select('album.id as id')
        .where('album.deletedAt', 'is', null)
        .where('album.containerId', 'in', (qb) =>
          qb
            .selectFrom('locked_container')
            .innerJoin('album_container_closure', 'album_container_closure.id_ancestor', 'locked_container.containerId')
            .select('album_container_closure.id_descendant')
            .where('locked_container.userId', '=', userId)
            .where((eb2) => eb2.not(eb2('locked_container.containerId', '=', anyUuid(revealed.containerIds)))),
        ),
    )
    .execute();
  return rows.map(({ id }) => id);
}

/**
 * The user's effectively-hidden container ids: locked folders (minus revealed) expanded
 * through the closure table to all descendants.
 */
export async function getHiddenContainerIdsQuery(
  db: Kysely<DB>,
  userId: string,
  revealedContainerIds: string[],
): Promise<string[]> {
  const rows = await db
    .selectFrom('locked_container')
    .innerJoin('album_container_closure', 'album_container_closure.id_ancestor', 'locked_container.containerId')
    .select('album_container_closure.id_descendant as id')
    .distinct()
    .where('locked_container.userId', '=', userId)
    .where((eb) => eb.not(eb('locked_container.containerId', '=', anyUuid(revealedContainerIds))))
    .execute();
  return rows.map(({ id }) => id);
}

export interface LockVisibilityRequest {
  /** The requesting user; the only owner whose reveal set may apply. */
  viewerId: string;
  /** Asset owners appearing in the query (viewer and/or partners). */
  ownerIds: string[];
  /** The viewer's client-held reveal sets (already format-validated). */
  revealed: RevealedLocks;
  /** From the session; when false the reveal sets are ignored entirely. */
  isElevated: boolean;
}

/**
 * Build the per-owner visibility entries consumed by withLockVisibility(). Each owner's
 * hidden set derives from that owner's OWN lock rows: for partner views this hides what the
 * partner locked; the viewer's reveal set only ever applies to the viewer's own locks, and
 * only in an elevated session. Owners with no locks (the common case) or nothing left
 * hidden after reveal produce no entry and pay nothing.
 *
 * Only an owner's own smart albums participate: a smart album shared IN from another user
 * matches that other user's assets, which never appear among this owner's rows.
 */
export async function getOwnerLockVisibility(
  db: Kysely<DB>,
  { viewerId, ownerIds, revealed, isElevated }: LockVisibilityRequest,
): Promise<OwnerLockVisibility[]> {
  const entries: OwnerLockVisibility[] = [];
  for (const ownerId of new Set(ownerIds)) {
    const reveal = isElevated && ownerId === viewerId ? revealed : NO_REVEALED_LOCKS;
    if (!(await hasAnyLocksQuery(db, ownerId))) {
      continue;
    }
    const hiddenAlbumIds = await getHiddenAlbumIdsQuery(db, ownerId, reveal);
    if (hiddenAlbumIds.length === 0) {
      continue;
    }
    const smartAlbums = await db
      .selectFrom('album')
      .select(['album.id', 'album.filter'])
      .where('album.kind', '=', sql.lit(AlbumKind.Smart))
      .where('album.deletedAt', 'is', null)
      .where('album.filter', 'is not', null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('album_user')
            .select('album_user.userId')
            .whereRef('album_user.albumId', '=', 'album.id')
            .where('album_user.role', '=', sql.lit(AlbumUserRole.Owner))
            .where('album_user.userId', '=', ownerId),
        ),
      )
      .execute();

    const hiddenSet = new Set(hiddenAlbumIds);
    const hiddenSmartFilters: OwnerLockVisibility['hiddenSmartFilters'] = [];
    const visibleSmartFilters: OwnerLockVisibility['visibleSmartFilters'] = [];
    for (const smartAlbum of smartAlbums) {
      const evaluable = smartAlbum.filter ? toEvaluableSmartAlbumFilter(smartAlbum.filter as SmartAlbumFilter) : null;
      if (!evaluable) {
        // Fails closed for asset matching: matches nothing whether hidden or visible.
        continue;
      }
      const options = { ...evaluable, userIds: [ownerId] };
      (hiddenSet.has(smartAlbum.id) ? hiddenSmartFilters : visibleSmartFilters).push(options);
    }

    entries.push({ ownerId, hiddenAlbumIds, hiddenSmartFilters, visibleSmartFilters });
  }
  return entries;
}

/**
 * Whether a single album is effectively hidden for `viewerId` (directly locked, or inside
 * a locked folder subtree). No reveal parameter: callers gate on elevation, and reveal only
 * exists within elevated sessions.
 */
export async function isAlbumHiddenForViewerQuery(db: Kysely<DB>, viewerId: string, albumId: string): Promise<boolean> {
  const row = await db
    .selectFrom('album')
    .select(sql`1`.as('one'))
    .where('album.id', '=', albumId)
    .where((eb) =>
      eb.or([
        eb.exists(
          eb
            .selectFrom('locked_album')
            .select('locked_album.albumId')
            .where('locked_album.userId', '=', viewerId)
            .whereRef('locked_album.albumId', '=', 'album.id'),
        ),
        eb(
          'album.containerId',
          'in',
          eb
            .selectFrom('locked_container')
            .innerJoin('album_container_closure', 'album_container_closure.id_ancestor', 'locked_container.containerId')
            .select('album_container_closure.id_descendant')
            .where('locked_container.userId', '=', viewerId),
        ),
      ]),
    )
    .executeTakeFirst();
  return row !== undefined;
}

/** Whether a single folder is effectively hidden for `viewerId` (locked, or inside a locked subtree). */
export async function isContainerHiddenForViewerQuery(
  db: Kysely<DB>,
  viewerId: string,
  containerId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('locked_container')
    .innerJoin('album_container_closure', 'album_container_closure.id_ancestor', 'locked_container.containerId')
    .select(sql`1`.as('one'))
    .where('locked_container.userId', '=', viewerId)
    .where('album_container_closure.id_descendant', '=', containerId)
    .executeTakeFirst();
  return row !== undefined;
}
