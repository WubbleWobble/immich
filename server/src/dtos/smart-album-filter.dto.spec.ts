import { sanitizeSmartAlbumFilter, SmartAlbumFilterSchema } from 'src/dtos/smart-album-filter.dto';
import { AssetVisibility } from 'src/enum';

describe('SmartAlbumFilterSchema', () => {
  it('accepts timeline and archive visibility', () => {
    expect(SmartAlbumFilterSchema.safeParse({ visibility: AssetVisibility.Timeline }).success).toBe(true);
    expect(SmartAlbumFilterSchema.safeParse({ visibility: AssetVisibility.Archive }).success).toBe(true);
  });

  it('rejects locked visibility', () => {
    // Smart-album filters are evaluated without the elevated-permission check normal search
    // enforces for locked assets; a stored locked filter would leak locked content to sharees.
    expect(SmartAlbumFilterSchema.safeParse({ visibility: AssetVisibility.Locked }).success).toBe(false);
  });

  it('rejects hidden visibility', () => {
    expect(SmartAlbumFilterSchema.safeParse({ visibility: AssetVisibility.Hidden }).success).toBe(false);
  });
});

describe('sanitizeSmartAlbumFilter', () => {
  it('passes through filters without visibility', () => {
    const filter = { isFavorite: true, visibility: undefined };
    expect(sanitizeSmartAlbumFilter(filter)).toBe(filter);
  });

  it('passes through timeline and archive visibility', () => {
    const timeline = { visibility: AssetVisibility.Timeline };
    const archive = { visibility: AssetVisibility.Archive };
    expect(sanitizeSmartAlbumFilter(timeline)).toBe(timeline);
    expect(sanitizeSmartAlbumFilter(archive)).toBe(archive);
  });

  it('strips locked visibility from legacy stored filters', () => {
    const filter = { visibility: AssetVisibility.Locked, isFavorite: true };
    expect(sanitizeSmartAlbumFilter(filter)).toEqual({ isFavorite: true });
  });

  it('strips hidden visibility from legacy stored filters', () => {
    const filter = { visibility: AssetVisibility.Hidden };
    expect(sanitizeSmartAlbumFilter(filter)).toEqual({});
  });
});
