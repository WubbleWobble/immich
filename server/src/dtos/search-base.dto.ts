// Fork: upstream v3.3.6's v1 (flat) search schemas, moved here verbatim from src/dtos/search.dto.ts (which imports
// them back) so that src/dtos/smart-album-filter.dto.ts can derive SmartAlbumFilterSchema from the same v1 fields
// without a circular import (album.dto -> smart-album-filter.dto -> search.dto -> album.dto). Keep these definitions
// in sync with upstream's search.dto.ts when merging; the structured (v3) `filter`/`orderBy`/`cursor` fields and the
// shape-exclusivity refinement stay in search.dto.ts.
import z from 'zod';
import { HistoryBuilder } from 'src/decorators.js';
import { AssetOrderSchema, AssetTypeSchema, AssetVisibilitySchema } from 'src/enum.js';
import { isoDatetimeToDate } from 'src/validation.js';

// fields deprecated in favor of the structured filter tree
export const DEPRECATED_FLAT_FIELD: ReturnType<HistoryBuilder['getExtensions']> & { deprecated: true } = {
  ...new HistoryBuilder().added('v1').stable('v2').deprecated('v3.2.0').getExtensions(),
  deprecated: true,
};

export const BaseSearchSchema = z.object({
  libraryId: z.uuidv4().nullish().describe('Library ID to filter by').meta(DEPRECATED_FLAT_FIELD),
  type: AssetTypeSchema.optional().meta(DEPRECATED_FLAT_FIELD),
  isEncoded: z.boolean().optional().describe('Filter by encoded status').meta(DEPRECATED_FLAT_FIELD),
  isFavorite: z.boolean().optional().describe('Filter by favorite status').meta(DEPRECATED_FLAT_FIELD),
  isMotion: z.boolean().optional().describe('Filter by motion photo status').meta(DEPRECATED_FLAT_FIELD),
  isOffline: z.boolean().optional().describe('Filter by offline status').meta(DEPRECATED_FLAT_FIELD),
  visibility: AssetVisibilitySchema.optional().meta(DEPRECATED_FLAT_FIELD),
  createdBefore: isoDatetimeToDate.optional().describe('Filter by creation date (before)').meta(DEPRECATED_FLAT_FIELD),
  createdAfter: isoDatetimeToDate.optional().describe('Filter by creation date (after)').meta(DEPRECATED_FLAT_FIELD),
  updatedBefore: isoDatetimeToDate.optional().describe('Filter by update date (before)').meta(DEPRECATED_FLAT_FIELD),
  updatedAfter: isoDatetimeToDate.optional().describe('Filter by update date (after)').meta(DEPRECATED_FLAT_FIELD),
  trashedBefore: isoDatetimeToDate.optional().describe('Filter by trash date (before)').meta(DEPRECATED_FLAT_FIELD),
  trashedAfter: isoDatetimeToDate.optional().describe('Filter by trash date (after)').meta(DEPRECATED_FLAT_FIELD),
  takenBefore: isoDatetimeToDate.optional().describe('Filter by taken date (before)').meta(DEPRECATED_FLAT_FIELD),
  takenAfter: isoDatetimeToDate.optional().describe('Filter by taken date (after)').meta(DEPRECATED_FLAT_FIELD),
  city: z.string().nullable().optional().describe('Filter by city name').meta(DEPRECATED_FLAT_FIELD),
  state: z.string().nullable().optional().describe('Filter by state/province name').meta(DEPRECATED_FLAT_FIELD),
  country: z.string().nullable().optional().describe('Filter by country name').meta(DEPRECATED_FLAT_FIELD),
  make: z.string().nullable().optional().describe('Filter by camera make').meta(DEPRECATED_FLAT_FIELD),
  model: z.string().nullable().optional().describe('Filter by camera model').meta(DEPRECATED_FLAT_FIELD),
  lensModel: z.string().nullable().optional().describe('Filter by lens model').meta(DEPRECATED_FLAT_FIELD),
  isNotInAlbum: z.boolean().optional().describe('Filter assets not in any album').meta(DEPRECATED_FLAT_FIELD),
  personIds: z.array(z.uuidv4()).optional().describe('Filter by person IDs').meta(DEPRECATED_FLAT_FIELD),
  tagIds: z.array(z.uuidv4()).nullish().describe('Filter by tag IDs').meta(DEPRECATED_FLAT_FIELD),
  albumIds: z.array(z.uuidv4()).optional().describe('Filter by album IDs').meta(DEPRECATED_FLAT_FIELD),
  rating: z
    .int()
    .min(1)
    .max(5)
    .nullish()
    .describe('Filter by rating [1-5], or null for unrated')
    .meta({
      ...new HistoryBuilder()
        .added('v1')
        .stable('v2')
        .updated('v2.6.0', 'Using -1 as a rating is deprecated and will be removed in the next major version.')
        .updated('v3', 'Using -1 as a rating is no longer valid.')
        .deprecated('v3.2.0')
        .getExtensions(),
      deprecated: true,
    }),
  ocr: z.string().optional().describe('Filter by OCR text content').meta(DEPRECATED_FLAT_FIELD),
});

export const BaseSearchWithResultsSchema = BaseSearchSchema.extend({
  withDeleted: z.boolean().optional().describe('Include deleted assets').meta(DEPRECATED_FLAT_FIELD),
  withExif: z.boolean().optional().describe('Include EXIF data in response'),
  size: z.int().min(1).max(1000).default(250).describe('Number of results to return'),
});

/** The flat fields of the v1 random search (upstream's RandomSearchBaseSchema minus the structured `filter`). */
export const RandomSearchFlatSchema = BaseSearchWithResultsSchema.extend({
  withStacked: z.boolean().optional().describe('Include stacked assets'),
  withPeople: z.boolean().optional().describe('Include people data in response'),
});

/** The flat metadata-search fields of the v1 metadata search (upstream's MetadataSearchSchema extension). */
export const metadataSearchFlatShape = {
  id: z.uuidv4().optional().describe('Filter by asset ID').meta(DEPRECATED_FLAT_FIELD),
  description: z.string().trim().optional().describe('Filter by description text').meta(DEPRECATED_FLAT_FIELD),
  checksum: z.string().optional().describe('Filter by file checksum').meta(DEPRECATED_FLAT_FIELD),
  originalFileName: z.string().trim().optional().describe('Filter by original file name').meta(DEPRECATED_FLAT_FIELD),
  originalPath: z.string().optional().describe('Filter by original file path').meta(DEPRECATED_FLAT_FIELD),
  previewPath: z.string().optional().describe('Filter by preview file path').meta(DEPRECATED_FLAT_FIELD),
  thumbnailPath: z.string().optional().describe('Filter by thumbnail file path').meta(DEPRECATED_FLAT_FIELD),
  encodedVideoPath: z.string().optional().describe('Filter by encoded video file path').meta(DEPRECATED_FLAT_FIELD),
  order: AssetOrderSchema.optional().describe('Sort order').meta(DEPRECATED_FLAT_FIELD),
  page: z.int().min(1).optional().describe('Page number').meta(DEPRECATED_FLAT_FIELD),
};

/** The whole v1 (flat) metadata search: what a stored smart-album filter is a subset of (D11). */
export const MetadataSearchFlatSchema = RandomSearchFlatSchema.extend(metadataSearchFlatShape);
