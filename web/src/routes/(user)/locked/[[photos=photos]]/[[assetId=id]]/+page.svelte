<script lang="ts">
  import { goto } from '$app/navigation';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import EmptyPlaceholder from '$lib/components/shared-components/EmptyPlaceholder.svelte';
  import { lockManager } from '$lib/managers/lock-manager.svelte';
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import { AlbumKind, getAlbumContainer, getAlbumInfo } from '@immich/sdk';
  import { Button, Icon, modalManager, Switch, Text } from '@immich/ui';
  import { mdiAutoFix, mdiFolderOutline, mdiImageAlbum, mdiLockOffOutline, mdiLockOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
  void data;

  type LockEntry = {
    kind: 'album' | 'smart' | 'folder';
    id: string;
    name: string;
    unavailable: boolean;
  };

  let entries: LockEntry[] = $state([]);
  let loading = $state(true);

  const load = async () => {
    loading = true;
    try {
      await lockManager.refresh();
      const items: LockEntry[] = [];
      for (const id of lockManager.lockedAlbumIds) {
        try {
          const album = await getAlbumInfo({ id });
          items.push({
            kind: album.kind === AlbumKind.Smart ? 'smart' : 'album',
            id,
            name: album.albumName,
            unavailable: false,
          });
        } catch {
          // Stale lock (album deleted or access lost): still listed so it can be removed.
          items.push({ kind: 'album', id, name: $t('locks_unavailable_item'), unavailable: true });
        }
      }
      for (const id of lockManager.lockedContainerIds) {
        try {
          const folder = await getAlbumContainer({ id });
          items.push({ kind: 'folder', id, name: folder.name, unavailable: false });
        } catch {
          items.push({ kind: 'folder', id, name: $t('locks_unavailable_item'), unavailable: true });
        }
      }
      entries = items.sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      handleError(error, $t('locks_failed_to_load'));
    } finally {
      loading = false;
    }
  };

  onMount(() => void load());

  const iconFor = (kind: LockEntry['kind']) =>
    kind === 'folder' ? mdiFolderOutline : kind === 'smart' ? mdiAutoFix : mdiImageAlbum;

  const isRevealed = (entry: LockEntry) =>
    entry.kind === 'folder'
      ? lockManager.revealedContainerIds.has(entry.id)
      : lockManager.revealedAlbumIds.has(entry.id);

  const toggleReveal = (entry: LockEntry, revealed: boolean) => {
    if (entry.kind === 'folder') {
      lockManager.revealContainer(entry.id, revealed);
    } else {
      lockManager.revealAlbum(entry.id, revealed);
    }
  };

  const removeLock = async (entry: LockEntry) => {
    const confirmed = await modalManager.showDialog({
      title: $t('locks_remove_title'),
      prompt: $t('locks_remove_prompt', { values: { name: entry.name } }),
      confirmText: $t('remove'),
    });
    if (!confirmed) {
      return;
    }
    try {
      await (entry.kind === 'folder' ? lockManager.unlockContainer(entry.id) : lockManager.unlockAlbum(entry.id));
      entries = entries.filter((existing) => existing !== entry);
    } catch (error) {
      handleError(error, $t('locks_failed_to_remove'));
    }
  };

  const endSession = async () => {
    try {
      await lockManager.endElevatedSession();
      await goto(Route.photos());
    } catch (error) {
      handleError(error, $t('locks_failed_to_end_session'));
    }
  };
</script>

<UserPageLayout title={$t('locked_folder')}>
  {#snippet buttons()}
    <Button size="small" variant="ghost" color="secondary" leadingIcon={mdiLockOutline} onclick={endSession}>
      {$t('locks_end_session')}
    </Button>
  {/snippet}

  <div class="mx-auto w-full max-w-3xl">
    <p class="mb-6 text-sm text-immich-fg/70 dark:text-immich-dark-fg/70">
      {$t('locks_description')}
    </p>

    {#if !loading && entries.length === 0}
      <EmptyPlaceholder text={$t('locks_empty_message')} class="mx-auto mt-10" />
    {/if}

    <div class="flex flex-col gap-2">
      {#each entries as entry (entry.kind + entry.id)}
        <div
          class="flex items-center justify-between gap-4 rounded-2xl border border-gray-200 px-4 py-3 dark:border-immich-dark-gray"
        >
          <div class="flex min-w-0 items-center gap-3">
            <Icon icon={iconFor(entry.kind)} size="24" class="shrink-0" />
            <div class="min-w-0">
              <Text class="truncate" fontWeight="semi-bold">{entry.name}</Text>
              <Text size="tiny" color="muted">
                {entry.kind === 'folder' ? $t('folder') : entry.kind === 'smart' ? $t('smart_album') : $t('album')}
              </Text>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-4">
            {#if !entry.unavailable}
              <label class="flex items-center gap-2 text-sm">
                {$t('locks_reveal_this_session')}
                <Switch checked={isRevealed(entry)} onCheckedChange={(checked) => toggleReveal(entry, checked)} />
              </label>
            {/if}
            <Button
              size="small"
              variant="ghost"
              color="danger"
              leadingIcon={mdiLockOffOutline}
              onclick={() => removeLock(entry)}
            >
              {$t('locks_remove')}
            </Button>
          </div>
        </div>
      {/each}
    </div>
  </div>
</UserPageLayout>
