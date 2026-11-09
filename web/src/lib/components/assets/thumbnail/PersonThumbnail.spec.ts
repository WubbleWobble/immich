import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { Mock } from 'vitest';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import PersonThumbnail from '$lib/components/assets/thumbnail/PersonThumbnail.svelte';
import { lockManager } from '$lib/managers/lock-manager.svelte';

// T6: a portrait whose source face sits in an own locked album is served to an elevated owner only with that lock
// revealed. Native <img> requests never carry the SDK's reveal headers, so portraits load through the SDK.

const REVEALED_ALBUMS = 'x-immich-revealed-albums';
const person = { id: 'person-1', updatedAt: '2026-01-01T00:00:00.000Z' };

const portrait = () => new Response(new Blob(['jpeg'], { type: 'image/jpeg' }), { status: 200 });
const withheld = () => Response.json({ message: 'Not found' }, { status: 404 });

let fetchMock: Mock<typeof fetch>;
let objectUrls = 0;

const requestAt = (index: number) => {
  const [url, init = {}] = fetchMock.mock.calls[index] as [string, RequestInit?];
  return { url, headers: new Headers(init.headers), signal: init.signal };
};

const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await tick();
    await Promise.resolve();
  }
};

const image = () => document.querySelector('img');

describe('PersonThumbnail', () => {
  beforeEach(() => {
    lockManager.resetLocal();
    objectUrls = 0;
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    URL.createObjectURL = vi.fn(() => `blob:portrait-${++objectUrls}`);
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    // Unmount first: resetting the lock state would otherwise refetch through the real fetch.
    cleanup();
    lockManager.resetLocal();
    vi.unstubAllGlobals();
  });

  it('loads the portrait for a user without locks', async () => {
    fetchMock.mockResolvedValue(portrait());
    render(PersonThumbnail, { person, altText: 'Alice', widthStyle: '100%' });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = requestAt(0);
    expect(request.url).toContain('/people/person-1/thumbnail');
    expect(request.headers.has(REVEALED_ALBUMS)).toBe(false);
    expect(image()).toHaveAttribute('src', 'blob:portrait-1');
  });

  it('refetches with the reveal headers when the reveal set changes, and shows the portrait', async () => {
    lockManager.isElevated = true;
    fetchMock.mockResolvedValueOnce(withheld()).mockResolvedValueOnce(portrait());
    render(PersonThumbnail, { person, altText: 'Alice', widthStyle: '100%' });
    await flush();

    // elevated without a reveal: withheld
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestAt(0).headers.has(REVEALED_ALBUMS)).toBe(false);
    expect(image()).toBeNull();
    expect(document.querySelector('[data-broken-asset]')).not.toBeNull();

    lockManager.revealAlbum('locked-album', true);
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestAt(1).headers.get(REVEALED_ALBUMS)).toBe('locked-album');
    expect(image()).toHaveAttribute('src', 'blob:portrait-1');
    expect(document.querySelector('[data-broken-asset]')).toBeNull();
  });

  it('refetches without the reveal when it is cleared, revokes the revealed portrait and shows it withheld', async () => {
    lockManager.isElevated = true;
    lockManager.revealAlbum('locked-album', true);
    fetchMock.mockResolvedValueOnce(portrait()).mockResolvedValueOnce(withheld());
    render(PersonThumbnail, { person, altText: 'Alice', widthStyle: '100%' });
    await flush();
    expect(requestAt(0).headers.get(REVEALED_ALBUMS)).toBe('locked-album');
    expect(image()).toHaveAttribute('src', 'blob:portrait-1');

    lockManager.revealAlbum('locked-album', false);
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestAt(1).headers.has(REVEALED_ALBUMS)).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:portrait-1');
    expect(image()).toBeNull();
    expect(document.querySelector('[data-broken-asset]')).not.toBeNull();
  });

  it('refetches when elevation changes', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(portrait()));
    render(PersonThumbnail, { person, altText: 'Alice', widthStyle: '100%' });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    lockManager.isElevated = true;
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:portrait-1');
    expect(image()).toHaveAttribute('src', 'blob:portrait-2');
  });

  it('does not refetch when nothing relevant changed', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(portrait()));
    render(PersonThumbnail, { person, altText: 'Alice', widthStyle: '100%' });
    await flush();
    lockManager.revealAlbum('locked-album', false);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refetches when the cache key changes', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(portrait()));
    const { rerender } = render(PersonThumbnail, { person, altText: 'Alice', widthStyle: '100%' });
    await flush();
    await rerender({ person, cacheKey: 'new-feature-photo', altText: 'Alice', widthStyle: '100%' });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(image()).toHaveAttribute('src', 'blob:portrait-2');
  });

  it('aborts an in-flight request on unmount and never creates its object URL', async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    const { unmount } = render(PersonThumbnail, { person, altText: 'Alice', widthStyle: '100%' });
    await flush();
    const { signal } = requestAt(0);
    expect(signal?.aborted).toBe(false);

    unmount();
    expect(signal?.aborted).toBe(true);
    resolve(portrait());
    await flush();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('aborts the superseded request when the reveal set changes mid-flight', async () => {
    let resolveFirst!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (resolveFirst = r))).mockResolvedValueOnce(portrait());
    lockManager.isElevated = true;
    render(PersonThumbnail, { person, altText: 'Alice', widthStyle: '100%' });
    await flush();

    lockManager.revealAlbum('locked-album', true);
    await flush();
    expect(requestAt(0).signal?.aborted).toBe(true);
    resolveFirst(portrait());
    await flush();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(image()).toHaveAttribute('src', 'blob:portrait-1');
  });

  it('revokes its object URL on unmount', async () => {
    fetchMock.mockResolvedValue(portrait());
    const { unmount } = render(PersonThumbnail, { person, altText: 'Alice', widthStyle: '100%' });
    await flush();
    expect(image()).toHaveAttribute('src', 'blob:portrait-1');

    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:portrait-1');
  });

  it('waits until a lazy portrait is near the viewport', async () => {
    const observer = getIntersectionObserverMock();
    vi.stubGlobal('IntersectionObserver', observer);
    fetchMock.mockResolvedValue(portrait());
    render(PersonThumbnail, { person, altText: 'Alice', widthStyle: '100%', preload: false });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(observer).toHaveBeenCalledTimes(1);

    const [callback] = observer.mock.calls[0] as unknown as [IntersectionObserverCallback];
    callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(image()).toHaveAttribute('src', 'blob:portrait-1');
  });
});
