import { BadRequestException, ForbiddenException } from '@nestjs/common';
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
      mocks.albumContainer.isDescendantOf.mockResolvedValue(true);

      await expect(sut.update(auth, id, { parentId: descendantId })).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.albumContainer.move).not.toHaveBeenCalled();
    });

    it('rejects move that exceeds depth limit', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
      const id = newUuid();
      const newParentId = newUuid();
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
      mocks.albumContainer.isDescendantOf.mockResolvedValue(false);
      mocks.albumContainer.getDepth.mockResolvedValue(16);

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
        .mockResolvedValueOnce({ ...container, parentId: newParentId });
      mocks.albumContainer.isDescendantOf.mockResolvedValue(false);
      mocks.albumContainer.getDepth.mockResolvedValue(2);
      mocks.albumContainer.move.mockResolvedValue({ ...container, parentId: newParentId });

      const result = await sut.update(auth, id, { parentId: newParentId });

      expect(mocks.albumContainer.move).toHaveBeenCalledWith(id, newParentId);
      expect(result.parentId).toEqual(newParentId);
    });
  });

  describe('share', () => {
    it('adds a user share when called by owner', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create({ id: owner.id });
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

      await sut.addUser(auth, id, { userId: sharedUserId, role: AlbumUserRole.Editor });

      expect(mocks.albumContainer.addUser).toHaveBeenCalledWith(id, sharedUserId, AlbumUserRole.Editor);
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

      await expect(
        sut.addUser(auth, id, { userId: sharedUserId, role: AlbumUserRole.Editor }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.albumContainer.addUser).not.toHaveBeenCalled();
    });
  });
});
