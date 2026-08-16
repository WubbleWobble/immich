<script lang="ts" module>
  import { AssetTypeEnum, Visibility, type SmartAlbumFilter } from '@immich/sdk';
  import { MediaType } from '$lib/constants';
  import type { SearchFilter } from '$lib/types';
  import { parseUtcDate } from '$lib/utils/date-time';
  import type { DateTime } from 'luxon';
  import { SvelteSet } from 'svelte/reactivity';

  /**
   * Convert a persisted SmartAlbumFilter into the SearchFilter shape used by
   * the existing search-bar section components. The smart-album filter is a
   * subset of MetadataSearchDto so this is mostly a mechanical mapping.
   */
  export function smartAlbumFilterToSearchFilter(filter: SmartAlbumFilter | null | undefined): SearchFilter {
    const f = filter ?? {};
    const toStartOfDay = (s?: string) => (s ? parseUtcDate(s).startOf('day') : undefined);
    const withNullAsUndefined = <T,>(value: T | null | undefined) => (value === null ? undefined : value);
    return {
      // Smart albums don't support semantic-query/OCR/path-based search,
      // they're metadata-only. Leave query inputs empty.
      query: '',
      ocr: undefined,
      queryType: 'smart',
      personIds: new SvelteSet(f.personIds ?? []),
      tagIds: f.tagIds === null ? null : new SvelteSet(f.tagIds ?? []),
      location: {
        country: withNullAsUndefined(f.country),
        state: withNullAsUndefined(f.state),
        city: withNullAsUndefined(f.city),
      },
      camera: {
        make: withNullAsUndefined(f.make),
        model: withNullAsUndefined(f.model),
        lensModel: withNullAsUndefined(f.lensModel),
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
   * Convert SearchFilter back into a SmartAlbumFilter for persistence.
   * Empty/falsy fields are omitted so the saved filter stays minimal.
   */
  export function searchFilterToSmartAlbumFilter(filter: SearchFilter): SmartAlbumFilter {
    const parseOptional = (d?: DateTime) => (d ? parseUtcDate(d.toString()) : undefined);

    let type: AssetTypeEnum | undefined;
    if (filter.mediaType === MediaType.Image) {
      type = AssetTypeEnum.Image;
    } else if (filter.mediaType === MediaType.Video) {
      type = AssetTypeEnum.Video;
    }

    const payload: SmartAlbumFilter = {
      country: filter.location.country,
      state: filter.location.state,
      city: filter.location.city,
      make: filter.camera.make,
      model: filter.camera.model,
      lensModel: filter.camera.lensModel,
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

  /**
   * Best-effort: build a SmartAlbumFilter directly from a MetadataSearchDto-like
   * search-page state. The search page stores its terms as parsed JSON, which is
   * already metadata-shaped, so most fields pass through; we only drop the
   * smart-album-incompatible ones (page/size/withExif/etc).
   */
  export function metadataSearchToSmartAlbumFilter(terms: Record<string, unknown>): SmartAlbumFilter {
    const allowed: (keyof SmartAlbumFilter)[] = [
      'albumIds',
      'city',
      'country',
      'createdAfter',
      'createdBefore',
      'description',
      'isEncoded',
      'isFavorite',
      'isMotion',
      'isNotInAlbum',
      'isOffline',
      'lensModel',
      'libraryId',
      'make',
      'model',
      'ocr',
      'originalFileName',
      'personIds',
      'rating',
      'state',
      'tagIds',
      'takenAfter',
      'takenBefore',
      'trashedAfter',
      'trashedBefore',
      'type',
      'updatedAfter',
      'updatedBefore',
      'visibility',
    ];
    const out: Record<string, unknown> = {};
    for (const key of allowed) {
      const v = terms[key];
      if (v === undefined) {
        continue;
      }
      // tagIds: null is a meaningful "untagged" value, keep it.
      if (v === null && key !== 'tagIds') {
        continue;
      }
      // Drop empty strings / empty arrays — they are noise.
      if (typeof v === 'string' && v.length === 0) {
        continue;
      }
      if (Array.isArray(v) && v.length === 0) {
        continue;
      }
      // Smart-album filters only accept timeline/archive visibility; a locked/hidden
      // search must not carry its visibility into the stored filter (server rejects it).
      if (key === 'visibility' && v !== Visibility.Timeline && v !== Visibility.Archive) {
        continue;
      }
      out[key] = v;
    }
    return out as SmartAlbumFilter;
  }
</script>

<script lang="ts">
  import SearchCameraSection from '$lib/components/shared-components/search-bar/SearchCameraSection.svelte';
  import SearchDateSection from '$lib/components/shared-components/search-bar/SearchDateSection.svelte';
  import SearchDisplaySection from '$lib/components/shared-components/search-bar/SearchDisplaySection.svelte';
  import SearchLocationSection from '$lib/components/shared-components/search-bar/SearchLocationSection.svelte';
  import SearchMediaSection from '$lib/components/shared-components/search-bar/SearchMediaSection.svelte';
  import SearchPeopleSection from '$lib/components/shared-components/search-bar/SearchPeopleSection.svelte';
  import SearchRatingsSection from '$lib/components/shared-components/search-bar/SearchRatingsSection.svelte';
  import SearchTagsSection from '$lib/components/shared-components/search-bar/SearchTagsSection.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Field, Input } from '@immich/ui';
  import { t } from 'svelte-i18n';

  type Props = {
    formId: string;
    name: string;
    filter: SearchFilter;
    showName?: boolean;
  };

  let { formId, name = $bindable(), filter = $bindable(), showName = true }: Props = $props();
</script>

<form id={formId} autocomplete="off" class="flex flex-col gap-5 pb-6">
  {#if showName}
    <Field label={$t('name')} required>
      <Input bind:value={name} required autofocus />
    </Field>
  {/if}

  <SearchPeopleSection bind:selectedPeople={filter.personIds} />
  <SearchTagsSection bind:selectedTags={filter.tagIds} />
  <SearchLocationSection bind:filters={filter.location} />
  <SearchCameraSection bind:filters={filter.camera} />
  <SearchDateSection bind:filters={filter.date} />

  {#if authManager.authenticated && authManager.preferences.ratings.enabled}
    <SearchRatingsSection bind:rating={filter.rating} />
  {/if}

  <div class="grid gap-x-5 gap-y-10 md:grid-cols-2">
    <SearchMediaSection bind:filteredMedia={filter.mediaType} />
    <SearchDisplaySection bind:filters={filter.display} />
  </div>
</form>
