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
  import Portal from '$lib/elements/Portal.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { AlbumFilter, albumViewSettings } from '$lib/stores/preferences.store';
  import { getDirectChildAlbums, getDirectChildCount, getDirectChildFolders } from '$lib/utils/album-folder-utils';
  import { createAlbumAndRedirect } from '$lib/utils/album-utils';
  import { lockManager } from '$lib/managers/lock-manager.svelte';
  import { getAlbumFolderActions } from '$lib/services/album.service';
  import { isEnabled } from '$lib/utils';
  import { normalizeSearchString } from '$lib/utils/string-utils';
  import { type AlbumContainerResponseDto } from '@immich/sdk';
  import { goto } from '$app/navigation';
  import { menuManager, type ActionItem } from '@immich/ui';
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
  let currentUserId = $derived(authManager.user.id);

  // The current folder; the route loader returns it when folderId is set.
  // The user can modify the current folder only when at root, or when they own it.
  let canModifyCurrentFolder = $derived(folderId === null || data.currentFolder?.ownerId === currentUserId);

  // Folders that live directly under the current folder (or root if none). A folder whose parent the
  // viewer cannot access is shown at the viewer's root (T3).
  let visibleFolders = $derived(getDirectChildFolders(containers, folderId));

  let normalizedQuery = $derived(normalizeSearchString(searchQuery));
  let filteredFolders = $derived(
    normalizedQuery
      ? visibleFolders.filter((c) => normalizeSearchString(c.name).includes(normalizedQuery))
      : visibleFolders,
  );

  // Filter albums by current folder context (containerId). An album shared from inside a folder the
  // viewer cannot access is shown at the viewer's root (T3).
  let scopedOwnedAlbums = $derived(getDirectChildAlbums(data.albums ?? [], containers, folderId));
  let scopedSharedAlbums = $derived(getDirectChildAlbums(data.sharedAlbums ?? [], containers, folderId));

  // Direct child count for a folder (sub-folders + albums in that folder). Includes albums
  // reached via cascade share so recipients of a shared folder see correct counts.
  const childCountFor = (folder: AlbumContainerResponseDto) =>
    getDirectChildCount(folder.id, containers, data.albums, data.sharedAlbums);

  const navigateToFolder = async (id: string | null) => {
    await goto(id ? Route.albums({ folder: id }) : Route.albums(), { invalidateAll: true });
  };

  $effect(() => {
    void lockManager.refresh();
  });

  // Folder context menu (right-click): @immich/ui menu anchored at the pointer, like album cards.
  let contextMenuAnchor: HTMLDivElement | undefined = $state();
  const folderMenuItems = (folder: AlbumContainerResponseDto) => Object.values(getAlbumFolderActions($t, folder));

  const onFolderContextMenu = async (event: MouseEvent, items: ActionItem[]) => {
    event.preventDefault();
    if (items.every((item) => !isEnabled(item))) {
      return;
    }
    contextMenuAnchor?.setAttribute('style', `left: ${event.x}px; top: ${event.y}px;`);
    await menuManager.show({ target: contextMenuAnchor ?? (event.currentTarget as HTMLElement), items });
  };
</script>

<UserPageLayout title={data.meta.title} use={[[scrollMemory, { routeStartsWith: Route.albums() }]]}>
  {#snippet buttons()}
    <div class="flex place-items-center gap-2">
      <AlbumsControls {albumGroups} currentFolderId={folderId} {canModifyCurrentFolder} bind:searchQuery />
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
        {@const items = folderMenuItems(folder)}
        <a
          href={Route.albums({ folder: folder.id })}
          class="h-fit"
          oncontextmenu={(event) => onFolderContextMenu(event, items)}
        >
          <FolderCard {folder} childCount={childCountFor(folder)} contextMenuItems={items} />
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
          onClick={canModifyCurrentFolder ? () => createAlbumAndRedirect(undefined, undefined, folderId) : undefined}
          class="mx-auto mt-10"
        />
      {/if}
    {/snippet}
  </Albums>
</UserPageLayout>

<Portal>
  <div bind:this={contextMenuAnchor} class="absolute"></div>
</Portal>
