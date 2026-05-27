import { getAllAlbumContainers, getAllAlbums, type AlbumContainerResponseDto } from '@immich/sdk';
import { buildFolderBreadcrumbPath } from '$lib/utils/album-folder-utils';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

const MAX_FOLDER_DEPTH = 16;

export const load = (async ({ url }) => {
  await authenticate(url);

  const folderId = url.searchParams.get('folder') ?? null;

  const [sharedAlbums, allAlbums, allContainers] = await Promise.all([
    getAllAlbums({ isShared: true }),
    getAllAlbums({ isOwned: true }),
    getAllAlbumContainers().catch(() => [] as AlbumContainerResponseDto[]),
  ]);

  const $t = await getFormatter();

  // Build the breadcrumb path by walking the parentId chain (top-down).
  const folderPath = buildFolderBreadcrumbPath(allContainers, folderId, MAX_FOLDER_DEPTH);
  const currentFolder: AlbumContainerResponseDto | null = folderPath.at(-1) ?? null;

  return {
    albums: allAlbums,
    sharedAlbums,
    folderId,
    currentFolder,
    folderPath,
    allContainers,
    meta: {
      title: currentFolder?.name ?? $t('albums'),
    },
  };
}) satisfies PageLoad;
