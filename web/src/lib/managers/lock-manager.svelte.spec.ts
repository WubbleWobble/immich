import { defaults, getAuthStatus, getLocks } from '@immich/sdk';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { lockManager } from '$lib/managers/lock-manager.svelte';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getAuthStatus: vi.fn(),
  getLocks: vi.fn(),
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
});
