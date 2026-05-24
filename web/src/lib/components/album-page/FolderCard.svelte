<script lang="ts">
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getContextMenuPositionFromEvent, type ContextMenuPosition } from '$lib/utils/context-menu';
  import { getAssetMediaUrl } from '$lib/utils';
  import { type AlbumContainerResponseDto } from '@immich/sdk';
  import { Icon, IconButton } from '@immich/ui';
  import { mdiDotsVertical, mdiFolderOutline, mdiShareVariantOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    folder: AlbumContainerResponseDto;
    childCount?: number;
    onShowContextMenu?: ((position: ContextMenuPosition) => unknown) | undefined;
  }

  let { folder, childCount = 0, onShowContextMenu }: Props = $props();

  const isShared = $derived(
    (folder.albumContainerUsers && folder.albumContainerUsers.length > 0) || folder.ownerId !== authManager.user.id,
  );

  const thumbnailIds = $derived(folder.thumbnailAssetIds ?? []);
  const hasThumbnails = $derived(thumbnailIds.length > 0);

  const showFolderContextMenu = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onShowContextMenu?.(getContextMenuPositionFromEvent(e));
  };
</script>

<div
  class="group relative rounded-2xl border border-transparent p-5 hover:border-gray-200 hover:bg-gray-100 dark:hover:border-gray-800 dark:hover:bg-gray-900"
  data-testid="folder-card"
>
  {#if onShowContextMenu}
    <div
      id="folder-icon-{folder.id}"
      class="absolute inset-e-6 top-6 opacity-0 group-hover:opacity-100 focus-within:opacity-100"
      data-testid="folder-context-button-parent"
    >
      <IconButton
        color="secondary"
        aria-label={$t('show_album_options')}
        icon={mdiDotsVertical}
        shape="round"
        variant="filled"
        size="medium"
        class="icon-white-drop-shadow"
        onclick={showFolderContextMenu}
      />
    </div>
  {/if}

  <div
    class="relative aspect-square w-full overflow-hidden rounded-xl bg-subtle text-gray-500 transition-all duration-300 group-hover:shadow-lg dark:bg-immich-dark-gray dark:text-gray-300"
  >
    {#if hasThumbnails}
      {#if thumbnailIds.length === 1}
        <img
          src={getAssetMediaUrl({ id: thumbnailIds[0] })}
          alt={folder.name}
          class="size-full object-cover"
          draggable="false"
          loading="lazy"
        />
      {:else}
        <div class="grid size-full grid-cols-2 grid-rows-2 gap-px">
          {#each thumbnailIds.slice(0, 4) as assetId (assetId)}
            <img
              src={getAssetMediaUrl({ id: assetId })}
              alt={folder.name}
              class="size-full object-cover"
              draggable="false"
              loading="lazy"
            />
          {/each}
          {#if thumbnailIds.length === 3}
            <!-- Fill empty 4th cell so the 2x2 grid stays square. -->
            <div class="size-full bg-subtle dark:bg-immich-dark-gray"></div>
          {/if}
        </div>
      {/if}
      <!-- Small badge so a folder is still visually distinguishable from an album. -->
      <div
        class="absolute inset-e-2 bottom-2 flex items-center justify-center rounded-full bg-black/55 p-1.5 text-white shadow-sm"
        title={$t('folder')}
      >
        <Icon icon={mdiFolderOutline} size="16" />
      </div>
    {:else}
      <div class="flex size-full items-center justify-center">
        <Icon icon={mdiFolderOutline} size="40%" />
      </div>
    {/if}
  </div>

  <div class="mt-4">
    <p
      class="line-clamp-2 w-full text-lg/6 font-semibold text-black group-hover:text-primary dark:text-white"
      data-testid="folder-name"
      title={folder.name}
    >
      {folder.name}
      {#if isShared}
        <Icon icon={mdiShareVariantOutline} size="16" class="ms-1 inline opacity-70" title={$t('shared')} />
      {/if}
    </p>

    <span class="flex gap-2 text-sm dark:text-immich-dark-fg" data-testid="folder-details">
      <p>{$t('items_count', { values: { count: childCount } })}</p>
    </span>
  </div>
</div>
