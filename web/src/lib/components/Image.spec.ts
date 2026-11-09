import { fireEvent, render } from '@testing-library/svelte';
import Image from '$lib/components/Image.svelte';
import { trackImageRequest } from '$lib/utils/sw-messaging';

const request = { settle: vi.fn(), cancel: vi.fn() };
vi.mock('$lib/utils/sw-messaging', () => ({
  trackImageRequest: vi.fn(() => request),
}));

describe('Image component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders an img element when src is provided', () => {
    const { baseElement } = render(Image, { src: '/test.jpg', alt: 'test' });
    const img = baseElement.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('/test.jpg');
  });

  it('does not render an img element when src is undefined', () => {
    const { baseElement } = render(Image, { src: undefined });
    const img = baseElement.querySelector('img');
    expect(img).toBeNull();
  });

  it('calls onStart when src is set', () => {
    const onStart = vi.fn();
    render(Image, { src: '/test.jpg', onStart });
    expect(onStart).toHaveBeenCalledOnce();
  });

  it('calls onLoad when image loads', async () => {
    const onLoad = vi.fn();
    const { baseElement } = render(Image, { src: '/test.jpg', onLoad });
    const img = baseElement.querySelector('img')!;
    await fireEvent.load(img);
    expect(onLoad).toHaveBeenCalledOnce();
  });

  it('calls onError when image fails to load', async () => {
    const onError = vi.fn();
    const { baseElement } = render(Image, { src: '/test.jpg', onError });
    const img = baseElement.querySelector('img')!;
    await fireEvent.error(img);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(onError.mock.calls[0][0].message).toBe('Failed to load image: /test.jpg');
  });

  it('tracks its request and cancels it on unmount', () => {
    const { unmount } = render(Image, { src: '/test.jpg' });
    expect(trackImageRequest).toHaveBeenCalledExactlyOnceWith('/test.jpg');
    expect(request.cancel).not.toHaveBeenCalled();
    unmount();
    expect(request.cancel).toHaveBeenCalledOnce();
  });

  it('settles its request on load and on error', async () => {
    const { baseElement } = render(Image, { src: '/test.jpg' });
    const img = baseElement.querySelector('img')!;
    await fireEvent.load(img);
    expect(request.settle).toHaveBeenCalledOnce();
    await fireEvent.error(img);
    expect(request.settle).toHaveBeenCalledTimes(2);
  });

  it('does not call onLoad after unmount', async () => {
    const onLoad = vi.fn();
    const { baseElement, unmount } = render(Image, { src: '/test.jpg', onLoad });
    const img = baseElement.querySelector('img')!;
    unmount();
    await fireEvent.load(img);
    expect(onLoad).not.toHaveBeenCalled();
  });

  it('does not call onError after unmount', async () => {
    const onError = vi.fn();
    const { baseElement, unmount } = render(Image, { src: '/test.jpg', onError });
    const img = baseElement.querySelector('img')!;
    unmount();
    await fireEvent.error(img);
    expect(onError).not.toHaveBeenCalled();
  });

  it('passes through additional HTML attributes', () => {
    const { baseElement } = render(Image, {
      src: '/test.jpg',
      alt: 'test alt',
      class: 'my-class',
      draggable: false,
    });
    const img = baseElement.querySelector('img')!;
    expect(img.getAttribute('alt')).toBe('test alt');
    expect(img.getAttribute('draggable')).toBe('false');
  });
});
