<script lang="ts">
  import { Route } from '$lib/route';
  import { userInteraction } from '$lib/stores/user.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { getAllAlbumContainers, getAllAlbums, type AlbumContainerResponseDto, type AlbumResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiFolderOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type AlbumEntry = { kind: 'album'; data: AlbumResponseDto };
  type FolderEntry = { kind: 'folder'; data: AlbumContainerResponseDto };
  type Entry = AlbumEntry | FolderEntry;

  let entries = $state<Entry[]>([]);

  const refresh = async () => {
    try {
      const [allAlbums, allContainers] = await Promise.all([getAllAlbums({}), getAllAlbumContainers()]);
      const mixed: Entry[] = [
        ...allAlbums.map((a): AlbumEntry => ({ kind: 'album', data: a })),
        ...allContainers.map((c): FolderEntry => ({ kind: 'folder', data: c })),
      ];
      entries = mixed.sort((a, b) => (a.data.updatedAt > b.data.updatedAt ? -1 : 1)).slice(0, 3);
      userInteraction.recentAlbums = entries
        .filter((e): e is AlbumEntry => e.kind === 'album')
        .map((e) => e.data);
    } catch (error) {
      handleError(error, $t('failed_to_load_assets'));
    }
  };

  // Hydrate from cache for instant paint, then refresh asynchronously so folders show up.
  if (userInteraction.recentAlbums && entries.length === 0) {
    entries = userInteraction.recentAlbums.map((a): AlbumEntry => ({ kind: 'album', data: a }));
  }

  $effect(() => {
    void refresh();
  });
</script>

{#each entries as entry (entry.data.id)}
  {#if entry.kind === 'album'}
    <a
      href={Route.viewAlbum(entry.data)}
      title={entry.data.albumName}
      class="flex w-full place-items-center justify-between gap-4 rounded-e-full py-3 ps-10 transition-[padding] delay-100 duration-100 hover:cursor-pointer hover:bg-subtle hover:text-immich-primary group-hover:sm:px-10 md:px-10 dark:text-immich-dark-fg dark:hover:bg-immich-dark-gray dark:hover:text-immich-dark-primary"
    >
      <div>
        <div
          class="size-6 rounded-sm bg-gray-200 bg-cover dark:bg-gray-600"
          style={entry.data.albumThumbnailAssetId
            ? `background-image:url('${getAssetMediaUrl({ id: entry.data.albumThumbnailAssetId })}')`
            : ''}
        ></div>
      </div>
      <div class="grow truncate text-sm font-medium">
        {entry.data.albumName}
      </div>
    </a>
  {:else}
    <a
      href={Route.albums({ folder: entry.data.id })}
      title={entry.data.name}
      class="flex w-full place-items-center justify-between gap-4 rounded-e-full py-3 ps-10 transition-[padding] delay-100 duration-100 hover:cursor-pointer hover:bg-subtle hover:text-immich-primary group-hover:sm:px-10 md:px-10 dark:text-immich-dark-fg dark:hover:bg-immich-dark-gray dark:hover:text-immich-dark-primary"
    >
      <div class="flex size-6 items-center justify-center rounded-sm bg-gray-200 dark:bg-gray-600">
        <Icon icon={mdiFolderOutline} size="14" />
      </div>
      <div class="grow truncate text-sm font-medium">
        {entry.data.name}
      </div>
    </a>
  {/if}
{/each}
