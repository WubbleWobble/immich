import { moveAssetsToLockedAlbum as moveToLockedAlbum } from '@immich/sdk';
import type { Mock } from 'vitest';
import { vitest } from 'vitest';
import { moveAssetsToLockedAlbum } from '$lib/services/album.service';

vitest.mock('@immich/sdk', async (importOriginal) => {
  const original = await importOriginal<typeof import('@immich/sdk')>();
  return {
    ...original,
    moveAssetsToLockedAlbum: vitest.fn(),
  };
});

vitest.mock('$lib/utils/i18n', () => ({
  getFormatter: vitest.fn().mockResolvedValue((key: string) => key),
  getPreferredLocale: vitest.fn(),
}));

describe('moveAssetsToLockedAlbum', () => {
  beforeEach(() => {
    vitest.clearAllMocks();
  });

  it('delegates to the server-side move endpoint and passes its verdicts through', async () => {
    (moveToLockedAlbum as Mock).mockResolvedValue({
      moved: ['asset-1'],
      stillVisible: ['asset-2'],
      failed: ['asset-3'],
    });

    await expect(moveAssetsToLockedAlbum('locked-album', ['asset-1', 'asset-2', 'asset-3'])).resolves.toEqual({
      moved: ['asset-1'],
      stillVisible: ['asset-2'],
      failed: ['asset-3'],
    });

    expect(moveToLockedAlbum).toHaveBeenCalledWith(
      expect.objectContaining({
        moveToLockedAlbumDto: { albumId: 'locked-album', assetIds: ['asset-1', 'asset-2', 'asset-3'] },
      }),
    );
  });

  it('reports every asset as failed when the request itself fails', async () => {
    (moveToLockedAlbum as Mock).mockRejectedValue(new Error('network'));

    await expect(moveAssetsToLockedAlbum('locked-album', ['asset-1', 'asset-2'])).resolves.toEqual({
      moved: [],
      stillVisible: [],
      failed: ['asset-1', 'asset-2'],
    });
  });
});
