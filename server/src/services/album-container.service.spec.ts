import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AlbumUserRole } from 'src/enum';
import { AlbumContainerService } from 'src/services/album-container.service';
import { AuthFactory } from 'test/factories/auth.factory';
import { UserFactory } from 'test/factories/user.factory';
import { newUuid } from 'test/small.factory';
import { newTestService, ServiceMocks } from 'test/utils';
import { beforeEach, describe, expect, it } from 'vitest';

const folderForOwner = (ownerId: string, id = newUuid()) => ({
  id,
  ownerId,
  name: 'Folder',
  parentId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
  updateId: newUuid(),
});

describe(AlbumContainerService.name, () => {
  let sut: AlbumContainerService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(AlbumContainerService));
  });

  describe('list', () => {
    it('warms stale smart-album caches before fetching mosaics', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      const containerId = newUuid();
      const smartAlbumId = newUuid();
      mocks.albumContainer.getForUser.mockResolvedValue([
        {
          id: containerId,
          ownerId: owner.id,
          name: 'Smart Folder',
          parentId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          updateId: newUuid(),
        },
      ]);
      mocks.albumContainer.getUsersForContainers.mockResolvedValue([]);
      mocks.albumContainer.getThumbnailAssetIdsForContainers.mockResolvedValue(new Map());
      // Never computed -> stale; the folder path itself must refresh it (the web loads
      // albums and folders concurrently, so the album list cannot be relied on).
      mocks.albumContainer.getSmartAlbumsForContainers.mockResolvedValue([
        {
          id: smartAlbumId,
          filter: { isFavorite: true },
          ownerId: owner.id,
          cacheComputedAt: null,
          cacheInvalidatedAt: null,
        },
      ]);
      mocks.search.searchStatistics.mockResolvedValue({ total: 1 });
      mocks.search.searchDateRange.mockResolvedValue({ startDate: null, endDate: null });
      mocks.search.searchMetadata.mockResolvedValue({ items: [], hasNextPage: false });

      await sut.list(auth);

      expect(mocks.albumContainer.getSmartAlbumsForContainers).toHaveBeenCalledWith([containerId]);
      expect(mocks.album.updateCachedMetadata).toHaveBeenCalledWith(
        smartAlbumId,
        expect.objectContaining({ cachedAssetCount: 1 }),
      );
    });

    it('recomputes a duplicated stale smart album only once', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      const containerId = newUuid();
      const smartAlbumId = newUuid();
      const staleRow = {
        id: smartAlbumId,
        filter: { isFavorite: true },
        ownerId: owner.id,
        cacheComputedAt: null,
        cacheInvalidatedAt: null,
      };
      mocks.albumContainer.getForUser.mockResolvedValue([
        {
          id: containerId,
          ownerId: owner.id,
          name: 'Nested Smart Folder',
          parentId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          updateId: newUuid(),
        },
      ]);
      mocks.albumContainer.getUsersForContainers.mockResolvedValue([]);
      mocks.albumContainer.getThumbnailAssetIdsForContainers.mockResolvedValue(new Map());
      // Same album surfaced once per requested ancestor (parent + child in containerIds).
      mocks.albumContainer.getSmartAlbumsForContainers.mockResolvedValue([staleRow, staleRow]);
      mocks.search.searchStatistics.mockResolvedValue({ total: 1 });
      mocks.search.searchDateRange.mockResolvedValue({ startDate: null, endDate: null });
      mocks.search.searchMetadata.mockResolvedValue({ items: [], hasNextPage: false });

      await sut.list(auth);

      expect(mocks.album.updateCachedMetadata).toHaveBeenCalledTimes(1);
    });

    it('populates thumbnailAssetIds from the repository', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      const containerId = newUuid();
      const asset1 = newUuid();
      const asset2 = newUuid();
      mocks.albumContainer.getForUser.mockResolvedValue([
        {
          id: containerId,
          ownerId: owner.id,
          name: 'Trip',
          parentId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          updateId: newUuid(),
        },
      ]);
      mocks.albumContainer.getUsersForContainers.mockResolvedValue([]);
      mocks.albumContainer.getThumbnailAssetIdsForContainers.mockResolvedValue(
        new Map([[containerId, [asset1, asset2]]]),
      );

      const result = await sut.list(auth);

      expect(result).toHaveLength(1);
      expect(result[0].thumbnailAssetIds).toEqual([asset1, asset2]);
    });

    it('defaults to empty thumbnailAssetIds when no descendant assets', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      const containerId = newUuid();
      mocks.albumContainer.getForUser.mockResolvedValue([
        {
          id: containerId,
          ownerId: owner.id,
          name: 'Empty',
          parentId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          updateId: newUuid(),
        },
      ]);
      mocks.albumContainer.getUsersForContainers.mockResolvedValue([]);
      mocks.albumContainer.getThumbnailAssetIdsForContainers.mockResolvedValue(new Map());

      const result = await sut.list(auth);

      expect(result[0].thumbnailAssetIds).toEqual([]);
    });

    it('omits albumContainerUsers for non-owned cascade-visible folders and populates it for owned ones', async () => {
      const viewer = UserFactory.create();
      const otherOwner = UserFactory.create();
      const auth = AuthFactory.create({ id: viewer.id });
      const ownedId = newUuid();
      const sharedId = newUuid();
      mocks.albumContainer.getForUser.mockResolvedValue([
        {
          id: ownedId,
          ownerId: viewer.id,
          name: 'My folder',
          parentId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          updateId: newUuid(),
        },
        {
          id: sharedId,
          ownerId: otherOwner.id,
          name: 'Shared with me',
          parentId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          updateId: newUuid(),
        },
      ]);
      const guestUserId = newUuid();
      mocks.albumContainer.getUsersForContainers.mockResolvedValue([
        {
          albumContainerId: ownedId,
          userId: guestUserId,
          role: AlbumUserRole.Viewer,
          user_id: guestUserId,
          user_name: 'Guest',
          user_email: 'guest@example.com',
          user_avatarColor: null,
          user_profileImagePath: '',
          user_profileChangedAt: new Date(),
        } as any,
      ]);
      mocks.albumContainer.getThumbnailAssetIdsForContainers.mockResolvedValue(new Map());

      const result = await sut.list(auth);

      const owned = result.find((c) => c.id === ownedId)!;
      const shared = result.find((c) => c.id === sharedId)!;
      expect(owned.albumContainerUsers).toBeDefined();
      expect(owned.albumContainerUsers).toHaveLength(1);
      expect(shared.albumContainerUsers).toBeUndefined();
      // Repository should be queried only for owned IDs, not shared ones.
      expect(mocks.albumContainer.getUsersForContainers).toHaveBeenCalledWith([ownedId]);
    });
  });

  describe('get', () => {
    it('returns the folder for its owner', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      const id = newUuid();
      mocks.albumContainer.getById.mockResolvedValue({
        id,
        ownerId: owner.id,
        name: 'Family',
        parentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        updateId: newUuid(),
      });
      mocks.albumContainer.getUsersForContainers.mockResolvedValue([]);
      mocks.albumContainer.getThumbnailAssetIdsForContainers.mockResolvedValue(new Map());

      const result = await sut.get(auth, id);

      expect(result.id).toEqual(id);
      expect(result.name).toEqual('Family');
      expect(result.albumContainerUsers).toEqual([]);
      expect(result.thumbnailAssetIds).toEqual([]);
    });

    it('populates albumContainerUsers from the repository', async () => {
      const owner = UserFactory.create();
      const sharedUser = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      const id = newUuid();
      mocks.albumContainer.getById.mockResolvedValue({
        id,
        ownerId: owner.id,
        name: 'Family',
        parentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        updateId: newUuid(),
      });
      mocks.albumContainer.getThumbnailAssetIdsForContainers.mockResolvedValue(new Map());
      mocks.albumContainer.getUsersForContainers.mockResolvedValue([
        {
          albumContainerId: id,
          userId: sharedUser.id,
          role: AlbumUserRole.Viewer,
          user_id: sharedUser.id,
          user_name: sharedUser.name,
          user_email: sharedUser.email,
          user_avatarColor: sharedUser.avatarColor ?? null,
          user_profileImagePath: sharedUser.profileImagePath,
          user_profileChangedAt: sharedUser.profileChangedAt,
        },
      ]);

      const result = await sut.get(auth, id);

      expect(result.albumContainerUsers).toHaveLength(1);
      expect(result.albumContainerUsers?.[0].userId).toEqual(sharedUser.id);
      expect(result.albumContainerUsers?.[0].role).toEqual(AlbumUserRole.Viewer);
      expect(result.albumContainerUsers?.[0].user.id).toEqual(sharedUser.id);
    });

    it('throws NotFoundException when folder does not exist', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      mocks.albumContainer.getById.mockResolvedValue(void 0);

      await expect(sut.get(auth, newUuid())).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws ForbiddenException when called by unrelated user', async () => {
      const owner = UserFactory.create();
      const intruder = UserFactory.create();
      const auth = AuthFactory.create({ id: intruder.id });
      const id = newUuid();
      mocks.albumContainer.getById.mockResolvedValue({
        id,
        ownerId: owner.id,
        name: 'Family',
        parentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        updateId: newUuid(),
      });
      mocks.albumContainer.hasAccess.mockResolvedValue(false);

      await expect(sut.get(auth, id)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns the container for a cascade recipient with albumContainerUsers omitted', async () => {
      const owner = UserFactory.create();
      const recipient = UserFactory.create();
      const auth = AuthFactory.create({ id: recipient.id });
      const id = newUuid();
      mocks.albumContainer.getById.mockResolvedValue({
        id,
        ownerId: owner.id,
        name: 'Shared',
        parentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        updateId: newUuid(),
      });
      mocks.albumContainer.hasAccess.mockResolvedValue(true);
      mocks.albumContainer.getThumbnailAssetIdsForContainers.mockResolvedValue(new Map());

      const result = await sut.get(auth, id);

      expect(result.id).toEqual(id);
      expect(result.ownerId).toEqual(owner.id);
      expect(result.albumContainerUsers).toBeUndefined();
      // Recipient path should not call fetchUsersByContainer at all.
      expect(mocks.albumContainer.getUsersForContainers).not.toHaveBeenCalled();
    });

    it('populates albumContainerUsers for owner but omits them for recipient', async () => {
      const owner = UserFactory.create();
      const sharedUser = UserFactory.create();
      const id = newUuid();
      const container = {
        id,
        ownerId: owner.id,
        name: 'Family',
        parentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        updateId: newUuid(),
      };

      // Owner path: users populated.
      mocks.albumContainer.getById.mockResolvedValue(container);
      mocks.albumContainer.getThumbnailAssetIdsForContainers.mockResolvedValue(new Map());
      mocks.albumContainer.getUsersForContainers.mockResolvedValue([
        {
          albumContainerId: id,
          userId: sharedUser.id,
          role: AlbumUserRole.Viewer,
          user_id: sharedUser.id,
          user_name: sharedUser.name,
          user_email: sharedUser.email,
          user_avatarColor: sharedUser.avatarColor ?? null,
          user_profileImagePath: sharedUser.profileImagePath,
          user_profileChangedAt: sharedUser.profileChangedAt,
        },
      ]);

      const ownerAuth = AuthFactory.create({ id: owner.id });
      const ownerResult = await sut.get(ownerAuth, id);
      expect(ownerResult.albumContainerUsers).toHaveLength(1);
      expect(ownerResult.albumContainerUsers?.[0].userId).toEqual(sharedUser.id);
    });
  });

  describe('create', () => {
    it('creates a root container', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      const id = newUuid();
      mocks.albumContainer.create.mockResolvedValue({
        id,
        ownerId: owner.id,
        name: 'Root',
        parentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        updateId: newUuid(),
      });

      const result = await sut.create(auth, { name: 'Root' });

      expect(result.id).toEqual(id);
      expect(result.parentId).toBeNull();
      expect(result.ownerId).toEqual(owner.id);
      expect(mocks.albumContainer.create).toHaveBeenCalledWith({
        ownerId: owner.id,
        name: 'Root',
        parentId: null,
      });
    });

    it('rejects when parent is owned by another user', async () => {
      const owner = UserFactory.create();
      const otherOwner = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      const parentId = newUuid();
      mocks.albumContainer.getById.mockResolvedValue({
        id: parentId,
        ownerId: otherOwner.id,
        name: 'Other',
        parentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        updateId: newUuid(),
      });

      await expect(sut.create(auth, { name: 'Child', parentId })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects when depth would exceed limit', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      const parentId = newUuid();
      mocks.albumContainer.getById.mockResolvedValue({
        id: parentId,
        ownerId: owner.id,
        name: 'Deep',
        parentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        updateId: newUuid(),
      });
      mocks.albumContainer.getDepth.mockResolvedValue(16);

      await expect(sut.create(auth, { name: 'TooDeep', parentId })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('update', () => {
    it('rejects moving a container into its own descendant (cycle)', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      const id = newUuid();
      const descendantId = newUuid();
      const source = {
        id,
        ownerId: owner.id,
        name: 'Folder',
        parentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        updateId: newUuid(),
      };
      mocks.albumContainer.getById.mockResolvedValueOnce(source).mockResolvedValueOnce({ ...source, id: descendantId });
      mocks.albumContainer.isDescendantOf.mockResolvedValue(true);

      await expect(sut.update(auth, id, { parentId: descendantId })).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.albumContainer.move).not.toHaveBeenCalled();
    });

    it('rejects move that exceeds depth limit', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      const id = newUuid();
      const newParentId = newUuid();
      const source = {
        id,
        ownerId: owner.id,
        name: 'Folder',
        parentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        updateId: newUuid(),
      };
      mocks.albumContainer.getById.mockResolvedValueOnce(source).mockResolvedValueOnce({ ...source, id: newParentId });
      mocks.albumContainer.isDescendantOf.mockResolvedValue(false);
      mocks.albumContainer.getDepth.mockResolvedValue(16);
      mocks.albumContainer.getHeight.mockResolvedValue(0);

      await expect(sut.update(auth, id, { parentId: newParentId })).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.albumContainer.move).not.toHaveBeenCalled();
    });

    it('rejects move that would push subtree past depth limit', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      const id = newUuid();
      const newParentId = newUuid();
      const source = {
        id,
        ownerId: owner.id,
        name: 'Folder',
        parentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        updateId: newUuid(),
      };
      mocks.albumContainer.getById.mockResolvedValueOnce(source).mockResolvedValueOnce({ ...source, id: newParentId });
      mocks.albumContainer.isDescendantOf.mockResolvedValue(false);
      // 8 + 1 + 9 = 18 > 16
      mocks.albumContainer.getDepth.mockResolvedValue(8);
      mocks.albumContainer.getHeight.mockResolvedValue(9);

      await expect(sut.update(auth, id, { parentId: newParentId })).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.albumContainer.move).not.toHaveBeenCalled();
    });

    it('rejects move under a folder owned by another user', async () => {
      const owner = UserFactory.create();
      const otherOwner = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      const id = newUuid();
      const newParentId = newUuid();
      const source = {
        id,
        ownerId: owner.id,
        name: 'Folder',
        parentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        updateId: newUuid(),
      };
      mocks.albumContainer.getById.mockResolvedValueOnce(source).mockResolvedValueOnce({
        id: newParentId,
        ownerId: otherOwner.id,
        name: 'Their Folder',
        parentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        updateId: newUuid(),
      });

      await expect(sut.update(auth, id, { parentId: newParentId })).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.albumContainer.isDescendantOf).not.toHaveBeenCalled();
      expect(mocks.albumContainer.move).not.toHaveBeenCalled();
    });

    it('rejects move under a parent that does not exist', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      const id = newUuid();
      const newParentId = newUuid();
      const source = {
        id,
        ownerId: owner.id,
        name: 'Folder',
        parentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        updateId: newUuid(),
      };
      mocks.albumContainer.getById.mockResolvedValueOnce(source).mockResolvedValueOnce(void 0);

      await expect(sut.update(auth, id, { parentId: newParentId })).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.albumContainer.move).not.toHaveBeenCalled();
    });

    it('moves successfully when valid', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      const id = newUuid();
      const newParentId = newUuid();
      const container = {
        id,
        ownerId: owner.id,
        name: 'Folder',
        parentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        updateId: newUuid(),
      };
      mocks.albumContainer.getById
        .mockResolvedValueOnce(container)
        .mockResolvedValueOnce({ ...container, id: newParentId })
        .mockResolvedValueOnce({ ...container, parentId: newParentId });
      mocks.albumContainer.isDescendantOf.mockResolvedValue(false);
      mocks.albumContainer.getDepth.mockResolvedValue(2);
      mocks.albumContainer.getHeight.mockResolvedValue(0);
      mocks.albumContainer.move.mockResolvedValue({ ...container, parentId: newParentId });
      mocks.albumContainer.getUsersForContainers.mockResolvedValue([]);
      mocks.albumContainer.getThumbnailAssetIdsForContainers.mockResolvedValue(new Map());

      const result = await sut.update(auth, id, { parentId: newParentId });

      expect(mocks.albumContainer.move).toHaveBeenCalledWith(id, newParentId);
      expect(result.parentId).toEqual(newParentId);
    });
  });

  describe('share', () => {
    it('adds a user share when called by owner', async () => {
      const owner = UserFactory.create();
      const sharedUser = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      const id = newUuid();
      mocks.albumContainer.getById.mockResolvedValue(folderForOwner(owner.id, id));
      mocks.albumContainer.getUser.mockResolvedValue(void 0);
      mocks.user.get.mockResolvedValue(sharedUser);

      await sut.addUser(auth, id, { userId: sharedUser.id, role: AlbumUserRole.Editor });

      expect(mocks.albumContainer.addUser).toHaveBeenCalledWith(id, sharedUser.id, AlbumUserRole.Editor);
    });

    it('rejects share with role Owner', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      const id = newUuid();
      mocks.albumContainer.getById.mockResolvedValue(folderForOwner(owner.id, id));

      await expect(sut.addUser(auth, id, { userId: newUuid(), role: AlbumUserRole.Owner })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.albumContainer.addUser).not.toHaveBeenCalled();
    });

    it('rejects share with self', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      const id = newUuid();
      mocks.albumContainer.getById.mockResolvedValue(folderForOwner(owner.id, id));

      await expect(sut.addUser(auth, id, { userId: owner.id, role: AlbumUserRole.Editor })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.albumContainer.addUser).not.toHaveBeenCalled();
    });

    it('rejects duplicate share', async () => {
      const owner = UserFactory.create();
      const sharedUser = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      const id = newUuid();
      mocks.albumContainer.getById.mockResolvedValue(folderForOwner(owner.id, id));
      mocks.albumContainer.getUser.mockResolvedValue({
        albumContainerId: id,
        userId: sharedUser.id,
        role: AlbumUserRole.Viewer,
        createdAt: new Date(),
        updatedAt: new Date(),
        updateId: newUuid(),
        createId: newUuid(),
      });

      await expect(sut.addUser(auth, id, { userId: sharedUser.id, role: AlbumUserRole.Editor })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.albumContainer.addUser).not.toHaveBeenCalled();
    });

    it('rejects share when user does not exist', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      const id = newUuid();
      const userId = newUuid();
      mocks.albumContainer.getById.mockResolvedValue(folderForOwner(owner.id, id));
      mocks.albumContainer.getUser.mockResolvedValue(void 0);
      mocks.user.get.mockResolvedValue(void 0);

      await expect(sut.addUser(auth, id, { userId, role: AlbumUserRole.Editor })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.albumContainer.addUser).not.toHaveBeenCalled();
    });

    it('rejects share by non-owner', async () => {
      const owner = UserFactory.create();
      const otherUser = UserFactory.create();
      const auth = AuthFactory.create({ id: otherUser.id });
      const id = newUuid();
      const sharedUserId = newUuid();
      mocks.albumContainer.getById.mockResolvedValue({
        id,
        ownerId: owner.id,
        name: 'Folder',
        parentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        updateId: newUuid(),
      });

      await expect(sut.addUser(auth, id, { userId: sharedUserId, role: AlbumUserRole.Editor })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(mocks.albumContainer.addUser).not.toHaveBeenCalled();
    });
  });

  describe('removeUser', () => {
    it('throws NotFoundException when share does not exist', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      const id = newUuid();
      const userId = newUuid();
      mocks.albumContainer.getById.mockResolvedValue(folderForOwner(owner.id, id));
      mocks.albumContainer.getUser.mockResolvedValue(void 0);

      await expect(sut.removeUser(auth, id, userId)).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.albumContainer.removeUser).not.toHaveBeenCalled();
    });

    it('removes the share when it exists', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      const id = newUuid();
      const userId = newUuid();
      mocks.albumContainer.getById.mockResolvedValue(folderForOwner(owner.id, id));
      mocks.albumContainer.getUser.mockResolvedValue({
        albumContainerId: id,
        userId,
        role: AlbumUserRole.Viewer,
        createdAt: new Date(),
        updatedAt: new Date(),
        updateId: newUuid(),
        createId: newUuid(),
      });

      await sut.removeUser(auth, id, userId);

      expect(mocks.albumContainer.removeUser).toHaveBeenCalledWith(id, userId);
    });
  });

  describe('updateUser', () => {
    it('throws BadRequestException when role is Owner', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      const id = newUuid();
      const userId = newUuid();
      mocks.albumContainer.getById.mockResolvedValue(folderForOwner(owner.id, id));

      await expect(sut.updateUser(auth, id, userId, { role: AlbumUserRole.Owner })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.albumContainer.getUser).not.toHaveBeenCalled();
      expect(mocks.albumContainer.updateUserRole).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when share does not exist', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      const id = newUuid();
      const userId = newUuid();
      mocks.albumContainer.getById.mockResolvedValue(folderForOwner(owner.id, id));
      mocks.albumContainer.getUser.mockResolvedValue(void 0);

      await expect(sut.updateUser(auth, id, userId, { role: AlbumUserRole.Editor })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mocks.albumContainer.updateUserRole).not.toHaveBeenCalled();
    });

    it('updates the role when the share exists', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      const id = newUuid();
      const userId = newUuid();
      mocks.albumContainer.getById.mockResolvedValue(folderForOwner(owner.id, id));
      mocks.albumContainer.getUser.mockResolvedValue({
        albumContainerId: id,
        userId,
        role: AlbumUserRole.Viewer,
        createdAt: new Date(),
        updatedAt: new Date(),
        updateId: newUuid(),
        createId: newUuid(),
      });

      await sut.updateUser(auth, id, userId, { role: AlbumUserRole.Editor });

      expect(mocks.albumContainer.updateUserRole).toHaveBeenCalledWith(id, userId, AlbumUserRole.Editor);
    });
  });
});
