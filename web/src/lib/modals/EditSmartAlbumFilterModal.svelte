<script lang="ts">
  import SmartAlbumFilterForm, {
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

  // Name is shown read-only on the heading; only the filter is editable here.
  let name = $state(album.albumName);
  let filter: SearchFilter = $state(smartAlbumFilterToSearchFilter(album.filter));

  const onSubmit = async () => {
    const success = await handleUpdateAlbum(album, {
      filter: searchFilterToSmartAlbumFilter(filter),
    });
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
    <SmartAlbumFilterForm {formId} bind:name bind:filter showName={false} />
  {/snippet}
</FormModal>
