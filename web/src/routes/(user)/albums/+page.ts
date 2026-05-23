import { getAlbumContainer, getAllAlbumContainers, getAllAlbums, type AlbumContainerResponseDto } from '@immich/sdk';
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

  // Build the breadcrumb path by walking the parentId chain.
  const folderPath: AlbumContainerResponseDto[] = [];
  let currentFolder: AlbumContainerResponseDto | null = null;
  if (folderId) {
    const containersById = new Map(allContainers.map((c) => [c.id, c] as const));
    let cursorId: string | null = folderId;
    let safety = MAX_FOLDER_DEPTH + 1;
    while (cursorId && safety-- > 0) {
      const node: AlbumContainerResponseDto | undefined =
        containersById.get(cursorId) ??
        (await getAlbumContainer({ id: cursorId }).catch(() => undefined));
      if (!node) {
        break;
      }
      if (!currentFolder) {
        currentFolder = node;
      }
      folderPath.unshift(node);
      cursorId = node.parentId;
    }
  }

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
