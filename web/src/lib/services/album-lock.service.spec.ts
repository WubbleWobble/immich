import { addAssetsToAlbum, AlbumKind, getAllAlbums, removeAssetFromAlbum, type AlbumResponseDto } from '@immich/sdk';
import type { Mock } from 'vitest';
import { vitest } from 'vitest';
import { moveAssetsToLockedAlbum } from '$lib/services/album.service';

vitest.mock('@immich/sdk', async (importOriginal) => {
  const original = await importOriginal<typeof import('@immich/sdk')>();
  return {
    ...original,
    addAssetsToAlbum: vitest.fn(),
    getAllAlbums: vitest.fn(),
    removeAssetFromAlbum: vitest.fn(),
  };
});

vitest.mock('$lib/utils/i18n', () => ({
  getFormatter: vitest.fn().mockResolvedValue((key: string) => key),
  getPreferredLocale: vitest.fn(),
}));

const album = (id: string, kind: AlbumKind = AlbumKind.Regular) => ({ id, kind }) as AlbumResponseDto;

describe('moveAssetsToLockedAlbum', () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    (addAssetsToAlbum as Mock).mockResolvedValue([{ id: 'asset-1', success: true }]);
  });

  it('removes the assets from their other regular albums, but never from smart albums', async () => {
    (getAllAlbums as Mock).mockResolvedValue([
      album('locked-album'),
      album('other-album'),
      album('smart-album', AlbumKind.Smart),
    ]);
    (removeAssetFromAlbum as Mock).mockResolvedValue([{ id: 'asset-1', success: true }]);

    await expect(moveAssetsToLockedAlbum('locked-album', ['asset-1'])).resolves.toBe(true);

    expect(addAssetsToAlbum).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'locked-album', bulkIdsDto: { ids: ['asset-1'] } }),
    );
    expect(removeAssetFromAlbum).toHaveBeenCalledTimes(1);
    expect(removeAssetFromAlbum).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'other-album', bulkIdsDto: { ids: ['asset-1'] } }),
    );
  });

  it('tolerates removal failures (e.g. viewer-role shares) without failing the move', async () => {
    (getAllAlbums as Mock).mockResolvedValue([album('locked-album'), album('read-only-share')]);
    (removeAssetFromAlbum as Mock).mockRejectedValue(new Error('no access'));

    await expect(moveAssetsToLockedAlbum('locked-album', ['asset-1'])).resolves.toBe(true);
  });

  it('batches removals per album across multiple assets', async () => {
    (getAllAlbums as Mock)
      .mockResolvedValueOnce([album('locked-album'), album('shared-target')])
      .mockResolvedValueOnce([album('locked-album'), album('shared-target')]);
    (removeAssetFromAlbum as Mock).mockResolvedValue([]);

    await moveAssetsToLockedAlbum('locked-album', ['asset-1', 'asset-2']);

    expect(removeAssetFromAlbum).toHaveBeenCalledTimes(1);
    expect(removeAssetFromAlbum).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'shared-target', bulkIdsDto: { ids: ['asset-1', 'asset-2'] } }),
    );
  });
});
