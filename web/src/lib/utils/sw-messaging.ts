import { ServiceWorkerMessenger } from './sw-messenger';

const hasServiceWorker = globalThis.isSecureContext && 'serviceWorker' in navigator;
const messenger = hasServiceWorker ? new ServiceWorkerMessenger(navigator.serviceWorker) : undefined;

export type ImageRequest = {
  /** The image loaded or failed: this consumer's request is over and its cancel becomes a no-op. */
  settle: () => void;
  /** The consumer went away before its image settled. */
  cancel: () => void;
};

/**
 * Page-side reference counting for service-worker cancels. One tab can hold several consumers of one URL (a stale
 * component unmounting after a fresh one mounted). A consumer whose image already settled must not cancel a later
 * consumer's request, and a cancel must not take a request away from another live consumer. So the worker is told to
 * cancel only when the LAST unsettled consumer of the URL in this tab cancels; the worker then releases one reference
 * of this tab on each in-flight request for the URL and aborts a request only when no consumer is left.
 */
export class ImageRequestLedger {
  readonly #unsettled = new Map<string, Set<symbol>>();

  constructor(private readonly sendCancel: (url: string) => void) {}

  track(url: string): ImageRequest {
    const token = Symbol(url);
    let tokens = this.#unsettled.get(url);
    if (!tokens) {
      tokens = new Set();
      this.#unsettled.set(url, tokens);
    }
    tokens.add(token);

    /** Close this consumer; true when it was the last unsettled consumer of the URL. */
    const close = () => {
      const current = this.#unsettled.get(url);
      if (!current?.delete(token)) {
        return false;
      }
      if (current.size > 0) {
        return false;
      }
      this.#unsettled.delete(url);
      return true;
    };

    return {
      settle: () => void close(),
      cancel: () => {
        if (close()) {
          this.sendCancel(url);
        }
      },
    };
  }
}

const ledger = new ImageRequestLedger((url) => messenger?.send('cancel', { url }));

/** Register an image request of this page (one per consumer); settle it on load/error, cancel it on unmount. */
export function trackImageRequest(url: string): ImageRequest {
  return ledger.track(url);
}

/**
 * Fork (R50): an authorization boundary was crossed (logout, session deleted or locked, end of elevation, lock/unlock,
 * reveal-set change). The service worker - shared by every tab of this origin - aborts and forgets every pending media
 * request, so nothing fetched under the old authorization is handed out afterwards.
 */
export function purgeMediaRequests() {
  messenger?.send('purge', {});
}
