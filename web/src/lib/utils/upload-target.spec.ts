import { AlbumKind } from '@immich/sdk';
import { getUploadTargetAlbumId } from '$lib/utils/upload-target';

describe('getUploadTargetAlbumId', () => {
  it('files into a regular album on its page', () => {
    expect(getUploadTargetAlbumId(true, 'album-1', { kind: AlbumKind.Regular })).toBe('album-1');
  });

  it('files into nothing on a smart album page', () => {
    expect(getUploadTargetAlbumId(true, 'album-1', { kind: AlbumKind.Smart })).toBeUndefined();
  });

  it('files into nothing outside an album page', () => {
    expect(getUploadTargetAlbumId(false, 'album-1', { kind: AlbumKind.Regular })).toBeUndefined();
    expect(getUploadTargetAlbumId(false, undefined, undefined)).toBeUndefined();
  });
});
