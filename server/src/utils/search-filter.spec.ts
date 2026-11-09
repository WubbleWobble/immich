import { describe, expect, it } from 'vitest';
import { SearchFilter, isAlbumConfined, isFullyAlbumConfined } from 'src/dtos/search.dto.js';
import { collectFilterIds } from 'src/utils/search-filter.js';

describe(collectFilterIds.name, () => {
  it('should union and dedupe ids across operators and branches', () => {
    const [albumA, albumB, albumC] = [
      '00000000-0000-4000-8000-00000000000a',
      '00000000-0000-4000-8000-00000000000b',
      '00000000-0000-4000-8000-00000000000c',
    ];
    const filter: SearchFilter = {
      albumIds: { any: [albumA], none: [albumB] },
      or: [{ albumIds: { all: [albumC, albumA] } }, { city: { eq: 'Oslo' } }],
    };
    expect(collectFilterIds(filter, 'albumIds').toSorted()).toEqual([albumA, albumB, albumC]);
    expect(collectFilterIds({}, 'albumIds')).toEqual([]);
  });

  it('should only collect ids of the requested field', () => {
    const albumId = '00000000-0000-4000-8000-00000000000a';
    const personId = '00000000-0000-4000-8000-00000000000b';
    const filter = { albumIds: { any: [albumId] }, personIds: { any: [personId] } };
    expect(collectFilterIds(filter, 'personIds')).toEqual([personId]);
  });
});

describe(isAlbumConfined.name, () => {
  it('should require a positive albumIds constraint', () => {
    const albumId = '00000000-0000-4000-8000-00000000000a';
    expect(isAlbumConfined({ albumIds: { any: [albumId] } })).toBe(true);
    expect(isAlbumConfined({ albumIds: { all: [albumId] } })).toBe(true);
    expect(isAlbumConfined({ albumIds: { none: [albumId] } })).toBe(false);
    expect(isAlbumConfined({ city: { eq: 'Oslo' } })).toBe(false);
    expect(isAlbumConfined({})).toBe(false);
  });
});

describe(isFullyAlbumConfined.name, () => {
  const albumId = '00000000-0000-4000-8000-00000000000a';

  it('should be confined by the top level or by every branch', () => {
    expect(isFullyAlbumConfined({ albumIds: { any: [albumId] } })).toBe(true);
    expect(isFullyAlbumConfined({ albumIds: { any: [albumId] }, or: [{ city: { eq: 'Oslo' } }] })).toBe(true);
    expect(isFullyAlbumConfined({ or: [{ albumIds: { any: [albumId] } }, { albumIds: { all: [albumId] } }] })).toBe(
      true,
    );
  });

  it('should not be confined when any result can escape the albums', () => {
    expect(isFullyAlbumConfined({})).toBe(false);
    expect(isFullyAlbumConfined({ albumIds: { none: [albumId] } })).toBe(false);
    expect(isFullyAlbumConfined({ or: [{ albumIds: { any: [albumId] } }, { city: { eq: 'Oslo' } }] })).toBe(false);
    expect(isFullyAlbumConfined({ or: [] })).toBe(false);
  });
});
