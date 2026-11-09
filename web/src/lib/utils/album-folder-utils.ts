import type { AlbumContainerResponseDto, AlbumResponseDto } from '@immich/sdk';

/** All containers (inclusive of `rootId`) reachable downward via parentId. */
export const collectDescendantFolderIds = (containers: AlbumContainerResponseDto[], rootId: string): Set<string> => {
  const result = new Set<string>([rootId]);
  let added = true;
  while (added) {
    added = false;
    for (const c of containers) {
      if (!c.parentId || !result.has(c.parentId) || result.has(c.id)) {
        continue;
      }
      result.add(c.id);
      added = true;
    }
  }
  return result;
};

/**
 * The parent the viewer sees for a folder (`parentId`) or album (`containerId`). The server can grant
 * a folder or album without its ancestors (a direct share from inside a private folder). Such an item
 * is shown at the viewer's root: its real parent is outside `accessibleFolderIds` (the viewer's
 * container list) and is never fetched or named. The owner can access all their own folders, so
 * their structure is unchanged.
 */
export const getDisplayedParentId = (
  parentId: string | null | undefined,
  accessibleFolderIds: ReadonlySet<string>,
): string | null => (parentId && accessibleFolderIds.has(parentId) ? parentId : null);

const folderIds = (containers: AlbumContainerResponseDto[]) => new Set(containers.map(({ id }) => id));

/** Folders displayed directly under `parentId` (null = the viewer's root), sorted alphabetically by name. */
export const getDirectChildFolders = (
  containers: AlbumContainerResponseDto[],
  parentId: string | null,
): AlbumContainerResponseDto[] => {
  const accessible = folderIds(containers);
  return containers
    .filter((c) => getDisplayedParentId(c.parentId, accessible) === parentId)
    .sort((a, b) => a.name.localeCompare(b.name));
};

/** Albums displayed directly in `folderId` (null = the viewer's root); see `getDisplayedParentId`. */
export const getDirectChildAlbums = (
  albums: AlbumResponseDto[],
  containers: AlbumContainerResponseDto[],
  folderId: string | null,
): AlbumResponseDto[] => {
  const accessible = folderIds(containers);
  return albums.filter((a) => getDisplayedParentId(a.containerId, accessible) === folderId);
};

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
