import { AlbumKind } from '@immich/sdk';

/**
 * Fork: the album a dropped or pasted upload is filed into from the current page. A smart album's membership is its
 * filter (the server refuses to file into one), so on a smart album page the upload goes to the library only.
 */
export const getUploadTargetAlbumId = (
  isAlbumPage: boolean,
  albumId: string | undefined,
  album: { kind?: AlbumKind } | undefined,
): string | undefined => (isAlbumPage && album?.kind !== AlbumKind.Smart ? albumId : undefined);
