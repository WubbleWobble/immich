<script lang="ts">
  import { scrollMemory } from '$lib/actions/scroll-memory';
  import AlbumsControls from './AlbumsControls.svelte';
  import Albums from '$lib/components/album-page/AlbumsList.svelte';
  import FolderBreadcrumb from '$lib/components/album-page/FolderBreadcrumb.svelte';
  import FolderCard from '$lib/components/album-page/FolderCard.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import RightClickContextMenu from '$lib/components/shared-components/context-menu/RightClickContextMenu.svelte';
  import EmptyPlaceholder from '$lib/components/shared-components/EmptyPlaceholder.svelte';
  import GroupTab from '$lib/elements/GroupTab.svelte';
  import SearchBar from '$lib/elements/SearchBar.svelte';
  import MoveToFolderModal from '$lib/modals/MoveToFolderModal.svelte';
  import ShareFolderModal from '$lib/modals/ShareFolderModal.svelte';
  import { Route } from '$lib/route';
  import { AlbumFilter, albumViewSettings } from '$lib/stores/preferences.store';
  import { createAlbumAndRedirect } from '$lib/utils/album-utils';
  import type { ContextMenuPosition } from '$lib/utils/context-menu';
  import { handleError } from '$lib/utils/handle-error';
  import { normalizeSearchString } from '$lib/utils/string-utils';
  import { deleteAlbumContainer, type AlbumContainerResponseDto } from '@immich/sdk';
  import { goto, invalidateAll } from '$app/navigation';
  import { modalManager, toastManager } from '@immich/ui';
  import { mdiDeleteOutline, mdiFolderMoveOutline, mdiShareVariantOutline } from '@mdi/js';
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
    containers.filter((c) => c.parentId === folderId).sort((a, b) => a.name.localeCompare(b.name)),
  );

  let normalizedQuery = $derived(normalizeSearchString(searchQuery));
  let filteredFolders = $derived(
    normalizedQuery
      ? visibleFolders.filter((c) => normalizeSearchString(c.name).includes(normalizedQuery))
      : visibleFolders,
  );

  // Filter albums by current folder context (containerId).
  let scopedOwnedAlbums = $derived((data.albums ?? []).filter((a) => (a.containerId ?? null) === folderId));
  let scopedSharedAlbums = $derived((data.sharedAlbums ?? []).filter((a) => (a.containerId ?? null) === folderId));

  // Direct child count for a folder (sub-folders + albums in that folder).
  const childCountFor = (folder: AlbumContainerResponseDto) => {
    const subFolders = containers.filter((c) => c.parentId === folder.id).length;
    const subAlbums = (data.albums ?? []).filter((a) => a.containerId === folder.id).length;
    return subFolders + subAlbums;
  };

  const navigateToFolder = async (id: string | null) => {
    await goto(id ? Route.albums({ folder: id }) : Route.albums(), { invalidateAll: true });
  };

  // Folder context menu state.
  let folderContextMenuPosition: ContextMenuPosition = $state({ x: 0, y: 0 });
  let selectedFolder: AlbumContainerResponseDto | undefined = $state();
  let isFolderMenuOpen = $state(false);

  const showFolderContextMenu = (position: ContextMenuPosition, folder: AlbumContainerResponseDto) => {
    selectedFolder = folder;
    folderContextMenuPosition = position;
    isFolderMenuOpen = true;
  };

  const closeFolderMenu = () => {
    isFolderMenuOpen = false;
  };

  const handleMoveFolder = async () => {
    const folder = selectedFolder;
    closeFolderMenu();
    if (!folder) {
      return;
    }
    const moved = await modalManager.show(MoveToFolderModal, {
      kind: 'folder',
      sourceId: folder.id,
      currentParentId: folder.parentId,
    });
    if (moved) {
      await invalidateAll();
    }
  };

  const handleShareFolder = async () => {
    const folder = selectedFolder;
    closeFolderMenu();
    if (!folder) {
      return;
    }
    const changed = await modalManager.show(ShareFolderModal, { folder });
    if (changed) {
      await invalidateAll();
    }
  };

  const handleDeleteFolder = async () => {
    const folder = selectedFolder;
    closeFolderMenu();
    if (!folder) {
      return;
    }
    const confirmed = await modalManager.showDialog({
      prompt: $t('confirm_delete_folder', { values: { name: folder.name } }),
    });
    if (!confirmed) {
      return;
    }
    try {
      await deleteAlbumContainer({ id: folder.id });
      toastManager.primary();
      await invalidateAll();
    } catch (error) {
      handleError(error, $t('errors.unable_to_delete_album'));
    }
  };
</script>

<UserPageLayout title={data.meta.title} use={[[scrollMemory, { routeStartsWith: Route.albums() }]]}>
  {#snippet buttons()}
    <div class="flex place-items-center gap-2">
      <AlbumsControls {albumGroups} currentFolderId={folderId} bind:searchQuery />
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
        <a
          href={Route.albums({ folder: folder.id })}
          class="h-fit"
          oncontextmenu={(event) => {
            event.preventDefault();
            showFolderContextMenu({ x: event.x, y: event.y }, folder);
          }}
        >
          <FolderCard
            {folder}
            childCount={childCountFor(folder)}
            onShowContextMenu={(position) => showFolderContextMenu(position, folder)}
          />
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

<RightClickContextMenu
  title={$t('folder')}
  {...folderContextMenuPosition}
  isOpen={isFolderMenuOpen}
  onClose={closeFolderMenu}
>
  <MenuOption icon={mdiFolderMoveOutline} text={$t('move_to_folder')} onClick={handleMoveFolder} />
  <MenuOption icon={mdiShareVariantOutline} text={$t('share')} onClick={handleShareFolder} />
  <MenuOption icon={mdiDeleteOutline} text={$t('delete')} onClick={handleDeleteFolder} />
</RightClickContextMenu>
