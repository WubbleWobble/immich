<script lang="ts">
  import { goto } from '$app/navigation';
  import SmartAlbumFilterForm, {
    isEmptySmartAlbumFilter,
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
    onClose: (album?: AlbumResponseDto) => void;
  };

  let { onClose }: Props = $props();

  let name = $state('');
  let filter: SearchFilter = $state(smartAlbumFilterToSearchFilter(undefined));
  let errorMessage = $state('');

  const onSubmit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }
    const payload = searchFilterToSmartAlbumFilter(filter);
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

<FormModal icon={mdiAutoFix} title={$t('smart_album_new')} submitText={$t('create')} size="giant" {onClose} {onSubmit}>
  {#snippet children({ formId })}
    {#if errorMessage}
      <p class="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{errorMessage}</p>
    {/if}
    <SmartAlbumFilterForm {formId} bind:name bind:filter />
  {/snippet}
</FormModal>
