<script lang="ts">
  import PinCodeCreateForm from '$lib/components/user-settings-page/PinCodeCreateForm.svelte';
  import { lockManager } from '$lib/managers/lock-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { getAuthStatus, unlockAuthSession } from '@immich/sdk';
  import { BasicModal, Icon, PinInput } from '@immich/ui';
  import { mdiLockOutline, mdiLockSmart } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  // In-place version of /auth/pin-prompt, used by withElevationRetry so the refused action can be retried without
  // leaving the page. Closes with true once the session is elevated; any other close is a cancel.
  type Props = {
    onClose: (elevated?: true) => void;
  };

  let { onClose }: Props = $props();

  let hasPinCode = $state(true);
  let isBadPinCode = $state(false);
  let pinCode = $state('');

  onMount(async () => {
    // Only reached after the server refused, so this reveals nothing the refusal did not. A user can hold locks
    // without a PIN (after a PIN reset); like the PIN page, let them create one first.
    try {
      const { pinCode: isPinCodeSet } = await getAuthStatus();
      hasPinCode = isPinCodeSet;
    } catch {
      // Keep the PIN input; unlocking reports its own errors.
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
    {#if hasPinCode}
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
      <PinCodeCreateForm showLabel={false} onCreated={() => (hasPinCode = true)} />
    {/if}
  </div>
</BasicModal>
