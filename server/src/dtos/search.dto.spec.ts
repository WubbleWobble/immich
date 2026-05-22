import { SmartAlbumFilterDto } from 'src/dtos/search.dto';
import { describe, expect, it } from 'vitest';

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
