import { trackImageRequest } from '$lib/utils/sw-messaging';

export function loadImage(src: string, onLoad: () => void, onError: () => void, onStart?: () => void) {
  let destroyed = false;

  const request = trackImageRequest(src);
  const handleLoad = () => {
    request.settle();
    return !destroyed && onLoad();
  };
  const handleError = () => {
    request.settle();
    return !destroyed && onError();
  };

  const img = document.createElement('img');
  img.addEventListener('load', handleLoad);
  img.addEventListener('error', handleError);

  onStart?.();
  img.src = src;

  return () => {
    destroyed = true;
    img.removeEventListener('load', handleLoad);
    img.removeEventListener('error', handleError);
    request.cancel();
    img.remove();
  };
}

export type LoadImageFunction = typeof loadImage;
