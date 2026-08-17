<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { lockManager } from '$lib/managers/lock-manager.svelte';
  import { Route } from '$lib/route';
  import { addAssetsToAlbums } from '$lib/services/album.service';
  import type { OnSetVisibility } from '$lib/utils/actions';
  import { handleError } from '$lib/utils/handle-error';
  import { Button, modalManager } from '@immich/ui';
  import { mdiLockOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    onVisibilitySet: OnSetVisibility;
    menuItem?: boolean;
  }

  let { onVisibilitySet, menuItem = false }: Props = $props();
  let loading = $state(false);

  // "Move to locked folder" now routes to the per-user built-in locked ALBUM instead of the
  // retired destructive visibility=locked write: membership in other albums is preserved,
  // and the assets hide via the locked-album visibility rule. Requires an elevated session
  // (the destination is locked content).
  const moveToLockedAlbum = async () => {
    await lockManager.refresh();
    if (!lockManager.isElevated) {
      await goto(Route.pinPrompt({ continue: page.url.pathname + page.url.search }));
      return;
    }

    const isConfirmed = await modalManager.showDialog({
      title: $t('move_to_locked_folder'),
      prompt: $t('move_to_locked_folder_confirmation'),
      confirmText: $t('move'),
      icon: mdiLockOutline,
    });
    if (!isConfirmed) {
      return;
    }

    try {
      loading = true;
      const assetIds = assetMultiSelectManager.assets.map(({ id }) => id);
      const albumId = await lockManager.ensureBuiltInLockedAlbum(authManager.user.id);
      await addAssetsToAlbums([albumId], assetIds, { notify: false });
      onVisibilitySet(assetIds);
    } catch (error) {
      handleError(error, $t('errors.unable_to_save_settings'));
    } finally {
      loading = false;
    }
  };
</script>

{#if menuItem}
  <MenuOption onClick={moveToLockedAlbum} text={$t('move_to_locked_folder')} icon={mdiLockOutline} />
{:else}
  <Button
    leadingIcon={mdiLockOutline}
    disabled={loading}
    size="medium"
    color="secondary"
    variant="ghost"
    onclick={moveToLockedAlbum}
  >
    {$t('move_to_locked_folder')}
  </Button>
{/if}
