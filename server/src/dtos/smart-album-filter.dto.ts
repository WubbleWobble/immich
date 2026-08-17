import { createZodDto } from 'nestjs-zod';
import { MetadataSearchSchema } from 'src/dtos/search-base.dto';
import { AssetVisibility } from 'src/enum';
import z from 'zod';

// Stored filter for smart albums - subset of MetadataSearchSchema with request-shaping
// and asset-lookup fields stripped. See ../immich-specs/2026-05-22-smart-albums-design.md §5.4.
//
// Visibility is restricted to timeline/archive: smart-album filters are evaluated against the
// album owner's library without the elevated-permission check that normal search enforces for
// locked assets, so a stored `visibility=locked` filter would leak locked content to sharees.
//
// Trash-adjacent fields (trashedBefore/trashedAfter/isOffline) are excluded because any of
// them flips the search builder's withDeleted flag, which would surface the owner's trashed
// assets to sharees - regular shared albums never expose trashed assets.
export const SmartAlbumFilterSchema = MetadataSearchSchema.omit({
  // Asset-lookup fields (useless for a stored album filter)
  id: true,
  checksum: true,
  originalPath: true,
  previewPath: true,
  thumbnailPath: true,
  encodedVideoPath: true,
  // Pagination / response-shaping (set at request time, not stored)
  page: true,
  size: true,
  order: true,
  withDeleted: true,
  withExif: true,
  withStacked: true,
  withPeople: true,
  visibility: true,
  // Trash-coupled fields (see note above)
  trashedBefore: true,
  trashedAfter: true,
  isOffline: true,
})
  .extend({
    visibility: z.enum([AssetVisibility.Timeline, AssetVisibility.Archive]).optional(),
  })
  .strict()
  .meta({ id: 'SmartAlbumFilter' });

export class SmartAlbumFilterDto extends createZodDto(SmartAlbumFilterSchema) {}
export type SmartAlbumFilter = z.infer<typeof SmartAlbumFilterSchema>;

/**
 * Whether a single filter field actually constrains the search, mirroring the guards in
 * searchAssetBuilder: several fields are truthiness-guarded there, so values like `false`,
 * `null`, or `''` are silently ignored and must not count as criteria.
 */
const isEffectiveCriterion = (key: string, value: unknown): boolean => {
  if (value === undefined) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  switch (key) {
    // The search builder defaults to timeline when visibility is absent.
    case 'visibility': {
      return value !== AssetVisibility.Timeline;
    }
    // Truthiness-guarded in searchAssetBuilder: false is a no-op.
    case 'isNotInAlbum': {
      return value === true;
    }
    // Truthiness-guarded: null / empty string are no-ops.
    case 'libraryId':
    case 'description':
    case 'ocr':
    case 'originalFileName': {
      return typeof value === 'string' && value.length > 0;
    }
    // Everything else: null is meaningful (tagIds: null = untagged, city: null = no city,
    // rating: null = unrated) and false is meaningful (isFavorite: false = non-favorites).
    default: {
      return true;
    }
  }
};

/**
 * A filter with no effective criteria matches the owner's entire timeline. That is almost
 * always an accident - and once the album is shared, it exposes the whole library - so
 * creation and updates reject it, and evaluation fails closed (see
 * toEvaluableSmartAlbumFilter). "No effective criteria" includes no-op values the search
 * builder ignores, such as `visibility: timeline`, `isNotInAlbum: false`, `libraryId: null`,
 * or empty arrays.
 */
export const isEmptySmartAlbumFilter = (filter: SmartAlbumFilter): boolean =>
  !Object.entries(filter).some(([key, value]) => isEffectiveCriterion(key, value));

/**
 * Runtime guard for filters loaded from the database. Rows written before the schema
 * restrictions existed may still carry fields the schema no longer accepts:
 * - `visibility: locked`/`hidden` would bypass the elevated-permission requirement
 *   for locked assets (stripped; the search builder then defaults to timeline)
 * - `trashedBefore`/`trashedAfter`/`isOffline` flip the search builder's withDeleted
 *   flag and would surface the owner's trashed assets (stripped)
 */
export const sanitizeSmartAlbumFilter = <
  T extends { visibility?: string; trashedBefore?: unknown; trashedAfter?: unknown; isOffline?: unknown },
>(
  filter: T,
): T => {
  const validVisibility =
    filter.visibility === undefined ||
    filter.visibility === AssetVisibility.Timeline ||
    filter.visibility === AssetVisibility.Archive;
  if (
    validVisibility &&
    filter.trashedBefore === undefined &&
    filter.trashedAfter === undefined &&
    filter.isOffline === undefined
  ) {
    return filter;
  }
  const { visibility, trashedBefore: _tb, trashedAfter: _ta, isOffline: _o, ...rest } = filter;
  return (validVisibility && visibility !== undefined ? { ...rest, visibility } : rest) as unknown as T;
};

/**
 * Prepare a stored filter for evaluation: sanitize legacy fields, then refuse to evaluate
 * a filter with no effective criteria left. A legacy row whose only fields were stripped
 * (e.g. `visibility: locked`) must match NOTHING - evaluating the empty remainder would
 * expose the owner's entire timeline instead. Returns null when the album must not match
 * any asset.
 */
export const toEvaluableSmartAlbumFilter = (filter: SmartAlbumFilter): SmartAlbumFilter | null => {
  const sanitized = sanitizeSmartAlbumFilter(filter);
  return isEmptySmartAlbumFilter(sanitized) ? null : sanitized;
};
