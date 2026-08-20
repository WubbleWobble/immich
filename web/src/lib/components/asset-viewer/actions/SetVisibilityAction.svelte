<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import { AssetAction } from '$lib/constants';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { lockManager } from '$lib/managers/lock-manager.svelte';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { Route } from '$lib/route';
  import { moveAssetsToLockedAlbum } from '$lib/services/album.service';
  import { handleError } from '$lib/utils/handle-error';
  import { modalManager, toastManager } from '@immich/ui';
  import { mdiLockOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { OnAction, PreAction } from './action';

  interface Props {
    asset: TimelineAsset;
    onAction: OnAction;
    preAction: PreAction;
  }

  let { asset, onAction, preAction }: Props = $props();

  // Routes to the per-user built-in locked ALBUM - and really moves: the asset is also
  // removed from its other regular albums, since any unlocked membership would rescue it
  // from the lock and it would reappear on refresh. Requires an elevated session.
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
      const albumId = await lockManager.ensureBuiltInLockedAlbum(authManager.user.id);
      const { stillVisible, failed } = await moveAssetsToLockedAlbum(albumId, [asset.id]);
      if (failed.length > 0) {
        toastManager.warning($t('move_to_locked_folder_failed_count', { values: { count: failed.length } }));
        return;
      }
      if (stillVisible.length > 0) {
        toastManager.info($t('move_to_locked_folder_still_visible_count', { values: { count: stillVisible.length } }));
        return;
      }
      // Fully hidden - only now does the asset leave the viewer.
      preAction({ type: AssetAction.SET_VISIBILITY_LOCKED, asset });
      onAction({ type: AssetAction.SET_VISIBILITY_LOCKED, asset });
    } catch (error) {
      handleError(error, $t('errors.unable_to_save_settings'));
    }
  };
</script>

<MenuOption onClick={() => moveToLockedAlbum()} text={$t('move_to_locked_folder')} icon={mdiLockOutline} />
