import { HistoryBuilder } from 'src/decorators';
import { AssetOrder, AssetOrderSchema, AssetTypeSchema, AssetVisibilitySchema } from 'src/enum';
import { isoDatetimeToDate } from 'src/validation';
import z from 'zod';

export const BaseSearchSchema = z.object({
  libraryId: z.uuidv4().nullish().describe('Library ID to filter by'),
  type: AssetTypeSchema.optional(),
  isEncoded: z.boolean().optional().describe('Filter by encoded status'),
  isFavorite: z.boolean().optional().describe('Filter by favorite status'),
  isMotion: z.boolean().optional().describe('Filter by motion photo status'),
  isOffline: z.boolean().optional().describe('Filter by offline status'),
  visibility: AssetVisibilitySchema.optional(),
  createdBefore: isoDatetimeToDate.optional().describe('Filter by creation date (before)'),
  createdAfter: isoDatetimeToDate.optional().describe('Filter by creation date (after)'),
  updatedBefore: isoDatetimeToDate.optional().describe('Filter by update date (before)'),
  updatedAfter: isoDatetimeToDate.optional().describe('Filter by update date (after)'),
  trashedBefore: isoDatetimeToDate.optional().describe('Filter by trash date (before)'),
  trashedAfter: isoDatetimeToDate.optional().describe('Filter by trash date (after)'),
  takenBefore: isoDatetimeToDate.optional().describe('Filter by taken date (before)'),
  takenAfter: isoDatetimeToDate.optional().describe('Filter by taken date (after)'),
  city: z.string().nullable().optional().describe('Filter by city name'),
  state: z.string().nullable().optional().describe('Filter by state/province name'),
  country: z.string().nullable().optional().describe('Filter by country name'),
  make: z.string().nullable().optional().describe('Filter by camera make'),
  model: z.string().nullable().optional().describe('Filter by camera model'),
  lensModel: z.string().nullable().optional().describe('Filter by lens model'),
  isNotInAlbum: z.boolean().optional().describe('Filter assets not in any album'),
  personIds: z.array(z.uuidv4()).optional().describe('Filter by person IDs'),
  tagIds: z.array(z.uuidv4()).nullish().describe('Filter by tag IDs'),
  albumIds: z.array(z.uuidv4()).optional().describe('Filter by album IDs'),
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
        .getExtensions(),
    }),
  ocr: z.string().optional().describe('Filter by OCR text content'),
});

export const BaseSearchWithResultsSchema = BaseSearchSchema.extend({
  withDeleted: z.boolean().optional().describe('Include deleted assets'),
  withExif: z.boolean().optional().describe('Include EXIF data in response'),
  size: z.int().min(1).max(1000).optional().describe('Number of results to return'),
});

export const RandomSearchSchema = BaseSearchWithResultsSchema.extend({
  withStacked: z.boolean().optional().describe('Include stacked assets'),
  withPeople: z.boolean().optional().describe('Include people data in response'),
}).meta({ id: 'RandomSearchDto' });

export const MetadataSearchSchema = RandomSearchSchema.extend({
  id: z.uuidv4().optional().describe('Filter by asset ID'),
  description: z.string().trim().optional().describe('Filter by description text'),
  checksum: z.string().optional().describe('Filter by file checksum'),
  originalFileName: z.string().trim().optional().describe('Filter by original file name'),
  originalPath: z.string().optional().describe('Filter by original file path'),
  previewPath: z.string().optional().describe('Filter by preview file path'),
  thumbnailPath: z.string().optional().describe('Filter by thumbnail file path'),
  encodedVideoPath: z.string().optional().describe('Filter by encoded video file path'),
  order: AssetOrderSchema.default(AssetOrder.Desc).optional().describe('Sort order'),
  page: z.int().min(1).optional().describe('Page number'),
}).meta({ id: 'MetadataSearchDto' });
