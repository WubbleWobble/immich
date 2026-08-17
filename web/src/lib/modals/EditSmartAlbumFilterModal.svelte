<script lang="ts">
  import SmartAlbumFilterForm, {
    carriedSmartAlbumFilterFields,
    isEmptySmartAlbumFilter,
    searchFilterToSmartAlbumFilter,
    smartAlbumFilterToSearchFilter,
  } from '$lib/components/album-page/SmartAlbumFilterForm.svelte';
  import { handleUpdateAlbum } from '$lib/services/album.service';
  import type { SearchFilter } from '$lib/types';
  import { type AlbumResponseDto } from '@immich/sdk';
  import { FormModal } from '@immich/ui';
  import { mdiAutoFix } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    album: AlbumResponseDto;
    onClose: (updated?: boolean) => void;
  };

  let { album, onClose }: Props = $props();

  // Criteria the form cannot edit (description, OCR, created/updated dates, ...) are merged
  // back on save so editing never silently broadens the filter by dropping them.
  const carriedFilter = carriedSmartAlbumFilterFields(album.filter);
  const carriedKeys = Object.keys(carriedFilter);

  // Name is shown read-only on the heading; only the filter is editable here.
  let name = $state(album.albumName);
  let filter: SearchFilter = $state(smartAlbumFilterToSearchFilter(album.filter));
  let errorMessage = $state('');

  const onSubmit = async () => {
    const payload = { ...carriedFilter, ...searchFilterToSmartAlbumFilter(filter) };
    if (isEmptySmartAlbumFilter(payload)) {
      errorMessage = $t('smart_album_filter_empty_error');
      return;
    }
    const success = await handleUpdateAlbum(album, { filter: payload });
    if (success) {
      onClose(true);
    }
  };
</script>

<FormModal
  icon={mdiAutoFix}
  title={$t('smart_album_edit_filter_title')}
  submitText={$t('save')}
  size="giant"
  {onClose}
  {onSubmit}
>
  {#snippet children({ formId })}
    {#if carriedKeys.length > 0}
      <p class="mb-3 rounded-lg bg-primary/10 px-3 py-2 text-sm text-primary">
        {$t('smart_album_save_criteria_kept', { values: { criteria: carriedKeys.join(', ') } })}
      </p>
    {/if}
    {#if errorMessage}
      <p class="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{errorMessage}</p>
    {/if}
    <SmartAlbumFilterForm {formId} bind:name bind:filter showName={false} />
  {/snippet}
</FormModal>
