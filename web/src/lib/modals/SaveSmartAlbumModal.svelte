<script lang="ts">
  import { goto } from '$app/navigation';
  import SmartAlbumFilterForm from '$lib/components/album-page/SmartAlbumFilterForm.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { Route } from '$lib/route';
  import type { SearchFilter } from '$lib/types';
  import { withElevationRetry } from '$lib/utils/elevation';
  import { handleError } from '$lib/utils/handle-error';
  import {
    hiddenSmartAlbumFilterKeys,
    isEmptySmartAlbumFilter,
    mergeSmartAlbumFilter,
    smartAlbumFilterToSearchFilter,
  } from '$lib/utils/smart-album-filter';
  import { AlbumKind, createAlbum, type AlbumResponseDto, type SmartAlbumFilter } from '@immich/sdk';
  import { FormModal } from '@immich/ui';
  import { mdiAutoFix } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    /**
     * The current search, already serialized to the legacy smart-album filter shape
     * (searchTermsToSmartAlbumFilter). Callers must not open this modal for a search that
     * has criteria the shape cannot express.
     */
    initialFilter: SmartAlbumFilter;
    /** Default album name. */
    initialName?: string;
    onClose: (album?: AlbumResponseDto) => void;
  };

  let { initialFilter, initialName = '', onClose }: Props = $props();

  // Criteria the form cannot show (description, OCR text, created/updated dates, library, ...).
  // They are kept on save, as is the exact value of every field the user leaves unchanged, so
  // the stored filter is not broader than the search it came from (mergeSmartAlbumFilter).
  const carriedKeys = hiddenSmartAlbumFilterKeys(initialFilter);

  let name = $state(initialName);
  let filter: SearchFilter = $state(smartAlbumFilterToSearchFilter(initialFilter));
  let errorMessage = $state('');

  const onSubmit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }
    const payload = mergeSmartAlbumFilter(initialFilter, filter);
    if (isEmptySmartAlbumFilter(payload)) {
      errorMessage = $t('smart_album_filter_empty_error');
      return;
    }
    try {
      const album = await withElevationRetry(() =>
        createAlbum({
          createAlbumDto: {
            albumName: trimmedName,
            kind: AlbumKind.Smart,
            filter: payload,
          },
        }),
      );
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
