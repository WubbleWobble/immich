import {
  isEmptySmartAlbumFilter,
  sanitizeSmartAlbumFilter,
  SmartAlbumFilterSchema,
  toEvaluableSmartAlbumFilter,
} from 'src/dtos/smart-album-filter.dto';
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

  it('rejects trash-coupled fields', () => {
    // Any of these flips the search builder's withDeleted flag, surfacing the owner's
    // trashed assets to sharees.
    expect(SmartAlbumFilterSchema.safeParse({ trashedBefore: '2024-01-01T00:00:00Z' }).success).toBe(false);
    expect(SmartAlbumFilterSchema.safeParse({ trashedAfter: '2024-01-01T00:00:00Z' }).success).toBe(false);
    expect(SmartAlbumFilterSchema.safeParse({ isOffline: true }).success).toBe(false);
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

  it('strips trash-coupled fields from legacy stored filters', () => {
    const filter = {
      trashedBefore: new Date('2024-06-01T00:00:00Z'),
      trashedAfter: new Date('2024-01-01T00:00:00Z'),
      isOffline: true,
      isFavorite: true,
    };
    expect(sanitizeSmartAlbumFilter(filter)).toEqual({ isFavorite: true });
  });

  it('keeps a valid visibility while stripping trash-coupled fields', () => {
    const filter = { visibility: AssetVisibility.Archive, trashedAfter: new Date('2024-01-01T00:00:00Z') };
    expect(sanitizeSmartAlbumFilter(filter)).toEqual({ visibility: AssetVisibility.Archive });
  });
});

describe('isEmptySmartAlbumFilter', () => {
  it('treats no criteria, undefined values, and empty arrays as empty', () => {
    expect(isEmptySmartAlbumFilter({})).toBe(true);
    expect(isEmptySmartAlbumFilter({ isFavorite: undefined })).toBe(true);
    expect(isEmptySmartAlbumFilter({ personIds: [] })).toBe(true);
  });

  it('treats no-op values the search builder ignores as empty', () => {
    // The builder defaults to timeline when visibility is absent.
    expect(isEmptySmartAlbumFilter({ visibility: AssetVisibility.Timeline })).toBe(true);
    // Truthiness-guarded in the builder: false / null / '' are silently ignored.
    expect(isEmptySmartAlbumFilter({ isNotInAlbum: false })).toBe(true);
    expect(isEmptySmartAlbumFilter({ libraryId: null })).toBe(true);
    expect(isEmptySmartAlbumFilter({ description: '' } as never)).toBe(true);
    expect(isEmptySmartAlbumFilter({ ocr: '' } as never)).toBe(true);
    expect(isEmptySmartAlbumFilter({ originalFileName: '' } as never)).toBe(true);
  });

  it('treats real criteria as non-empty, including meaningful nulls and falses', () => {
    expect(isEmptySmartAlbumFilter({ isFavorite: true })).toBe(false);
    // isFavorite: false = non-favorites only, applied by the builder.
    expect(isEmptySmartAlbumFilter({ isFavorite: false })).toBe(false);
    expect(isEmptySmartAlbumFilter({ personIds: ['00000000-0000-4000-8000-000000000000'] })).toBe(false);
    // tagIds: null means "untagged", rating: null means "unrated" - real criteria.
    expect(isEmptySmartAlbumFilter({ tagIds: null })).toBe(false);
    expect(isEmptySmartAlbumFilter({ rating: null })).toBe(false);
    expect(isEmptySmartAlbumFilter({ visibility: AssetVisibility.Archive })).toBe(false);
    expect(isEmptySmartAlbumFilter({ isNotInAlbum: true })).toBe(false);
    expect(isEmptySmartAlbumFilter({ description: 'beach' } as never)).toBe(false);
  });
});

describe('toEvaluableSmartAlbumFilter', () => {
  it('returns the sanitized filter when effective criteria remain', () => {
    expect(toEvaluableSmartAlbumFilter({ visibility: AssetVisibility.Locked as never, isFavorite: true })).toEqual({
      isFavorite: true,
    });
    expect(toEvaluableSmartAlbumFilter({ isFavorite: true })).toEqual({ isFavorite: true });
  });

  it('fails closed when sanitization leaves no effective criteria', () => {
    // A legacy row whose only field was stripped must match NOTHING, not everything.
    expect(toEvaluableSmartAlbumFilter({ visibility: AssetVisibility.Locked as never })).toBeNull();
    expect(toEvaluableSmartAlbumFilter({ trashedAfter: new Date() } as never)).toBeNull();
    expect(toEvaluableSmartAlbumFilter({ isOffline: true } as never)).toBeNull();
    // No-op-only filters fail closed the same way.
    expect(toEvaluableSmartAlbumFilter({ visibility: AssetVisibility.Timeline })).toBeNull();
    expect(toEvaluableSmartAlbumFilter({})).toBeNull();
  });
});
