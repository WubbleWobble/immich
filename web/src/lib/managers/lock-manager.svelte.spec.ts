import { defaults, getAuthStatus, getLocks } from '@immich/sdk';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { lockManager } from '$lib/managers/lock-manager.svelte';
import { purgeMediaRequests } from '$lib/utils/sw-messaging';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getAuthStatus: vi.fn(),
  getLocks: vi.fn(),
  lockAlbum: vi.fn(),
  unlockAlbum: vi.fn(),
  lockAlbumContainer: vi.fn(),
  unlockAlbumContainer: vi.fn(),
  lockAuthSession: vi.fn(),
}));

vi.mock('$lib/utils/sw-messaging', () => ({
  trackImageRequest: vi.fn(() => ({ settle: vi.fn(), cancel: vi.fn() })),
  purgeMediaRequests: vi.fn(),
}));

const REVEALED_ALBUMS_HEADER = 'x-immich-revealed-albums';
const REVEALED_CONTAINERS_HEADER = 'x-immich-revealed-containers';

const authStatus = (isElevated: boolean) =>
  vi.mocked(getAuthStatus).mockResolvedValue({ isElevated, pinCode: true, password: true });

const revealSome = async () => {
  authStatus(true);
  vi.mocked(getLocks).mockResolvedValue({ lockedAlbumIds: ['album-1'], lockedContainerIds: ['folder-1'] });
  await lockManager.refresh();
  lockManager.revealAlbum('album-1', true);
  lockManager.revealContainer('folder-1', true);
  expect(defaults.headers?.[REVEALED_ALBUMS_HEADER]).toBe('album-1');
  expect(defaults.headers?.[REVEALED_CONTAINERS_HEADER]).toBe('folder-1');
};

const expectNothingRevealed = () => {
  expect(lockManager.revealedAlbumIds.size).toBe(0);
  expect(lockManager.revealedContainerIds.size).toBe(0);
  expect(defaults.headers?.[REVEALED_ALBUMS_HEADER]).toBeUndefined();
  expect(defaults.headers?.[REVEALED_CONTAINERS_HEADER]).toBeUndefined();
};

describe('LockManager', () => {
  beforeEach(() => {
    lockManager.resetLocal();
    vi.clearAllMocks();
  });

  it.each(['AuthLogout', 'SessionDelete', 'SessionLocked'] as const)('forgets all lock state on %s', async (event) => {
    await revealSome();

    eventManager.emit(event);

    expectNothingRevealed();
    expect(lockManager.isElevated).toBe(false);
    expect(lockManager.hasPinCode).toBe(false);
    expect(lockManager.lockedAlbumIds.size).toBe(0);
    expect(lockManager.lockedContainerIds.size).toBe(0);
  });

  it('starts with nothing revealed when elevation is re-acquired through the PIN prompt', async () => {
    await revealSome();

    lockManager.onElevationAcquired();

    expectNothingRevealed();
  });

  it('starts with nothing revealed when refresh observes elevation being re-acquired', async () => {
    await revealSome();
    // elevation lapsed and came back without the client seeing the gap
    lockManager.isElevated = false;

    await lockManager.refresh();

    expectNothingRevealed();
  });

  it('keeps reveals across refreshes while elevation holds', async () => {
    await revealSome();

    await lockManager.refresh();

    expect([...lockManager.revealedAlbumIds]).toEqual(['album-1']);
    expect(defaults.headers?.[REVEALED_ALBUMS_HEADER]).toBe('album-1');
  });

  describe('service worker purge at authorization boundaries (R50)', () => {
    it.each(['AuthLogout', 'SessionDelete', 'SessionLocked'] as const)('purges on %s', (event) => {
      vi.mocked(purgeMediaRequests).mockClear();
      eventManager.emit(event);
      expect(purgeMediaRequests).toHaveBeenCalled();
    });

    it('purges when the elevated session is ended', async () => {
      await revealSome();
      vi.mocked(purgeMediaRequests).mockClear();
      await lockManager.endElevatedSession();
      expect(purgeMediaRequests).toHaveBeenCalled();
    });

    it('purges when refresh observes that elevation lapsed', async () => {
      await revealSome();
      vi.mocked(purgeMediaRequests).mockClear();
      authStatus(false);
      await lockManager.refresh();
      expect(purgeMediaRequests).toHaveBeenCalled();
    });

    it.each([
      ['lockAlbum', (id: string) => lockManager.lockAlbum(id)],
      ['unlockAlbum', (id: string) => lockManager.unlockAlbum(id)],
      ['lockContainer', (id: string) => lockManager.lockContainer(id)],
      ['unlockContainer', (id: string) => lockManager.unlockContainer(id)],
    ])('purges on %s', async (_name, action) => {
      vi.mocked(purgeMediaRequests).mockClear();
      await action('album-or-folder');
      expect(purgeMediaRequests).toHaveBeenCalled();
    });

    it('purges on every reveal-set change', async () => {
      await revealSome();
      for (const change of [
        () => lockManager.revealAlbum('album-1', false),
        () => lockManager.revealContainer('folder-1', false),
        () => lockManager.revealAlbum('album-2', true),
        () => lockManager.onElevationAcquired(),
      ]) {
        vi.mocked(purgeMediaRequests).mockClear();
        change();
        expect(purgeMediaRequests).toHaveBeenCalled();
      }
    });
  });
});
