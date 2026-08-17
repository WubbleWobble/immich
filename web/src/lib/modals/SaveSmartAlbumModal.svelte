<script lang="ts">
  import { goto } from '$app/navigation';
  import SmartAlbumFilterForm, {
    carriedSmartAlbumFilterFields,
    isEmptySmartAlbumFilter,
    metadataSearchToSmartAlbumFilter,
    searchFilterToSmartAlbumFilter,
    smartAlbumFilterToSearchFilter,
  } from '$lib/components/album-page/SmartAlbumFilterForm.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { Route } from '$lib/route';
  import type { SearchFilter } from '$lib/types';
  import { handleError } from '$lib/utils/handle-error';
  import { AlbumKind, createAlbum, type AlbumResponseDto } from '@immich/sdk';
  import { FormModal } from '@immich/ui';
  import { mdiAutoFix } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    /** Initial search filter (e.g. the search page's current terms). */
    initialFilter?: Record<string, unknown> | null;
    /** Default album name. */
    initialName?: string;
    onClose: (album?: AlbumResponseDto) => void;
  };

  let { initialFilter = null, initialName = '', onClose }: Props = $props();

  const baseFilter = metadataSearchToSmartAlbumFilter((initialFilter ?? {}) as Record<string, unknown>);
  // Criteria the form cannot edit but the smart-album filter supports (description, OCR
  // text, created/updated dates, library, ...). These are merged back on save so the stored
  // filter is not silently broader than the search it came from.
  const carriedFilter = carriedSmartAlbumFilterFields(baseFilter);
  const carriedKeys = Object.keys(carriedFilter);
  // Criteria that smart albums cannot express at all (most notably the semantic `query`).
  const droppedKeys = Object.keys(initialFilter ?? {}).filter((key) => {
    const value = (initialFilter ?? {})[key];
    if (key === 'queryType' || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
      return false;
    }
    return !(key in baseFilter);
  });

  let name = $state(initialName);
  let filter: SearchFilter = $state(smartAlbumFilterToSearchFilter(baseFilter));
  let errorMessage = $state('');

  const onSubmit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }
    const payload = { ...carriedFilter, ...searchFilterToSmartAlbumFilter(filter) };
    if (isEmptySmartAlbumFilter(payload)) {
      errorMessage = $t('smart_album_filter_empty_error');
      return;
    }
    try {
      const album = await createAlbum({
        createAlbumDto: {
          albumName: trimmedName,
          kind: AlbumKind.Smart,
          filter: payload,
        },
      });
      eventManager.emit('AlbumCreate', album);
      onClose(album);
      await goto(Route.viewAlbum({ id: album.id }));
    } catch (error) {
      handleError(error, $t('errors.failed_to_create_album'));
    }
  };
</script>

<FormModal
  icon={mdiAutoFix}
  title={$t('smart_album_save_as')}
  submitText={$t('save')}
  size="giant"
  {onClose}
  {onSubmit}
>
  {#snippet children({ formId })}
    <p class="mb-4 text-sm text-immich-fg/80 dark:text-immich-dark-fg/80">
      {$t('smart_album_save_as_description')}
    </p>
    {#if droppedKeys.length > 0}
      <p class="mb-3 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
        {$t('smart_album_save_criteria_dropped', { values: { criteria: droppedKeys.join(', ') } })}
      </p>
    {/if}
    {#if carriedKeys.length > 0}
      <p class="mb-3 rounded-lg bg-primary/10 px-3 py-2 text-sm text-primary">
        {$t('smart_album_save_criteria_kept', { values: { criteria: carriedKeys.join(', ') } })}
      </p>
    {/if}
    {#if errorMessage}
      <p class="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{errorMessage}</p>
    {/if}
    <SmartAlbumFilterForm {formId} bind:name bind:filter />
  {/snippet}
</FormModal>
