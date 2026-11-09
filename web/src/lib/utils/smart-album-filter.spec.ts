import { AssetTypeEnum, Visibility, type SmartAlbumFilter } from '@immich/sdk';
import { DateTime } from 'luxon';
import { MediaType } from '$lib/constants';
import {
  hiddenSmartAlbumFilterKeys,
  mergeSmartAlbumFilter,
  searchTermsToSmartAlbumFilter,
  searchFilterToSmartAlbumFilter,
  smartAlbumFilterToSearchFilter,
} from '$lib/utils/smart-album-filter';

const PERSON_A = '0b6b5a4e-6f43-4d0c-9a51-0f6a3d1c7e01';
const PERSON_B = '0b6b5a4e-6f43-4d0c-9a51-0f6a3d1c7e02';
const TAG_A = '6f1f1f8e-3e0e-4b8b-8c39-7a3c2d9c0a01';
const LIBRARY = '9d1c3d1e-1d7b-4f0a-8f0e-2c7c0b8e5a01';
const ALBUM = 'c3e8a4a2-5b1c-4c0e-9a1d-7f2b6e3d4c01';

const MIDNIGHT = '2024-03-05T00:00:00.000Z';
const NON_MIDNIGHT = '2024-03-05T13:45:12.345Z';
const END_OF_DAY = '2024-03-05T23:59:59.999Z';
const OFFSET_LOCAL_MIDNIGHT = '2024-03-05T00:00:00.000+01:00';

/** Every value the server accepts for each SmartAlbumFilter key ("absent" is the empty filter case). */
const allowedValues: { [K in keyof Required<SmartAlbumFilter>]: SmartAlbumFilter[K][] } = {
  albumIds: [[ALBUM], []],
  city: ['London', null],
  country: ['United Kingdom', null],
  createdAfter: [MIDNIGHT, NON_MIDNIGHT],
  createdBefore: [END_OF_DAY, NON_MIDNIGHT],
  description: ['beach'],
  isEncoded: [true, false],
  isFavorite: [true, false],
  isMotion: [true, false],
  isNotInAlbum: [true, false],
  lensModel: ['RF 24-70mm', null],
  libraryId: [LIBRARY, null],
  make: ['Canon', null],
  model: ['EOS R5', null],
  ocr: ['receipt'],
  originalFileName: ['IMG_0001'],
  personIds: [[PERSON_A], [PERSON_A, PERSON_B], []],
  rating: [1, 5, null],
  state: ['England', null],
  tagIds: [[TAG_A], [], null],
  takenAfter: [MIDNIGHT, NON_MIDNIGHT, END_OF_DAY, OFFSET_LOCAL_MIDNIGHT],
  takenBefore: [END_OF_DAY, NON_MIDNIGHT, MIDNIGHT, OFFSET_LOCAL_MIDNIGHT],
  type: Object.values(AssetTypeEnum),
  updatedAfter: [NON_MIDNIGHT],
  updatedBefore: [NON_MIDNIGHT],
  visibility: [Visibility.Timeline, Visibility.Archive],
};

const openAndSave = (stored: SmartAlbumFilter | null | undefined) =>
  mergeSmartAlbumFilter(stored, smartAlbumFilterToSearchFilter(stored));

const singleFieldCases = Object.entries(allowedValues).flatMap(([key, values]) =>
  (values as unknown[]).map((value) => ({ name: `${key}=${JSON.stringify(value)}`, filter: { [key]: value } })),
);

const combinedCases = [
  { name: 'absent (empty filter)', filter: {} },
  { name: 'audit repro: null city next to a favorite', filter: { city: null, isFavorite: true } },
  {
    name: 'every nullable location/camera field null',
    filter: { country: null, state: null, city: null, make: null, model: null, lensModel: null, personIds: [PERSON_A] },
  },
  {
    name: 'exact non-midnight bounds on both ends',
    filter: { takenAfter: '2023-07-01T08:30:00.000Z', takenBefore: '2023-07-02T17:15:00.000Z', isFavorite: true },
  },
  {
    name: 'every field set at once',
    filter: Object.fromEntries(Object.entries(allowedValues).map(([key, values]) => [key, values[0]])),
  },
  {
    name: 'every field set to its last allowed value',
    filter: Object.fromEntries(Object.entries(allowedValues).map(([key, values]) => [key, values.at(-1)])),
  },
];

