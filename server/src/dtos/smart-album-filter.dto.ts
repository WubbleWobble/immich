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
})
  .extend({
    visibility: z.enum([AssetVisibility.Timeline, AssetVisibility.Archive]).optional(),
  })
  .strict()
  .meta({ id: 'SmartAlbumFilter' });

export class SmartAlbumFilterDto extends createZodDto(SmartAlbumFilterSchema) {}
export type SmartAlbumFilter = z.infer<typeof SmartAlbumFilterSchema>;

/**
 * Runtime guard for filters loaded from the database. Rows written before the visibility
 * restriction existed may still carry `visibility: locked` (or `hidden`); evaluating those
 * would bypass the elevated-permission requirement for locked assets. Strip any visibility
 * value the schema no longer accepts — the search builder then defaults to timeline.
 */
export const sanitizeSmartAlbumFilter = <T extends { visibility?: string }>(filter: T): T => {
  if (filter.visibility === undefined) {
    return filter;
  }
  if (filter.visibility === AssetVisibility.Timeline || filter.visibility === AssetVisibility.Archive) {
    return filter;
  }
  const { visibility: _, ...rest } = filter;
  return rest as unknown as T;
};
