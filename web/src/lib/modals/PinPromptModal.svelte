<script lang="ts">
  import PinCodeCreateForm from '$lib/components/user-settings-page/PinCodeCreateForm.svelte';
  import { lockManager } from '$lib/managers/lock-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { getAuthStatus, unlockAuthSession } from '@immich/sdk';
  import { BasicModal, Icon, LoadingSpinner, PinInput } from '@immich/ui';
  import { mdiAlertCircleOutline, mdiLockOutline, mdiLockSmart } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  // In-place version of /auth/pin-prompt, used by withElevationRetry so the refused action can be retried without
  // leaving the page. Closes with true once the session is elevated; any other close is a cancel.
  type Props = {
    onClose: (elevated?: true) => void;
  };

  let { onClose }: Props = $props();

  // 'loading' until the PIN status arrives; 'error' if it cannot be read. Neither offers a way to elevate, so a failed
  // status call leaves only Cancel (fail closed).
  let status = $state<'loading' | 'error' | 'pin' | 'create'>('loading');
  let isBadPinCode = $state(false);
  let pinCode = $state('');

  onMount(async () => {
    // Only reached after the server refused, so this reveals nothing the refusal did not. A user can hold locks
    // without a PIN (after a PIN reset); like the PIN page, let them create one first.
    try {
      const { pinCode: isPinCodeSet } = await getAuthStatus();
      status = isPinCodeSet ? 'pin' : 'create';
    } catch (error) {
      console.error('[PinPromptModal] unable to read the PIN status', error);
      status = 'error';
    }
  });

  const handleUnlockSession = async (code: string) => {
    try {
      await unlockAuthSession({ sessionUnlockDto: { pinCode: code } });
    } catch (error) {
      handleError(error, $t('wrong_pin_code'));
      isBadPinCode = true;
      pinCode = '';
      return;
    }

    lockManager.onElevationAcquired();
    // Bring the elevation flag and lock sets up to date, as a page load after /auth/pin-prompt would.
    lockManager.refresh().catch((error: unknown) => console.error('[PinPromptModal] lock refresh failed', error));
    onClose(true);
  };
</script>

<BasicModal title={$t('pin_verification')} icon={mdiLockOutline} closeText={$t('cancel')} onClose={() => onClose()}>
  <div class="flex flex-col items-center gap-6 py-2">
    {#if status === 'loading'}
      <LoadingSpinner size="large" />
    {:else if status === 'error'}
      <div class="text-danger">
        <Icon icon={mdiAlertCircleOutline} size="48" />
      </div>
      <p class="text-center text-sm text-danger" role="alert">{$t('errors.something_went_wrong')}</p>
    {:else if status === 'pin'}
      <div class:text-danger={isBadPinCode} class:text-primary={!isBadPinCode}>
        <Icon icon={mdiLockOutline} size="48" />
      </div>
      <p class="text-center text-sm" style="text-wrap: pretty;">{$t('enter_your_pin_code_subtitle')}</p>
      <PinInput password autofocus bind:value={pinCode} onComplete={handleUnlockSession} />
    {:else}
      <div class="text-primary">
        <Icon icon={mdiLockSmart} size="48" />
      </div>
      <p class="text-center text-sm" style="text-wrap: pretty;">{$t('new_pin_code_subtitle')}</p>
      <PinCodeCreateForm showLabel={false} onCreated={() => (status = 'pin')} />
    {/if}
  </div>
</BasicModal>
