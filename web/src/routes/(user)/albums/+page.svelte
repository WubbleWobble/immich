<script lang="ts">
  import { scrollMemory } from '$lib/actions/scroll-memory';
  import AlbumsControls from './AlbumsControls.svelte';
  import Albums from '$lib/components/album-page/AlbumsList.svelte';
  import FolderBreadcrumb from '$lib/components/album-page/FolderBreadcrumb.svelte';
  import FolderCard from '$lib/components/album-page/FolderCard.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import EmptyPlaceholder from '$lib/components/shared-components/EmptyPlaceholder.svelte';
  import GroupTab from '$lib/elements/GroupTab.svelte';
  import SearchBar from '$lib/elements/SearchBar.svelte';
  import { Route } from '$lib/route';
  import { AlbumFilter, albumViewSettings } from '$lib/stores/preferences.store';
  import { createAlbumAndRedirect } from '$lib/utils/album-utils';
  import { normalizeSearchString } from '$lib/utils/string-utils';
  import { type AlbumContainerResponseDto } from '@immich/sdk';
  import { goto } from '$app/navigation';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let searchQuery = $state('');
  let albumGroups: string[] = $state([]);

  let containers = $derived(data.allContainers ?? []);
  let folderId = $derived(data.folderId);

  // Folders that live directly under the current folder (or root if none).
  let visibleFolders = $derived(
    containers
      .filter((c) => c.parentId === folderId)
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  let normalizedQuery = $derived(normalizeSearchString(searchQuery));
  let filteredFolders = $derived(
    normalizedQuery
      ? visibleFolders.filter((c) => normalizeSearchString(c.name).includes(normalizedQuery))
      : visibleFolders,
  );

  // Filter albums by current folder context (containerId).
  let scopedOwnedAlbums = $derived(
    (data.albums ?? []).filter((a) => (a.containerId ?? null) === folderId),
  );
  let scopedSharedAlbums = $derived(
    (data.sharedAlbums ?? []).filter((a) => (a.containerId ?? null) === folderId),
  );

  // Direct child count for a folder (sub-folders + albums in that folder).
  const childCountFor = (folder: AlbumContainerResponseDto) => {
    const subFolders = containers.filter((c) => c.parentId === folder.id).length;
    const subAlbums = (data.albums ?? []).filter((a) => a.containerId === folder.id).length;
    return subFolders + subAlbums;
  };

  const navigateToFolder = async (id: string | null) => {
    await goto(id ? Route.albums({ folder: id }) : Route.albums(), { invalidateAll: true });
  };
</script>

<UserPageLayout title={data.meta.title} use={[[scrollMemory, { routeStartsWith: Route.albums() }]]}>
  {#snippet buttons()}
    <div class="flex place-items-center gap-2">
      <AlbumsControls {albumGroups} bind:searchQuery />
    </div>
  {/snippet}

  <div class="xl:hidden">
    <div class="h-14 w-fit py-2 dark:text-immich-dark-fg">
      <GroupTab
        label={$t('show_albums')}
        filters={Object.keys(AlbumFilter)}
        selected={$albumViewSettings.filter}
        onSelect={(selected) => ($albumViewSettings.filter = selected)}
      />
    </div>
    <div class="w-60">
      <SearchBar placeholder={$t('search_albums')} bind:name={searchQuery} showLoadingSpinner={false} />
    </div>
  </div>

  {#if (data.folderPath?.length ?? 0) > 0}
    <FolderBreadcrumb path={data.folderPath ?? []} onNavigate={navigateToFolder} />
  {/if}

  {#if filteredFolders.length > 0}
    <h2 class="mt-2 text-lg font-semibold dark:text-immich-dark-fg">
      {$t('folders')}
    </h2>
    <div class="mt-2 mb-6 grid grid-auto-fill-56 gap-y-4">
      {#each filteredFolders as folder (folder.id)}
        <a href={Route.albums({ folder: folder.id })} class="h-fit">
          <FolderCard {folder} childCount={childCountFor(folder)} />
        </a>
      {/each}
    </div>
  {/if}

  <Albums
    ownedAlbums={scopedOwnedAlbums}
    sharedAlbums={scopedSharedAlbums}
    userSettings={$albumViewSettings}
    allowEdit
    {searchQuery}
    bind:albumGroupIds={albumGroups}
  >
    {#snippet empty()}
      {#if filteredFolders.length === 0}
        <EmptyPlaceholder
          text={$t('no_albums_message')}
          onClick={() => createAlbumAndRedirect()}
          class="mx-auto mt-10"
        />
      {/if}
    {/snippet}
  </Albums>
</UserPageLayout>
