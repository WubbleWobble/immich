<script lang="ts">
  import { collectDescendantFolderIds } from '$lib/utils/album-folder-utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    getAllAlbumContainers,
    updateAlbumContainer,
    updateAlbumInfo,
    type AlbumContainerResponseDto,
  } from '@immich/sdk';
  import { Button, Icon, ListButton, LoadingSpinner, Modal, ModalBody, Text, toastManager } from '@immich/ui';
  import { mdiFolderOutline, mdiHomeOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    kind: 'album' | 'folder';
    sourceId: string;
    /** The current parent for the source (containerId for albums, parentId for folders). */
    currentParentId: string | null;
    onClose: (moved?: boolean) => void;
  };

  let { kind, sourceId, currentParentId, onClose }: Props = $props();

  let containers: AlbumContainerResponseDto[] = $state([]);
  let loading = $state(true);
  let saving = $state(false);

  onMount(async () => {
    try {
      containers = await getAllAlbumContainers();
    } catch (error) {
      handleError(error, $t('errors.unable_to_update_album_info'));
    } finally {
      loading = false;
    }
  });

  // For folder moves: compute disabled set (the source itself and all descendants).
  const disabledIds = $derived.by(() => {
    if (kind !== 'folder') {
      return new Set<string>();
    }
    return collectDescendantFolderIds(containers, sourceId);
  });

  // Build a flat ordered list with depth for display (sorted by name within each level).
  type Row = { folder: AlbumContainerResponseDto; depth: number };
  const rows = $derived.by(() => {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const byParent = new Map<string | null, AlbumContainerResponseDto[]>();
    for (const c of containers) {
      const list = byParent.get(c.parentId) ?? [];
      list.push(c);
      byParent.set(c.parentId, list);
    }
    for (const [, list] of byParent) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    const out: Row[] = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const folder of byParent.get(parentId) ?? []) {
        out.push({ folder, depth });
        walk(folder.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  });

  const moveTo = async (targetId: string | null) => {
    if (saving) {
      return;
    }
    if (targetId === currentParentId) {
      onClose(false);
      return;
    }
    saving = true;
    try {
      await (kind === 'album'
        ? updateAlbumInfo({ id: sourceId, updateAlbumDto: { containerId: targetId } })
        : updateAlbumContainer({
            id: sourceId,
            updateAlbumContainerDto: { parentId: targetId },
          }));
      toastManager.primary();
      onClose(true);
    } catch (error) {
      handleError(error, $t('errors.unable_to_update_album_info'));
    } finally {
      saving = false;
    }
  };
</script>

<Modal title={$t('move_to_folder')} {onClose} size="small">
  <ModalBody>
    {#if loading}
      <div class="flex w-full place-content-center place-items-center py-6">
        <LoadingSpinner />
      </div>
    {:else}
      <div class="mb-2">
        <Text size="tiny" color="muted">{$t('folders')}</Text>
      </div>

      <div class="flex max-h-100 immich-scrollbar flex-col gap-1 overflow-y-auto">
        <ListButton
          selected={currentParentId === null}
          disabled={currentParentId === null || saving}
          onclick={() => moveTo(null)}
        >
          <Icon icon={mdiHomeOutline} size="20" />
          <div class="grow text-start">
            <Text fontWeight="medium">{$t('move_to_root')}</Text>
          </div>
        </ListButton>

        {#each rows as row (row.folder.id)}
          {@const isDisabled = disabledIds.has(row.folder.id) || saving}
          {@const isCurrent = currentParentId === row.folder.id}
          <ListButton selected={isCurrent} disabled={isDisabled || isCurrent} onclick={() => moveTo(row.folder.id)}>
            <span style:padding-inline-start={`${row.depth * 16}px`} class="flex items-center gap-2">
              <Icon icon={mdiFolderOutline} size="20" />
              <Text fontWeight="medium">{row.folder.name}</Text>
            </span>
          </ListButton>
        {/each}
      </div>

      <div class="mt-3 flex justify-end">
        <Button variant="ghost" color="secondary" onclick={() => onClose(false)} disabled={saving}>
          {$t('cancel')}
        </Button>
      </div>
    {/if}
  </ModalBody>
</Modal>
