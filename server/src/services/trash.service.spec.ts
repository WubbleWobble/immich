import { BadRequestException } from '@nestjs/common';
import { JobName, JobStatus } from 'src/enum.js';
import { TrashService } from 'src/services/trash.service.js';
import { OwnerLockVisibility } from 'src/utils/database.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

// Fork (ruling R65): the owner's own-lock entries, as LockRepository.getOwnerLockVisibility returns them.
const ownLocks: OwnerLockVisibility[] = [
  { ownerId: 'user-id', hiddenAlbumIds: ['locked-album'], hiddenSmartFilters: [], visibleSmartFilters: [] },
];

async function* makeAssetIdStream(count: number): AsyncIterableIterator<{ id: string }> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
    yield { id: `asset-${i + 1}` };
  }
}

describe(TrashService.name, () => {
  let sut: TrashService;
  let mocks: ServiceMocks;

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  beforeEach(() => {
    ({ sut, mocks } = newTestService(TrashService));
    mocks.lock.getOwnerLockVisibility.mockResolvedValue([]);
  });

  describe('restoreAssets', () => {
    it('should require asset restore access for all ids', async () => {
      await expect(
        sut.restoreAssets(authStub.user1, {
          ids: ['asset-1'],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should handle an empty list', async () => {
      await expect(sut.restoreAssets(authStub.user1, { ids: [] })).resolves.toEqual({ count: 0 });
      expect(mocks.access.asset.checkOwnerAccess).not.toHaveBeenCalled();
    });

    it('should restore a batch of assets', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset1', 'asset2']));
      mocks.trash.restoreAll.mockResolvedValue(0);

      await sut.restoreAssets(authStub.user1, { ids: ['asset1', 'asset2'] });

      expect(mocks.trash.restoreAll).toHaveBeenCalledWith(['asset1', 'asset2']);
      expect(mocks.job.queue.mock.calls).toEqual([]);
    });
  });

  describe('restore', () => {
    it('should handle an empty trash', async () => {
      mocks.trash.getDeletedIds.mockResolvedValue(makeAssetIdStream(0));
      mocks.trash.restore.mockResolvedValue(0);
      await expect(sut.restore(authStub.user1)).resolves.toEqual({ count: 0 });
      expect(mocks.trash.restore).toHaveBeenCalledWith('user-id', []);
    });

    it('should restore', async () => {
      mocks.trash.getDeletedIds.mockResolvedValue(makeAssetIdStream(1));
      mocks.trash.restore.mockResolvedValue(1);
      await expect(sut.restore(authStub.user1)).resolves.toEqual({ count: 1 });
      expect(mocks.trash.restore).toHaveBeenCalledWith('user-id', []);
    });

    // Fork (ruling R65): bulk restore follows the owner's own locks outside elevation.
    it('should pass the owner lock entries so hidden trashed assets are skipped', async () => {
      const auth = AuthFactory.from({ id: 'user-id' }).session({ hasElevatedPermission: false }).build();
      mocks.lock.getOwnerLockVisibility.mockResolvedValue(ownLocks);
      mocks.trash.restore.mockResolvedValue(1);

      await expect(sut.restore(auth)).resolves.toEqual({ count: 1 });

      expect(mocks.lock.getOwnerLockVisibility).toHaveBeenCalledWith({
        viewerId: 'user-id',
        ownerIds: ['user-id'],
        revealed: { albumIds: [], containerIds: [] },
        isElevated: false,
      });
      expect(mocks.trash.restore).toHaveBeenCalledWith('user-id', ownLocks);
    });

    it('should restore every trashed asset in an elevated session', async () => {
      const auth = AuthFactory.from({ id: 'user-id' }).session({ hasElevatedPermission: true }).build();
      mocks.trash.restore.mockResolvedValue(2);

      await expect(sut.restore(auth)).resolves.toEqual({ count: 2 });

      expect(mocks.lock.getOwnerLockVisibility).not.toHaveBeenCalled();
      expect(mocks.trash.restore).toHaveBeenCalledWith('user-id', []);
    });
  });

  describe('empty', () => {
    it('should handle an empty trash', async () => {
      mocks.trash.getDeletedIds.mockResolvedValue(makeAssetIdStream(0));
      mocks.trash.empty.mockResolvedValue(0);
      await expect(sut.empty(authStub.user1)).resolves.toEqual({ count: 0 });
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should empty the trash', async () => {
      mocks.trash.getDeletedIds.mockResolvedValue(makeAssetIdStream(1));
      mocks.trash.empty.mockResolvedValue(1);
      await expect(sut.empty(authStub.user1)).resolves.toEqual({ count: 1 });
      expect(mocks.trash.empty).toHaveBeenCalledWith('user-id', []);
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.AssetEmptyTrash, data: {} });
    });

    // Fork (ruling R65): bulk empty follows the owner's own locks outside elevation.
    it('should pass the owner lock entries so hidden trashed assets are skipped', async () => {
      const auth = AuthFactory.from({ id: 'user-id' }).session({ hasElevatedPermission: false }).build();
      mocks.lock.getOwnerLockVisibility.mockResolvedValue(ownLocks);
      mocks.trash.empty.mockResolvedValue(0);

      await expect(sut.empty(auth)).resolves.toEqual({ count: 0 });

      expect(mocks.trash.empty).toHaveBeenCalledWith('user-id', ownLocks);
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should empty every trashed asset in an elevated session', async () => {
      const auth = AuthFactory.from({ id: 'user-id' }).session({ hasElevatedPermission: true }).build();
      mocks.trash.empty.mockResolvedValue(2);

      await expect(sut.empty(auth)).resolves.toEqual({ count: 2 });

      expect(mocks.lock.getOwnerLockVisibility).not.toHaveBeenCalled();
      expect(mocks.trash.empty).toHaveBeenCalledWith('user-id', []);
    });
  });

  describe('onAssetsDelete', () => {
    it('should queue the empty trash job', async () => {
      await expect(sut.onAssetsDelete()).resolves.toBeUndefined();
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.AssetEmptyTrash, data: {} });
    });
  });

  describe('handleQueueEmptyTrash', () => {
    it('should queue asset delete jobs', async () => {
      mocks.trash.getDeletedIds.mockReturnValue(makeAssetIdStream(1));
      await expect(sut.handleEmptyTrash()).resolves.toEqual(JobStatus.Success);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.AssetDelete,
          data: { id: 'asset-1', deleteOnDisk: true },
        },
      ]);
    });
  });
});
