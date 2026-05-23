<script lang="ts">
  import { goto } from '$app/navigation';
  import SmartAlbumFilterForm, {
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

  let name = $state(initialName);
  let filter: SearchFilter = $state(
    smartAlbumFilterToSearchFilter(metadataSearchToSmartAlbumFilter((initialFilter ?? {}) as Record<string, unknown>)),
  );

  const onSubmit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }
    try {
      const album = await createAlbum({
        createAlbumDto: {
          albumName: trimmedName,
          kind: AlbumKind.Smart,
          filter: searchFilterToSmartAlbumFilter(filter),
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
    <SmartAlbumFilterForm {formId} bind:name bind:filter />
  {/snippet}
</FormModal>
