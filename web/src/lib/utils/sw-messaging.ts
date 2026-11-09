import { ServiceWorkerMessenger } from './sw-messenger';

const hasServiceWorker = globalThis.isSecureContext && 'serviceWorker' in navigator;
const messenger = hasServiceWorker ? new ServiceWorkerMessenger(navigator.serviceWorker) : undefined;

export function cancelImageUrl(url: string | undefined | null) {
  if (!url || !messenger) {
    return;
  }
  messenger.send('cancel', { url });
}

/**
 * Fork (R50): an authorization boundary was crossed (logout, session deleted or locked, end of elevation, lock/unlock,
 * reveal-set change). The service worker - shared by every tab of this origin - aborts and forgets every pending media
 * request, so nothing fetched under the old authorization is handed out afterwards.
 */
export function purgeMediaRequests() {
  messenger?.send('purge', {});
}
