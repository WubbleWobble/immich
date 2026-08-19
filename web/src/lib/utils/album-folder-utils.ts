import type { AlbumContainerResponseDto, AlbumResponseDto } from '@immich/sdk';

/** All containers (inclusive of `rootId`) reachable downward via parentId. */
export const collectDescendantFolderIds = (containers: AlbumContainerResponseDto[], rootId: string): Set<string> => {
  const result = new Set<string>([rootId]);
  let added = true;
  while (added) {
    added = false;
    for (const c of containers) {
      if (c.parentId && result.has(c.parentId) && !result.has(c.id)) {
        result.add(c.id);
        added = true;
      }
    }
  }
  return result;
};

/** Containers whose parentId === parentId, sorted alphabetically by name. */
export const getDirectChildFolders = (
  containers: AlbumContainerResponseDto[],
  parentId: string | null,
): AlbumContainerResponseDto[] =>
  containers.filter((c) => (c.parentId ?? null) === parentId).sort((a, b) => a.name.localeCompare(b.name));

/** Count of direct children (sub-folders + albums) for `folderId`. Albums may come from multiple
 * sources (owned vs shared); pass them all to get a correct total. */
export const getDirectChildCount = (
  folderId: string,
  containers: AlbumContainerResponseDto[],
  ...albumLists: (AlbumResponseDto[] | undefined)[]
): number => {
  const subFolders = containers.filter((c) => c.parentId === folderId).length;
  const subAlbums = albumLists.reduce(
    (total, list) => total + (list ?? []).filter((a) => a.containerId === folderId).length,
    0,
  );
  return subFolders + subAlbums;
};

/** Walk `parentId` chain from `startId` up to the root, returning the path top-down.
 *  Caps at `maxDepth` to guard against unexpected cycles or pathological data.
 *  The default mirrors the server-side `MAX_DEPTH` in
 *  `server/src/services/album-container.service.ts` — keep the two in sync.
 */
export const buildFolderBreadcrumbPath = (
  containers: AlbumContainerResponseDto[],
  startId: string | null | undefined,
  maxDepth = 16,
): AlbumContainerResponseDto[] => {
  if (!startId) {
    return [];
  }
  const byId = new Map(containers.map((c) => [c.id, c]));
  const reversed: AlbumContainerResponseDto[] = [];
  let cursor: string | null | undefined = startId;
  for (let i = 0; i < maxDepth && cursor; i++) {
    const node = byId.get(cursor);
    if (!node) {
      break;
    }
    reversed.push(node);
    cursor = node.parentId;
  }
  return reversed.reverse();
};
