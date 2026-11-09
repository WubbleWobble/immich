import { cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { Mock } from 'vitest';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { lockManager } from '$lib/managers/lock-manager.svelte';
import { renderWithTooltips } from '$tests/helpers';
import { personFactory } from '@test-data/factories/person-factory';
import PeopleCard from './PeopleCard.svelte';

vi.mock(import('$lib/managers/feature-flags-manager.svelte'), function () {
  return {
    featureFlagsManager: { init: vi.fn(), loadFeatureFlags: vi.fn(), value: {} } as never,
  };
});

// T6: the People page portrait must be requested with the session's reveal headers, not as a native <img> URL.
describe('PeopleCard portrait', () => {
  let fetchMock: Mock<typeof fetch>;

  beforeEach(() => {
    lockManager.resetLocal();
    fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Blob(['jpeg'], { type: 'image/jpeg' })));
    vi.stubGlobal('fetch', fetchMock);
    URL.createObjectURL = vi.fn(() => 'blob:portrait');
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    // Unmount first: resetting the lock state would otherwise refetch through the real fetch.
    cleanup();
    lockManager.resetLocal();
    vi.unstubAllGlobals();
  });

  it('requests a revealed portrait with the reveal headers and shows it', async () => {
    lockManager.isElevated = true;
    lockManager.revealAlbum('locked-album', true);
    const person = personFactory.build({ id: 'person-1' });

    const observer = getIntersectionObserverMock();
    vi.stubGlobal('IntersectionObserver', observer);
    const flush = async () => {
      for (let i = 0; i < 5; i++) {
        await tick();
        await Promise.resolve();
      }
    };

    const { container } = renderWithTooltips(PeopleCard, { person, onMergePeople: vi.fn() });
    await flush();
    // The card's portrait is lazy: it loads once it nears the viewport.
    const [callback] = observer.mock.calls[0] as unknown as [IntersectionObserverCallback];
    callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init = {}] = fetchMock.mock.calls[0] as [string, RequestInit?];
    expect(url).toContain('/people/person-1/thumbnail');
    expect(new Headers(init.headers).get('x-immich-revealed-albums')).toBe('locked-album');
    expect(container.querySelector('img')).toHaveAttribute('src', 'blob:portrait');
  });
});
