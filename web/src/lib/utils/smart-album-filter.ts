import { AssetTypeEnum, Visibility, type SmartAlbumFilter } from '@immich/sdk';
import { isEqual } from 'lodash-es';
import type { DateTime } from 'luxon';
import { SvelteSet } from 'svelte/reactivity';
import { MediaType } from '$lib/constants';
import type { SearchFilter } from '$lib/types';
import { parseUtcDate } from '$lib/utils/date-time';

/**
 * Convert a persisted SmartAlbumFilter into the SearchFilter shape used by
 * the existing search-bar section components. The smart-album filter is a
 * subset of MetadataSearchDto so this is mostly a mechanical mapping.
 */
export function smartAlbumFilterToSearchFilter(filter: SmartAlbumFilter | null | undefined): SearchFilter {
  const f = filter ?? {};
  const toStartOfDay = (s?: string) => (s ? parseUtcDate(s).startOf('day') : undefined);
  // Like the search page, an "unknown" (null) location/camera value is the empty-string option.
  const withNullAsEmptyString = (value: string | null | undefined) => (value === null ? '' : value);
  return {
    // Smart albums don't support semantic-query/OCR/path-based search,
    // they're metadata-only. Leave query inputs empty.
    query: '',
    ocr: undefined,
    queryType: 'smart',
    personIds: new SvelteSet(f.personIds ?? []),
    tagIds: f.tagIds === null ? null : new SvelteSet(f.tagIds ?? []),
    location: {
      country: withNullAsEmptyString(f.country),
      state: withNullAsEmptyString(f.state),
      city: withNullAsEmptyString(f.city),
    },
    camera: {
      make: withNullAsEmptyString(f.make),
      model: withNullAsEmptyString(f.model),
      lensModel: withNullAsEmptyString(f.lensModel),
    },
    date: {
      takenAfter: toStartOfDay(f.takenAfter),
      takenBefore: toStartOfDay(f.takenBefore),
    },
    display: {
      isArchive: f.visibility === Visibility.Archive,
      isFavorite: f.isFavorite ?? false,
      isNotInAlbum: f.isNotInAlbum ?? false,
    },
    mediaType:
      f.type === AssetTypeEnum.Image
        ? MediaType.Image
        : f.type === AssetTypeEnum.Video
          ? MediaType.Video
          : MediaType.All,
    rating: f.rating,
  };
}

/**
 * The SmartAlbumFilter fields the visual form can represent and (re)produces on submit.
 * Everything else in a filter must be carried through untouched (see
 * mergeSmartAlbumFilter) or it would be silently dropped on save.
 */
export const FORM_MANAGED_FILTER_KEYS = [
  'country',
  'state',
  'city',
  'make',
  'model',
  'lensModel',
  'takenAfter',
  'takenBefore',
  'visibility',
  'isFavorite',
  'isNotInAlbum',
  'personIds',
  'tagIds',
  'type',
  'rating',
] as const satisfies readonly (keyof SmartAlbumFilter)[];

/**
 * An "empty" filter matches the owner's entire timeline - almost certainly an accident,
 * and dangerous once shared. Mirrors the server-side check: no-op values the search
 * builder ignores (timeline visibility, isNotInAlbum: false, null library, empty strings
 * and arrays) do not count as criteria.
 */
