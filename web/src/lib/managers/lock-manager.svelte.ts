import {
  AlbumUserRole,
  createAlbum,
  defaults,
  getAlbumInfo,
  getAuthStatus,
  getLocks,
  lockAlbum,
  lockAlbumContainer,
  lockAuthSession,
  unlockAlbum,
  unlockAlbumContainer,
} from '@immich/sdk';
import { SvelteSet } from 'svelte/reactivity';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { userInteraction } from '$lib/stores/user.svelte';
import { purgeMediaRequests } from '$lib/utils/sw-messaging';

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

  constructor() {
    // Spec §8.2: lock state is per session and per user. Logging out, losing the session or locking it must not carry
    // reveals (and their request headers) over to the next user of a shared device.
    eventManager.on({
      AuthLogout: () => this.resetLocal(),
      SessionDelete: () => this.resetLocal(),
      SessionLocked: () => this.resetLocal(),
    });
  }

  /**
   * Changes whenever elevation, the lock sets or the reveal set change. Media fetched by the page itself (not through
   * the service worker) and judged under the previous state must be refetched then - e.g. person portraits (T6).
   */
  get visibilityKey() {
    const sorted = (ids: Iterable<string>) => [...ids].sort();
    return JSON.stringify([
      this.isElevated,
      sorted(this.lockedAlbumIds),
      sorted(this.lockedContainerIds),
      sorted(this.revealedAlbumIds),
      sorted(this.revealedContainerIds),
    ]);
  }

  /** Refresh elevation status; while elevated, also refresh the lock sets. */
  async refresh() {
    const wasElevated = this.isElevated;
    const { isElevated, pinCode } = await getAuthStatus();
    this.isElevated = isElevated;
    this.hasPinCode = pinCode;
    if (wasElevated && !isElevated) {
      // Elevation lapsed: media fetched while elevated must not be handed out again (R50).
      purgeMediaRequests();
    }
    if (isElevated && !wasElevated) {
      // Reveal defaults to off each time elevation is (re)acquired.
      this.clearReveals();
    }
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
    purgeMediaRequests();
    this.lockedAlbumIds.add(id);
    // Auto-reveal what was just locked so the user does not lose the page they are on.
    this.revealAlbum(id, true);
    this.invalidateRecentAlbums();
  }

  async unlockAlbum(id: string) {
    await unlockAlbum({ id });
    purgeMediaRequests();
    this.lockedAlbumIds.delete(id);
    this.revealAlbum(id, false);
    this.invalidateRecentAlbums();
  }

  async lockContainer(id: string) {
    await lockAlbumContainer({ id });
    purgeMediaRequests();
    this.lockedContainerIds.add(id);
    this.revealContainer(id, true);
    this.invalidateRecentAlbums();
  }

  async unlockContainer(id: string) {
    await unlockAlbumContainer({ id });
    purgeMediaRequests();
    this.lockedContainerIds.delete(id);
    this.revealContainer(id, false);
    this.invalidateRecentAlbums();
  }

  /**
   * The user's built-in "Locked Folder" album (same heuristic as the server migration: a
   * locked album named 'Locked Folder' owned by the user), created and locked on demand.
   * Powers the one-click "move to locked folder" flow the spec preserves.
   */
  async ensureBuiltInLockedAlbum(userId: string): Promise<string> {
    for (const id of this.lockedAlbumIds) {
      try {
        const album = await getAlbumInfo({ id });
        const ownerId = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)?.user.id;
        if (album.albumName === 'Locked Folder' && ownerId === userId) {
          return id;
        }
      } catch {
        // Stale lock; keep looking.
      }
    }
    const album = await createAlbum({ createAlbumDto: { albumName: 'Locked Folder' } });
    await this.lockAlbum(album.id);
    return album.id;
  }

  /** Elevation was just (re)acquired (PIN prompt): reveal starts off again. */
  onElevationAcquired() {
    this.clearReveals();
  }

  /** Forget all client-side lock state without a server call (logout, session deleted or locked elsewhere). */
  resetLocal() {
    this.isElevated = false;
    this.hasPinCode = false;
    this.lockedAlbumIds.clear();
    this.lockedContainerIds.clear();
    this.clearReveals();
    this.invalidateRecentAlbums();
    purgeMediaRequests();
  }

  /** Drop server-side elevation and every client-side reveal. */
  async endElevatedSession() {
    await lockAuthSession();
    this.isElevated = false;
    this.lockedAlbumIds.clear();
    this.lockedContainerIds.clear();
    this.clearReveals();
    this.invalidateRecentAlbums();
    purgeMediaRequests();
  }

  /** The sidebar's recent-albums cache may hold an album that just became hidden (or visible): refetch it. */
  private invalidateRecentAlbums() {
    userInteraction.recentAlbums = undefined;
  }

  private clearReveals() {
    this.revealedAlbumIds.clear();
    this.revealedContainerIds.clear();
    this.syncHeaders();
  }

  private syncHeaders() {
    defaults.headers ??= {};
    const before = [defaults.headers[REVEALED_ALBUMS_HEADER], defaults.headers[REVEALED_CONTAINERS_HEADER]];
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
    if (
      before[0] !== defaults.headers[REVEALED_ALBUMS_HEADER] ||
      before[1] !== defaults.headers[REVEALED_CONTAINERS_HEADER]
    ) {
      // The reveal set changed (R50).
      purgeMediaRequests();
    }
  }
}

export const lockManager = new LockManager();
