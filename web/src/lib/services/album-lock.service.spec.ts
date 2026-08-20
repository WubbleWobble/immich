import {
  addAssetsToAlbum,
  AlbumKind,
  BulkIdErrorReason,
  getAllAlbums,
  removeAssetFromAlbum,
  type AlbumResponseDto,
} from '@immich/sdk';
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
const ok = (id: string) => ({ id, success: true });

describe('moveAssetsToLockedAlbum', () => {
  beforeEach(() => {
    vitest.clearAllMocks();
  });

  it('removes moved assets from their other regular albums, but never from smart albums', async () => {
    (addAssetsToAlbum as Mock).mockResolvedValue([ok('asset-1')]);
    (getAllAlbums as Mock).mockResolvedValue([album('locked-album'), album('other-album')]);
    (removeAssetFromAlbum as Mock).mockResolvedValue([ok('asset-1')]);

    await expect(moveAssetsToLockedAlbum('locked-album', ['asset-1'])).resolves.toEqual({
      moved: ['asset-1'],
      stillVisible: [],
      failed: [],
    });

    expect(removeAssetFromAlbum).toHaveBeenCalledTimes(1);
    expect(removeAssetFromAlbum).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'other-album', bulkIdsDto: { ids: ['asset-1'] } }),
    );
  });

  it('never removes memberships of assets that failed to enter the locked album', async () => {
    (addAssetsToAlbum as Mock).mockResolvedValue([
      ok('asset-1'),
      { id: 'asset-2', success: false, error: BulkIdErrorReason.NoPermission },
    ]);
    (getAllAlbums as Mock).mockResolvedValue([album('locked-album'), album('other-album')]);
    (removeAssetFromAlbum as Mock).mockResolvedValue([ok('asset-1')]);

    const result = await moveAssetsToLockedAlbum('locked-album', ['asset-1', 'asset-2']);

    expect(result.failed).toEqual(['asset-2']);
    expect(result.moved).toEqual(['asset-1']);
    // Only asset-1's albums were even fetched; asset-2's memberships stay untouched.
    expect(getAllAlbums).toHaveBeenCalledTimes(1);
    expect(removeAssetFromAlbum).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'other-album', bulkIdsDto: { ids: ['asset-1'] } }),
    );
  });

  it('treats an already-locked duplicate as moved', async () => {
    (addAssetsToAlbum as Mock).mockResolvedValue([
      { id: 'asset-1', success: false, error: BulkIdErrorReason.Duplicate },
    ]);
    (getAllAlbums as Mock).mockResolvedValue([album('locked-album')]);

    await expect(moveAssetsToLockedAlbum('locked-album', ['asset-1'])).resolves.toEqual({
      moved: ['asset-1'],
      stillVisible: [],
      failed: [],
    });
  });

  it('reports assets matched by a smart album as still visible', async () => {
    (addAssetsToAlbum as Mock).mockResolvedValue([ok('asset-1')]);
    (getAllAlbums as Mock).mockResolvedValue([album('locked-album'), album('smart-album', AlbumKind.Smart)]);

    const result = await moveAssetsToLockedAlbum('locked-album', ['asset-1']);

    expect(result.stillVisible).toEqual(['asset-1']);
    expect(result.moved).toEqual([]);
    expect(removeAssetFromAlbum).not.toHaveBeenCalled();
  });

  it('reports assets whose removal failed (e.g. viewer-role shares) as still visible', async () => {
    (addAssetsToAlbum as Mock).mockResolvedValue([ok('asset-1')]);
    (getAllAlbums as Mock).mockResolvedValue([album('locked-album'), album('read-only-share')]);
    (removeAssetFromAlbum as Mock).mockRejectedValue(new Error('no access'));

    const result = await moveAssetsToLockedAlbum('locked-album', ['asset-1']);

    expect(result.stillVisible).toEqual(['asset-1']);
    expect(result.moved).toEqual([]);
  });

  it('reports assets whose album list could not be fetched as still visible', async () => {
    (addAssetsToAlbum as Mock).mockResolvedValue([ok('asset-1')]);
    (getAllAlbums as Mock).mockRejectedValue(new Error('network'));

    const result = await moveAssetsToLockedAlbum('locked-album', ['asset-1']);

    expect(result.stillVisible).toEqual(['asset-1']);
    expect(removeAssetFromAlbum).not.toHaveBeenCalled();
  });

  it('batches removals per album across multiple assets', async () => {
    (addAssetsToAlbum as Mock).mockResolvedValue([ok('asset-1'), ok('asset-2')]);
    (getAllAlbums as Mock)
      .mockResolvedValueOnce([album('locked-album'), album('shared-target')])
      .mockResolvedValueOnce([album('locked-album'), album('shared-target')]);
    (removeAssetFromAlbum as Mock).mockResolvedValue([ok('asset-1'), ok('asset-2')]);

    const result = await moveAssetsToLockedAlbum('locked-album', ['asset-1', 'asset-2']);

    expect(removeAssetFromAlbum).toHaveBeenCalledTimes(1);
    expect(removeAssetFromAlbum).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'shared-target', bulkIdsDto: { ids: ['asset-1', 'asset-2'] } }),
    );
    expect(result.moved).toEqual(['asset-1', 'asset-2']);
  });

  it('marks only the assets a bulk removal reported as failed', async () => {
    (addAssetsToAlbum as Mock).mockResolvedValue([ok('asset-1'), ok('asset-2')]);
    (getAllAlbums as Mock)
      .mockResolvedValueOnce([album('locked-album'), album('shared-target')])
      .mockResolvedValueOnce([album('locked-album'), album('shared-target')]);
    (removeAssetFromAlbum as Mock).mockResolvedValue([
      ok('asset-1'),
      { id: 'asset-2', success: false, error: BulkIdErrorReason.NoPermission },
    ]);

    const result = await moveAssetsToLockedAlbum('locked-album', ['asset-1', 'asset-2']);

    expect(result.moved).toEqual(['asset-1']);
    expect(result.stillVisible).toEqual(['asset-2']);
  });
});