export function isEmptySmartAlbumFilter(filter: Partial<SmartAlbumFilter>): boolean {
  return !Object.entries(filter).some(([key, value]) => {
    if (value === undefined) {
      return false;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    switch (key) {
      case 'visibility': {
        return value !== Visibility.Timeline;
      }
      case 'isNotInAlbum': {
        return value === true;
      }
      case 'libraryId':
      case 'description':
      case 'ocr':
      case 'originalFileName': {
        return typeof value === 'string' && value.length > 0;
      }
      default: {
        return true;
      }
    }
  });
}

/**
 * Convert SearchFilter back into a SmartAlbumFilter for persistence.
 * Empty/falsy fields are omitted so the saved filter stays minimal.
 */
export function searchFilterToSmartAlbumFilter(filter: SearchFilter): SmartAlbumFilter {
  const emptyStringToNull = (value?: string) => (value === '' ? null : value);
  const parseOptional = (d?: DateTime) => (d ? parseUtcDate(d.toString()) : undefined);

  let type: AssetTypeEnum | undefined;
  if (filter.mediaType === MediaType.Image) {
    type = AssetTypeEnum.Image;
  } else if (filter.mediaType === MediaType.Video) {
    type = AssetTypeEnum.Video;
  }

  const payload: SmartAlbumFilter = {
    country: emptyStringToNull(filter.location.country),
    state: emptyStringToNull(filter.location.state),
    city: emptyStringToNull(filter.location.city),
    make: emptyStringToNull(filter.camera.make),
    model: emptyStringToNull(filter.camera.model),
    lensModel: emptyStringToNull(filter.camera.lensModel),
    takenAfter: parseOptional(filter.date.takenAfter)?.startOf('day').toISO() || undefined,
    takenBefore: parseOptional(filter.date.takenBefore)?.endOf('day').toISO() || undefined,
    visibility: filter.display.isArchive ? Visibility.Archive : undefined,
    isFavorite: filter.display.isFavorite || undefined,
    isNotInAlbum: filter.display.isNotInAlbum || undefined,
    personIds: filter.personIds.size > 0 ? [...filter.personIds] : undefined,
    tagIds: filter.tagIds === null ? null : filter.tagIds.size > 0 ? [...filter.tagIds] : undefined,
    type,
    rating: filter.rating ?? undefined,
  };

  // Strip undefined keys so the persisted filter stays small/clean.
  for (const key of Object.keys(payload) as (keyof SmartAlbumFilter)[]) {
    if (payload[key] === undefined) {
      delete payload[key];
    }
  }
  return payload;
}

const isFormManaged = (key: string) => (FORM_MANAGED_FILTER_KEYS as readonly string[]).includes(key);

/** What the form submits for `filter` when it is opened on it and saved without any edit. */
const unchangedFormValue = (filter: SmartAlbumFilter | null | undefined) =>
  searchFilterToSmartAlbumFilter(smartAlbumFilterToSearchFilter(filter));

/**
 * The submit payload of a smart-album editor opened on `original` (carry/convert/merge).
 *
 * The widgets cannot express every stored value exactly: exact `takenAfter`/`takenBefore`
 * instants (the date pickers work in whole days), `isFavorite: false`, `rating: null`,
 * media types other than image/video, `visibility: timeline`, empty id lists, ... A
 * form-managed field the user did not change therefore keeps its stored value verbatim;
 * only a field whose form value differs from what the unedited form would submit takes the
 * form's value. Keys the form does not manage at all (description, OCR, created/updated
 * dates, library, albums, ...) are always carried. Opening and saving without edits is the
 * identity; dropping or re-encoding a criterion would silently broaden the album.
 */
export function mergeSmartAlbumFilter(
  original: SmartAlbumFilter | null | undefined,
  form: SearchFilter,
): SmartAlbumFilter {
  const stored: Record<string, unknown> = { ...original };
  const unchanged: Record<string, unknown> = { ...unchangedFormValue(original) };
  const edited: Record<string, unknown> = { ...searchFilterToSmartAlbumFilter(form) };

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (!isFormManaged(key) && value !== undefined) {
      result[key] = value;
    }
  }
  for (const key of FORM_MANAGED_FILTER_KEYS) {
    const value = isEqual(edited[key], unchanged[key]) ? stored[key] : edited[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as SmartAlbumFilter;
}

/**
 * Keys of `filter` the form does not show at all: criteria it does not manage, and stored
 * values its widgets render as "nothing selected" (e.g. `isFavorite: false`). They are kept
 * on save (see mergeSmartAlbumFilter); editors list them so the user knows they exist.
 */
export function hiddenSmartAlbumFilterKeys(filter: SmartAlbumFilter | null | undefined): string[] {
  const unchanged: Record<string, unknown> = { ...unchangedFormValue(filter) };
  return Object.entries(filter ?? {})
    .filter(([key, value]) => value !== undefined && (!isFormManaged(key) || unchanged[key] === undefined))
    .filter(
      ([key, value]) =>
        !(Array.isArray(value) && value.length === 0) && !(key === 'visibility' && value === Visibility.Timeline),
    )
    .map(([key]) => key);
}

/** Keys of the legacy (v1/flat) smart-album filter shape, and which of them may be null. */
const SMART_ALBUM_FILTER_KEYS: Record<keyof Required<SmartAlbumFilter>, { nullable: boolean }> = {
  albumIds: { nullable: false },
  city: { nullable: true },
  country: { nullable: true },
  createdAfter: { nullable: false },
  createdBefore: { nullable: false },
  description: { nullable: false },
  isEncoded: { nullable: false },
  isFavorite: { nullable: false },
  isMotion: { nullable: false },
  isNotInAlbum: { nullable: false },
  lensModel: { nullable: true },
  libraryId: { nullable: true },
  make: { nullable: true },
  model: { nullable: true },
  ocr: { nullable: false },
  originalFileName: { nullable: false },
  personIds: { nullable: false },
  rating: { nullable: true },
  state: { nullable: true },
  tagIds: { nullable: true },
  takenAfter: { nullable: false },
  takenBefore: { nullable: false },
  type: { nullable: false },
  updatedAfter: { nullable: false },
  updatedBefore: { nullable: false },
  visibility: { nullable: false },
};

/** Search request keys that page or present results but do not narrow them. */
const SEARCH_PRESENTATION_KEYS = new Set([
  'cursor',
  'language',
  'order',
  'orderBy',
  'page',
  'queryType',
  'size',
  'withExif',
  'withPeople',
  'withStacked',
]);

const isNoCriterion = (value: unknown) =>
  value === undefined ||
  value === '' ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0);

/**
 * Serialize the search page's terms (a MetadataSearchDto/SmartSearchDto) into the legacy
 * (v1/flat) smart-album filter shape that stored filters keep (D11).
 *
 * Every criterion either maps exactly or is reported in `unsupported`; nothing is dropped
 * silently. A smart album saved without an unsupported criterion would be broader than the
 * search it came from, so callers must refuse to save while `unsupported` is non-empty.
 * Unsupported are, e.g., the semantic `query`, `queryAssetId`, `originalPath`, a hidden or
 * locked `visibility`, and the structured `filter` (with `or` branches and operators the
 * flat shape cannot express).
 */
export function searchTermsToSmartAlbumFilter(terms: Record<string, unknown>): {
  filter: SmartAlbumFilter;
  unsupported: string[];
} {
  const filter: Record<string, unknown> = {};
  const unsupported: string[] = [];

  for (const [key, value] of Object.entries(terms)) {
    if (SEARCH_PRESENTATION_KEYS.has(key) || isNoCriterion(value)) {
      continue;
    }

    const spec = Object.hasOwn(SMART_ALBUM_FILTER_KEYS, key)
      ? SMART_ALBUM_FILTER_KEYS[key as keyof SmartAlbumFilter]
      : undefined;
    if (!spec) {
      unsupported.push(key);
      continue;
    }

    if (value === null && !spec.nullable) {
      // e.g. isFavorite: null - the search treats it as "no criterion" as well
      continue;
    }

    // Smart-album filters only accept timeline/archive visibility (the server rejects the rest).
    if (key === 'visibility' && value !== Visibility.Timeline && value !== Visibility.Archive) {
      unsupported.push(key);
      continue;
    }

    filter[key] = value;
  }

  return { filter: filter as SmartAlbumFilter, unsupported };
}
