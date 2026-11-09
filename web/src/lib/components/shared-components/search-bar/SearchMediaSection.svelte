<script lang="ts">
  import { MediaType } from '$lib/constants';
  import { Text } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import { searchManager } from '$lib/managers/search-manager.svelte';
  import type { SearchFilter } from '$lib/types';
  import SearchButton from './SearchButton.svelte';

  interface Props {
    /** Edit this filter instead of the search bar's (searchManager.filter), e.g. in a smart-album editor. */
    filter?: SearchFilter;
  }

  let { filter = $bindable() }: Props = $props();

  let target = $derived(filter ?? searchManager.filter);
  let filteredMedia = $derived(target.mediaType);
</script>

<div id="media-type-selection">
  <fieldset>
    <Text class="pb-5">{$t('media_type_description')}</Text>

    <div class="flex flex-wrap gap-2">
      <SearchButton checked active={filteredMedia === MediaType.All} onclick={() => (target.mediaType = MediaType.All)}>
        {$t('all')}
      </SearchButton>
      <SearchButton
        checked
        active={filteredMedia === MediaType.Image}
        onclick={() => (target.mediaType = MediaType.Image)}
      >
        {$t('image')}
      </SearchButton>
      <SearchButton
        checked
        active={filteredMedia === MediaType.Video}
        onclick={() => (target.mediaType = MediaType.Video)}
      >
        {$t('video')}
      </SearchButton>
    </div>
  </fieldset>
</div>