describe('smart album filter round trip', () => {
  it('open-and-save without edits is the identity for every allowed stored filter value', () => {
    const cases = [...combinedCases, ...singleFieldCases];
    const failures = cases
      .map(({ name, filter }) => ({ name, filter, saved: openAndSave(filter as SmartAlbumFilter) }))
      .filter(({ filter, saved }) => JSON.stringify(sortKeys(saved)) !== JSON.stringify(sortKeys(filter)));

    expect(failures).toEqual([]);
  });

  it('treats a null stored filter like an empty one', () => {
    expect(openAndSave(null)).toEqual({});
    expect(openAndSave(undefined)).toEqual({});
  });

  describe('edits', () => {
    it('replaces a carried null location once the user picks a value', () => {
      const stored: SmartAlbumFilter = { city: null, isFavorite: true };
      const form = smartAlbumFilterToSearchFilter(stored);
      form.location.city = 'Paris';
      expect(mergeSmartAlbumFilter(stored, form)).toEqual({ city: 'Paris', isFavorite: true });
    });

    it('drops a field the user cleared', () => {
      const stored: SmartAlbumFilter = { make: 'Canon', isFavorite: true };
      const form = smartAlbumFilterToSearchFilter(stored);
      form.camera.make = undefined;
      expect(mergeSmartAlbumFilter(stored, form)).toEqual({ isFavorite: true });
    });

    it('keeps the exact other bound when only one date is edited', () => {
      const stored: SmartAlbumFilter = { takenAfter: NON_MIDNIGHT, takenBefore: '2024-04-01T06:00:00.000Z' };
      const form = smartAlbumFilterToSearchFilter(stored);
      form.date.takenAfter = DateTime.fromISO('2024-02-01T00:00:00.000Z', { zone: 'UTC' });
      expect(mergeSmartAlbumFilter(stored, form)).toEqual({
        takenAfter: '2024-02-01T00:00:00.000Z',
        takenBefore: '2024-04-01T06:00:00.000Z',
      });
    });

    it('writes whole-day bounds for a newly chosen date', () => {
      const form = smartAlbumFilterToSearchFilter({});
      form.date.takenAfter = DateTime.fromISO('2024-02-01T00:00:00.000Z', { zone: 'UTC' });
      form.date.takenBefore = DateTime.fromISO('2024-02-03T00:00:00.000Z', { zone: 'UTC' });
      expect(mergeSmartAlbumFilter({}, form)).toEqual({
        takenAfter: '2024-02-01T00:00:00.000Z',
        takenBefore: '2024-02-03T23:59:59.999Z',
      });
    });

    it('removes only the person the user deselected', () => {
      const stored: SmartAlbumFilter = { personIds: [PERSON_A, PERSON_B], city: null };
      const form = smartAlbumFilterToSearchFilter(stored);
      form.personIds.delete(PERSON_A);
      expect(mergeSmartAlbumFilter(stored, form)).toEqual({ personIds: [PERSON_B], city: null });
    });

    it('overrides a carried isFavorite: false when the user checks favorites', () => {
      const stored: SmartAlbumFilter = { isFavorite: false, rating: null };
      const form = smartAlbumFilterToSearchFilter(stored);
      form.display.isFavorite = true;
      form.rating = 4;
      expect(mergeSmartAlbumFilter(stored, form)).toEqual({ isFavorite: true, rating: 4 });
    });

    it('turns an "unknown" (empty string) location choice into null', () => {
      const form = smartAlbumFilterToSearchFilter({});
      form.location.country = '';
      form.mediaType = MediaType.Video;
      expect(searchFilterToSmartAlbumFilter(form)).toEqual({ country: null, type: AssetTypeEnum.Video });
    });
  });
});

describe('hiddenSmartAlbumFilterKeys', () => {
  it('lists criteria the form does not show, but not ones it shows or no-op values', () => {
    expect(
      hiddenSmartAlbumFilterKeys({
        description: 'beach',
        isFavorite: false,
        rating: null,
        type: AssetTypeEnum.Audio,
        city: null,
        takenAfter: NON_MIDNIGHT,
        personIds: [],
        visibility: Visibility.Timeline,
      }),
    ).toEqual(['description', 'isFavorite', 'rating', 'type']);
  });
});

describe('searchTermsToSmartAlbumFilter', () => {
  it('serializes a flat search into the legacy smart-album filter shape', () => {
    expect(
      searchTermsToSmartAlbumFilter({
        city: null,
        country: 'United Kingdom',
        personIds: [PERSON_A],
        tagIds: null,
        rating: null,
        takenAfter: '2024-03-05T00:00:00.000Z',
        visibility: Visibility.Archive,
        isFavorite: true,
        ocr: 'receipt',
      }),
    ).toEqual({
      filter: {
        city: null,
        country: 'United Kingdom',
        personIds: [PERSON_A],
        tagIds: null,
        rating: null,
        takenAfter: '2024-03-05T00:00:00.000Z',
        visibility: Visibility.Archive,
        isFavorite: true,
        ocr: 'receipt',
      },
      unsupported: [],
    });
  });

  it('ignores paging/presentation keys and empty values', () => {
    expect(
      searchTermsToSmartAlbumFilter({
        page: 2,
        size: 100,
        withExif: true,
        withStacked: true,
        order: 'desc',
        description: '',
        personIds: [],
        make: undefined,
        filter: {},
        isFavorite: true,
      }),
    ).toEqual({ filter: { isFavorite: true }, unsupported: [] });
  });

  it('reports criteria the legacy shape cannot express instead of dropping them', () => {
    expect(
      searchTermsToSmartAlbumFilter({
        query: 'beach',
        originalPath: '/photos/2024',
        visibility: 'locked',
        filter: { or: [{ city: { eq: 'London' } }, { city: { eq: 'Paris' } }] },
        isFavorite: true,
      }),
    ).toEqual({
      filter: { isFavorite: true },
      unsupported: ['query', 'originalPath', 'visibility', 'filter'],
    });
  });
});

function sortKeys(value: object) {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}
