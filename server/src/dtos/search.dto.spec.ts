import { describe, expect, it } from 'vitest';
import { MetadataSearchDto, SearchFilterSchema } from 'src/dtos/search.dto.js';
import { SmartAlbumFilterDto } from 'src/dtos/smart-album-filter.dto.js';
import { AssetVisibility } from 'src/enum.js';

describe('SmartAlbumFilterDto', () => {
  it('accepts a minimal filter', () => {
    const parsed = SmartAlbumFilterDto.create({});
    expect(parsed).toEqual({});
  });

  it('accepts a filter with people and tags', () => {
    const personId = '11111111-1111-4111-8111-111111111111';
    const tagId = '22222222-2222-4222-8222-222222222222';
    const parsed = SmartAlbumFilterDto.create({ personIds: [personId], tagIds: [tagId] });
    expect(parsed.personIds).toEqual([personId]);
    expect(parsed.tagIds).toEqual([tagId]);
  });

  it('rejects request-shaping fields like page', () => {
    expect(() => SmartAlbumFilterDto.create({ page: 1 } as any)).toThrow();
  });

  it('rejects asset-lookup fields like checksum', () => {
    expect(() => SmartAlbumFilterDto.create({ checksum: 'abc' } as any)).toThrow();
  });
});

describe('SearchFilterSchema', () => {
  it('rejects the retired locked visibility with any operator, at the root and in or-branches', () => {
    for (const visibility of [
      { eq: AssetVisibility.Locked },
      { ne: AssetVisibility.Locked },
      { in: [AssetVisibility.Timeline, AssetVisibility.Locked] },
      { notIn: [AssetVisibility.Locked] },
    ]) {
      expect(SearchFilterSchema.safeParse({ visibility }).success).toBe(false);
      expect(SearchFilterSchema.safeParse({ or: [{ isFavorite: { eq: true } }, { visibility }] }).success).toBe(false);
      expect(SearchFilterSchema.safeParse({ city: { eq: 'Oslo' }, or: [{ visibility }] }).success).toBe(false);
    }
  });

  it('rejects the retired locked visibility inside a new-shape search request', () => {
    expect(() => MetadataSearchDto.create({ filter: { visibility: { eq: AssetVisibility.Locked } } })).toThrow();
  });

  it('accepts the remaining visibility values', () => {
    for (const visibility of [
      { eq: AssetVisibility.Timeline },
      { ne: AssetVisibility.Archive },
      { in: [AssetVisibility.Timeline, AssetVisibility.Archive] },
      { notIn: [AssetVisibility.Hidden] },
    ]) {
      expect(SearchFilterSchema.safeParse({ visibility }).success).toBe(true);
      expect(SearchFilterSchema.safeParse({ or: [{ visibility }] }).success).toBe(true);
    }
  });
});
