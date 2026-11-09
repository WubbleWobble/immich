import type { AssetResponseDto } from '@immich/sdk';
import { PreloadManager } from '$lib/components/asset-viewer/PreloadManager.svelte';

/** Every loadImage call, with its destroy (the cancel of that consumer's ledger token). */
const loads: { src: string; destroy: ReturnType<typeof vi.fn> }[] = [];

vi.mock('$lib/actions/image-loader.svelte', () => ({
  loadImage: vi.fn((src: string) => {
    const destroy = vi.fn();
    loads.push({ src, destroy });
    return destroy;
  }),
}));

vi.mock('$lib/utils', () => ({
  getAssetUrls: (asset: AssetResponseDto) => ({
    thumbnail: `/${asset.id}/thumbnail`,
    preview: `/${asset.id}/preview`,
    original: `/${asset.id}/original`,
  }),
}));

const asset = (id: string) => ({ id }) as AssetResponseDto;
const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => asset(id));
const destroyedFor = (id: string) =>
  loads.filter(({ src }) => src.startsWith(`/${id}/`)).every(({ destroy }) => destroy.mock.calls.length > 0);

describe('PreloadManager', () => {
  beforeEach(() => {
    loads.length = 0;
  });

  it('destroys a replaced preloader once the viewer has moved past its asset', () => {
    const manager = new PreloadManager();
    manager.initializePreloads({ current: a, nextAsset: b }, undefined);

    // a -> b: b's preloader is overwritten; the viewer now shows b, so it is kept for now (its <Image> adopts it)
    manager.updateAfterNavigation(
      { current: a, nextAsset: b },
      { current: b, previousAsset: a, nextAsset: c },
      undefined,
    );
    expect(destroyedFor('b')).toBe(false);

    // b -> c: the viewer left b, so b's orphaned preloader is destroyed (its tokens no longer keep b's download alive)
    manager.updateAfterNavigation(
      { current: b, previousAsset: a, nextAsset: c },
      { current: c, previousAsset: b, nextAsset: d },
      undefined,
    );
    expect(destroyedFor('b')).toBe(true);
    expect(destroyedFor('c')).toBe(false);

    manager.destroy();
    expect(destroyedFor('c')).toBe(true);
    expect(destroyedFor('d')).toBe(true);
  });

  it('also destroys a replaced previous preloader after moving back past it', () => {
    const manager = new PreloadManager();
    manager.initializePreloads({ current: c, previousAsset: b }, undefined);

    manager.updateAfterNavigation(
      { current: c, previousAsset: b },
      { current: b, previousAsset: a, nextAsset: c },
      undefined,
    );
    expect(destroyedFor('b')).toBe(false);

    manager.updateAfterNavigation(
      { current: b, previousAsset: a, nextAsset: c },
      { current: a, nextAsset: b },
      undefined,
    );
    expect(destroyedFor('b')).toBe(true);
  });
});
