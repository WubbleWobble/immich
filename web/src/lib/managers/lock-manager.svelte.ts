import {
  defaults,
  getAuthStatus,
  getLocks,
  lockAlbum,
  lockAlbumContainer,
  lockAuthSession,
  unlockAlbum,
  unlockAlbumContainer,
} from '@immich/sdk';
import { SvelteSet } from 'svelte/reactivity';

const REVEALED_ALBUMS_HEADER = 'x-immich-revealed-albums';
const REVEALED_CONTAINERS_HEADER = 'x-immich-revealed-containers';

/**
 * Client-side state for per-user locked albums/folders (spec §8):
 * - which items the user has locked (mirrors GET /locks; only populated while elevated)
 * - which locked items are revealed for THIS session (in-memory only; closing the tab
 *   re-hides everything, by design)
 * - reveal-set request headers, injected on every SDK call while non-empty; the server
 *   ignores them unless the session is elevated
 */
class LockManager {
  isElevated = $state(false);
  hasPinCode = $state(false);
  lockedAlbumIds = new SvelteSet<string>();
  lockedContainerIds = new SvelteSet<string>();
  revealedAlbumIds = new SvelteSet<string>();
  revealedContainerIds = new SvelteSet<string>();

  /** Refresh elevation status; while elevated, also refresh the lock sets. */
  async refresh() {
    const { isElevated, pinCode } = await getAuthStatus();
    this.isElevated = isElevated;
    this.hasPinCode = pinCode;
    if (isElevated) {
      const { lockedAlbumIds, lockedContainerIds } = await getLocks();
      this.lockedAlbumIds.clear();
      this.lockedContainerIds.clear();
      for (const id of lockedAlbumIds) {
        this.lockedAlbumIds.add(id);
      }
      for (const id of lockedContainerIds) {
        this.lockedContainerIds.add(id);
      }
    } else if (this.revealedAlbumIds.size > 0 || this.revealedContainerIds.size > 0) {
      this.clearReveals();
    }
  }

  revealAlbum(id: string, revealed: boolean) {
    if (revealed) {
      this.revealedAlbumIds.add(id);
    } else {
      this.revealedAlbumIds.delete(id);
    }
    this.syncHeaders();
  }

  revealContainer(id: string, revealed: boolean) {
    if (revealed) {
      this.revealedContainerIds.add(id);
    } else {
      this.revealedContainerIds.delete(id);
    }
    this.syncHeaders();
  }

  async lockAlbum(id: string) {
    await lockAlbum({ id });
    this.lockedAlbumIds.add(id);
    // Auto-reveal what was just locked so the user does not lose the page they are on.
    this.revealAlbum(id, true);
  }

  async unlockAlbum(id: string) {
    await unlockAlbum({ id });
    this.lockedAlbumIds.delete(id);
    this.revealAlbum(id, false);
  }

  async lockContainer(id: string) {
    await lockAlbumContainer({ id });
    this.lockedContainerIds.add(id);
    this.revealContainer(id, true);
  }

  async unlockContainer(id: string) {
    await unlockAlbumContainer({ id });
    this.lockedContainerIds.delete(id);
    this.revealContainer(id, false);
  }

  /** Drop server-side elevation and every client-side reveal. */
  async endElevatedSession() {
    await lockAuthSession();
    this.isElevated = false;
    this.lockedAlbumIds.clear();
    this.lockedContainerIds.clear();
    this.clearReveals();
  }

  private clearReveals() {
    this.revealedAlbumIds.clear();
    this.revealedContainerIds.clear();
    this.syncHeaders();
  }

  private syncHeaders() {
    defaults.headers = defaults.headers ?? {};
    if (this.revealedAlbumIds.size > 0) {
      defaults.headers[REVEALED_ALBUMS_HEADER] = [...this.revealedAlbumIds].join(',');
    } else {
      delete defaults.headers[REVEALED_ALBUMS_HEADER];
    }
    if (this.revealedContainerIds.size > 0) {
      defaults.headers[REVEALED_CONTAINERS_HEADER] = [...this.revealedContainerIds].join(',');
    } else {
      delete defaults.headers[REVEALED_CONTAINERS_HEADER];
    }
  }
}

export const lockManager = new LockManager();
