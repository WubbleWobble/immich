import type { AlbumContainerResponseDto } from '@immich/sdk';
import { buildFolderBreadcrumbPath, getDirectChildAlbums, getDirectChildFolders } from '$lib/utils/album-folder-utils';
import { albumFactory } from '@test-data/factories/album-factory';

const folder = (id: string, parentId: string | null, ownerId = 'owner'): AlbumContainerResponseDto =>
  ({ id, name: id, parentId, ownerId }) as AlbumContainerResponseDto;

// T3: the API grants a directly shared child folder (or album) without granting its private
// ancestors. The viewer's displayed tree promotes such items to the viewer's root.
describe('album folder tree for the viewer', () => {
  describe('owner (every folder accessible)', () => {
    const trips = folder('trips', null);
    const italy = folder('italy', 'trips');
    const rome = folder('rome', 'italy');
    const containers = [rome, italy, trips];
    const rootAlbum = albumFactory.build({ id: 'root-album', containerId: null });
    const italyAlbum = albumFactory.build({ id: 'italy-album', containerId: 'italy' });

    it('keeps the real nesting for folders', () => {
      expect(getDirectChildFolders(containers, null)).toEqual([trips]);
      expect(getDirectChildFolders(containers, 'trips')).toEqual([italy]);
      expect(getDirectChildFolders(containers, 'italy')).toEqual([rome]);
    });

    it('keeps the real nesting for albums', () => {
      const albums = [rootAlbum, italyAlbum];
      expect(getDirectChildAlbums(albums, containers, null)).toEqual([rootAlbum]);
      expect(getDirectChildAlbums(albums, containers, 'italy')).toEqual([italyAlbum]);
      expect(getDirectChildAlbums(albums, containers, 'trips')).toEqual([]);
    });
  });

  describe('recipient of a child folder whose parent is private', () => {
    // A owns Private > SharedChild > Grandchild and shares only SharedChild with B. B's container
    // API returns SharedChild and its descendants, never Private.
    const sharedChild = folder('shared-child', 'private');
    const grandchild = folder('grandchild', 'shared-child');
    const containers = [sharedChild, grandchild];

    it("shows the shared folder at the recipient's root", () => {
      expect(getDirectChildFolders(containers, null)).toEqual([sharedChild]);
    });

    it('keeps nesting below the shared folder', () => {
      expect(getDirectChildFolders(containers, 'shared-child')).toEqual([grandchild]);
      expect(getDirectChildFolders(containers, 'grandchild')).toEqual([]);
    });

    it('never builds a path through the private parent', () => {
      expect(buildFolderBreadcrumbPath(containers, 'grandchild')).toEqual([sharedChild, grandchild]);
    });

    it('lists albums inside the shared folder there, not at the root', () => {
      const inside = albumFactory.build({ id: 'inside', containerId: 'shared-child' });
      expect(getDirectChildAlbums([inside], containers, 'shared-child')).toEqual([inside]);
      expect(getDirectChildAlbums([inside], containers, null)).toEqual([]);
    });
  });

  describe('recipient of an album whose folder is private', () => {
    it("shows the shared album at the recipient's root", () => {
      const shared = albumFactory.build({ id: 'shared-album', containerId: 'private' });
      expect(getDirectChildAlbums([shared], [], null)).toEqual([shared]);
      expect(getDirectChildAlbums([shared], [], 'private')).toEqual([]);
    });

    it('promotes the album when only an unrelated folder is accessible', () => {
      const other = folder('other', null, 'someone-else');
      const shared = albumFactory.build({ id: 'shared-album', containerId: 'private' });
      expect(getDirectChildAlbums([shared], [other], null)).toEqual([shared]);
      expect(getDirectChildAlbums([shared], [other], 'other')).toEqual([]);
    });
  });
});
