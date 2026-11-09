import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import RecentAlbums from '$lib/components/shared-components/side-bar/RecentAlbums.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { lockManager } from '$lib/managers/lock-manager.svelte';
import { userInteraction } from '$lib/stores/user.svelte';
import { albumFactory } from '@test-data/factories/album-factory';

describe('RecentAlbums component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userInteraction.recentAlbums = undefined;
  });

  it('sorts albums by most recently updated', async () => {
    const albums = [
      albumFactory.build({ updatedAt: '2024-01-01T00:00:00Z' }),
      albumFactory.build({ updatedAt: '2024-01-09T00:00:01Z' }),
      albumFactory.build({ updatedAt: '2024-01-10T00:00:00Z' }),
      albumFactory.build({ updatedAt: '2024-01-09T00:00:00Z' }),
    ];

    sdkMock.getAllAlbums.mockResolvedValueOnce([...albums]);
    sdkMock.getAllAlbumContainers.mockResolvedValueOnce([]);
    render(RecentAlbums);

    expect(sdkMock.getAllAlbums).toHaveBeenCalledOnce();

    // wtf
    await tick();
    await tick();

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(3);
    expect(links[0]).toHaveAttribute('href', `/albums/${albums[2].id}`);
    expect(links[1]).toHaveAttribute('href', `/albums/${albums[1].id}`);
    expect(links[2]).toHaveAttribute('href', `/albums/${albums[3].id}`);
  });

  it('lists items shared from inside a private folder as root items (T3)', async () => {
    const sharedAlbum = albumFactory.build({ containerId: 'private-folder', updatedAt: '2024-01-03T00:00:00Z' });
    const nestedAlbum = albumFactory.build({ containerId: 'shared-child', updatedAt: '2024-01-04T00:00:00Z' });
    const sharedChild = {
      id: 'shared-child',
      name: 'Shared child',
      parentId: 'private-folder',
      ownerId: 'someone-else',
      updatedAt: '2024-01-02T00:00:00Z',
    };
    sdkMock.getAllAlbums.mockResolvedValueOnce([sharedAlbum, nestedAlbum]);
    sdkMock.getAllAlbumContainers.mockResolvedValueOnce([sharedChild as never]);
    render(RecentAlbums);
    await tick();
    await tick();

    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(hrefs).toHaveLength(2);
    expect(hrefs[0]).toBe(`/albums/${sharedAlbum.id}`);
    expect(hrefs[1]).toContain('shared-child');
  });

  it('refreshes whenever the recent-albums cache is invalidated', async () => {
    const lockedLater = albumFactory.build({ updatedAt: '2024-01-10T00:00:00Z' });
    const other = albumFactory.build({ updatedAt: '2024-01-01T00:00:00Z' });
    sdkMock.getAllAlbums.mockResolvedValue([lockedLater, other]);
    sdkMock.getAllAlbumContainers.mockResolvedValue([]);
    render(RecentAlbums);
    await tick();
    await tick();
    expect(screen.getAllByRole('link')).toHaveLength(2);
    expect(sdkMock.getAllAlbums).toHaveBeenCalledTimes(1);

    // locking an album invalidates the cache, so the just-locked (now hidden) album drops out of the sidebar
    sdkMock.lockAlbum.mockResolvedValue(undefined as never);
    sdkMock.getAllAlbums.mockResolvedValue([other]);
    await lockManager.lockAlbum(lockedLater.id);
    await tick();
    await tick();
    await tick();
    expect(sdkMock.getAllAlbums).toHaveBeenCalledTimes(2);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', `/albums/${other.id}`);

    // any other invalidation (album events, logout, end of elevation) refreshes too
    eventManager.emit('AuthLogout');
    await tick();
    await tick();
    expect(sdkMock.getAllAlbums).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['unlockAlbum', () => lockManager.unlockAlbum('album-id')],
    ['lockContainer', () => lockManager.lockContainer('folder-id')],
    ['unlockContainer', () => lockManager.unlockContainer('folder-id')],
    ['endElevatedSession', () => lockManager.endElevatedSession()],
    ['resetLocal', () => Promise.resolve(lockManager.resetLocal())],
  ])('%s invalidates the recent-albums cache', async (_, action) => {
    sdkMock.unlockAlbum.mockResolvedValue(undefined as never);
    sdkMock.lockAlbumContainer.mockResolvedValue(undefined as never);
    sdkMock.unlockAlbumContainer.mockResolvedValue(undefined as never);
    sdkMock.lockAuthSession.mockResolvedValue(undefined as never);
    userInteraction.recentAlbums = [albumFactory.build()];

    await action();

    expect(userInteraction.recentAlbums).toBeUndefined();
  });
});
