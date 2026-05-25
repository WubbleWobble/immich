import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AlbumUserRole } from 'src/enum';
import { AlbumContainerService } from 'src/services/album-container.service';
import { AuthFactory } from 'test/factories/auth.factory';
import { UserFactory } from 'test/factories/user.factory';
import { newUuid } from 'test/small.factory';
import { newTestService, ServiceMocks } from 'test/utils';
import { beforeEach, describe, expect, it } from 'vitest';

describe(AlbumContainerService.name, () => {
  let sut: AlbumContainerService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(AlbumContainerService));
  });

  describe('list', () => {
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
      expect(result.albumContainerUsers[0].userId).toEqual(sharedUser.id);
      expect(result.albumContainerUsers[0].role).toEqual(AlbumUserRole.Viewer);
      expect(result.albumContainerUsers[0].user.id).toEqual(sharedUser.id);
    });

    it('throws NotFoundException when folder does not exist', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      mocks.albumContainer.getById.mockResolvedValue(void 0);

      await expect(sut.get(auth, newUuid())).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws ForbiddenException when called by non-owner', async () => {
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

      await expect(sut.get(auth, id)).rejects.toBeInstanceOf(ForbiddenException);
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
      mocks.albumContainer.getById
        .mockResolvedValueOnce(source)
        .mockResolvedValueOnce({ ...source, id: descendantId });
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
      mocks.albumContainer.getById
        .mockResolvedValueOnce(source)
        .mockResolvedValueOnce({ ...source, id: newParentId });
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
      mocks.albumContainer.getById
        .mockResolvedValueOnce(source)
        .mockResolvedValueOnce({ ...source, id: newParentId });
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

      await expect(
        sut.addUser(auth, id, { userId: newUuid(), role: AlbumUserRole.Owner }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.albumContainer.addUser).not.toHaveBeenCalled();
    });

    it('rejects share with self', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      const id = newUuid();
      mocks.albumContainer.getById.mockResolvedValue(folderForOwner(owner.id, id));

      await expect(
        sut.addUser(auth, id, { userId: owner.id, role: AlbumUserRole.Editor }),
      ).rejects.toBeInstanceOf(BadRequestException);
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
      });

      await expect(
        sut.addUser(auth, id, { userId: sharedUser.id, role: AlbumUserRole.Editor }),
      ).rejects.toBeInstanceOf(BadRequestException);
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

      await expect(
        sut.addUser(auth, id, { userId, role: AlbumUserRole.Editor }),
      ).rejects.toBeInstanceOf(BadRequestException);
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
});
