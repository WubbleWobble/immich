<script lang="ts">
  import SmartAlbumDanglingReferences from '$lib/components/album-page/SmartAlbumDanglingReferences.svelte';
  import SearchCameraSection from '$lib/components/shared-components/search-bar/SearchCameraSection.svelte';
  import SearchDateSection from '$lib/components/shared-components/search-bar/SearchDateSection.svelte';
  import SearchDisplaySection from '$lib/components/shared-components/search-bar/SearchDisplaySection.svelte';
  import SearchLocationSection from '$lib/components/shared-components/search-bar/SearchLocationSection.svelte';
  import SearchMediaSection from '$lib/components/shared-components/search-bar/SearchMediaSection.svelte';
  import SearchPeopleSection from '$lib/components/shared-components/search-bar/SearchPeopleSection.svelte';
  import SearchRatingsSection from '$lib/components/shared-components/search-bar/SearchRatingsSection.svelte';
  import SearchTagsSection from '$lib/components/shared-components/search-bar/SearchTagsSection.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import type { SearchFilter } from '$lib/types';
  import {
    findDanglingSmartAlbumReferences,
    type DanglingSmartAlbumReferences,
  } from '$lib/utils/smart-album-references';
  import { Field, Input } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    formId: string;
    name: string;
    filter: SearchFilter;
    showName?: boolean;
  };

  let { formId, name = $bindable(), filter = $bindable(), showName = true }: Props = $props();

  // Section titles are only used by the search bar's filter buttons.
  let peopleTitle = $state<string>();
  let tagsTitle = $state<string>();

  // D12: ids of deleted people/tags stay in a stored filter and match nothing. The people/tag
  // pickers cannot show them, so flag them here and let the editor (always the owner) drop them.
  let dangling = $state<DanglingSmartAlbumReferences>({ personIds: [], tagIds: [] });

  onMount(async () => {
    dangling = await findDanglingSmartAlbumReferences({
      personIds: [...filter.personIds],
      tagIds: filter.tagIds === null ? null : [...filter.tagIds],
    });
  });

  const removeDangling = ({ personIds, tagIds }: DanglingSmartAlbumReferences) => {
    for (const id of personIds) {
      filter.personIds.delete(id);
    }
    for (const id of tagIds) {
      filter.tagIds?.delete(id);
    }
    dangling = {
      personIds: dangling.personIds.filter((id) => !personIds.includes(id)),
      tagIds: dangling.tagIds.filter((id) => !tagIds.includes(id)),
    };
  };
</script>

<form id={formId} autocomplete="off" class="flex flex-col gap-5 pb-6">
  {#if showName}
    <Field label={$t('name')} required>
      <Input bind:value={name} required autofocus />
    </Field>
  {/if}

  <SmartAlbumDanglingReferences references={dangling} onRemove={removeDangling} />

  <SearchPeopleSection bind:filter bind:title={peopleTitle} parentPromise={undefined} />
  <SearchTagsSection bind:filter bind:title={tagsTitle} parentPromise={undefined} />
  <SearchDateSection bind:filter />
  <SearchLocationSection bind:filter keepUnlisted />
  <SearchCameraSection bind:filter keepUnlisted />

  {#if authManager.authenticated && authManager.preferences.ratings.enabled}
    <SearchRatingsSection bind:filter />
  {/if}

  <SearchMediaSection bind:filter />
  <SearchDisplaySection bind:filter />
</form>
