import { createZodDto } from 'nestjs-zod';
import { MetadataSearchSchema } from 'src/dtos/search-base.dto';
import z from 'zod';

// Stored filter for smart albums - subset of MetadataSearchSchema with request-shaping
// and asset-lookup fields stripped. See ../immich-specs/2026-05-22-smart-albums-design.md §5.4.
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
})
  .strict()
  .meta({ id: 'SmartAlbumFilter' });

export class SmartAlbumFilterDto extends createZodDto(SmartAlbumFilterSchema) {}
export type SmartAlbumFilter = z.infer<typeof SmartAlbumFilterSchema>;
