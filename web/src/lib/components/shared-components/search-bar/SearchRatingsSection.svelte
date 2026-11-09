<script lang="ts">
  import { searchManager } from '$lib/managers/search-manager.svelte';
  import type { SearchFilter } from '$lib/types';
  import { Text } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import SearchButton from './SearchButton.svelte';

  interface Props {
    /** Edit this filter instead of the search bar's (searchManager.filter), e.g. in a smart-album editor. */
    filter?: SearchFilter;
  }

  let { filter = $bindable() }: Props = $props();

  let target = $derived(filter ?? searchManager.filter);
  let rating = $derived(target.rating);

  const options = [
    { value: 5, label: '★★★★★' },
    { value: 4, label: '★★★★' },
    { value: 3, label: '★★★' },
    { value: 2, label: '★★' },
    { value: 1, label: '★' },
  ];
</script>

<div class="flex flex-col">
  <Text class="my-5" fontWeight="medium">{$t('rating')}</Text>
  <div class="flex flex-wrap gap-2">
    {#each options as option (option.value)}
      <SearchButton
        active={rating === option.value}
        onclick={() => (target.rating = rating === option.value ? undefined : option.value)}
      >
        {option.label}
      </SearchButton>
    {/each}
  </div>
</div>
