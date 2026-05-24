<script lang="ts">
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getContextMenuPositionFromEvent, type ContextMenuPosition } from '$lib/utils/context-menu';
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
    class="flex aspect-square w-full items-center justify-center rounded-xl bg-subtle text-gray-500 transition-all duration-300 group-hover:shadow-lg dark:bg-immich-dark-gray dark:text-gray-300"
  >
    <Icon icon={mdiFolderOutline} size="40%" />
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
