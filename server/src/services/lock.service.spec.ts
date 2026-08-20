import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { LockService } from 'src/services/lock.service';
import { AuthFactory } from 'test/factories/auth.factory';
import { newUuid } from 'test/small.factory';
import { newTestService, ServiceMocks } from 'test/utils';

const elevated = () => AuthFactory.from().session({ hasElevatedPermission: true }).build();
const notElevated = () => AuthFactory.from().session({ hasElevatedPermission: false }).build();

describe(LockService.name, () => {
  let sut: LockService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(LockService));
  });

  describe('lockAlbum', () => {
    it('rejects a non-elevated session before anything else', async () => {
      await expect(sut.lockAlbum(notElevated(), newUuid())).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mocks.lock.lockAlbum).not.toHaveBeenCalled();
      // No access check either: an unauthenticated-for-locks caller learns nothing about
      // whether the album exists.
      expect(mocks.access.album.checkOwnerAccess).not.toHaveBeenCalled();
    });

    it('rejects an album the user cannot read', async () => {
      const auth = elevated();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set());

      await expect(sut.lockAlbum(auth, newUuid())).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.lock.lockAlbum).not.toHaveBeenCalled();
    });

    it('locks an accessible album for the requesting user only', async () => {
      const auth = elevated();
      const albumId = newUuid();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([albumId]));

      await sut.lockAlbum(auth, albumId);

      expect(mocks.lock.lockAlbum).toHaveBeenCalledWith(auth.user.id, albumId);
    });

    it('allows a sharee to lock a shared album for themselves', async () => {
      const auth = elevated();
      const albumId = newUuid();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set([albumId]));

      await sut.lockAlbum(auth, albumId);

      expect(mocks.lock.lockAlbum).toHaveBeenCalledWith(auth.user.id, albumId);
    });
  });

  describe('unlockAlbum', () => {
    it('rejects a non-elevated session', async () => {
      await expect(sut.unlockAlbum(notElevated(), newUuid())).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mocks.lock.unlockAlbum).not.toHaveBeenCalled();
    });

    it('deletes the row without an access check (stale-lock cleanup)', async () => {
      const auth = elevated();
      const albumId = newUuid();

      await sut.unlockAlbum(auth, albumId);

      expect(mocks.lock.unlockAlbum).toHaveBeenCalledWith(auth.user.id, albumId);
      expect(mocks.access.album.checkOwnerAccess).not.toHaveBeenCalled();
    });
  });

  describe('lockContainer', () => {
    it('rejects a non-elevated session', async () => {
      await expect(sut.lockContainer(notElevated(), newUuid())).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mocks.lock.lockContainer).not.toHaveBeenCalled();
    });

    it('rejects a folder the user cannot access', async () => {
      const auth = elevated();
      mocks.albumContainer.hasAccess.mockResolvedValue(false);

      await expect(sut.lockContainer(auth, newUuid())).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.lock.lockContainer).not.toHaveBeenCalled();
    });

    it('locks an accessible folder', async () => {
      const auth = elevated();
      const containerId = newUuid();
      mocks.albumContainer.hasAccess.mockResolvedValue(true);

      await sut.lockContainer(auth, containerId);

      expect(mocks.lock.lockContainer).toHaveBeenCalledWith(auth.user.id, containerId);
    });
  });

  describe('unlockContainer', () => {
    it('rejects a non-elevated session', async () => {
      await expect(sut.unlockContainer(notElevated(), newUuid())).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mocks.lock.unlockContainer).not.toHaveBeenCalled();
    });

    it('deletes the row without an access check', async () => {
      const auth = elevated();
      const containerId = newUuid();

      await sut.unlockContainer(auth, containerId);

      expect(mocks.lock.unlockContainer).toHaveBeenCalledWith(auth.user.id, containerId);
    });
  });

  describe('assertAlbumVisibleForViewer', () => {
    it('passes through for elevated sessions and shared-link visitors', async () => {
      mocks.lock.isAlbumHiddenForViewer.mockResolvedValue(true);

      await expect(sut.assertAlbumVisibleForViewer(elevated(), newUuid())).resolves.toBeUndefined();

      const linkAuth = AuthFactory.from().sharedLink().build();
      await expect(sut.assertAlbumVisibleForViewer(linkAuth, newUuid())).resolves.toBeUndefined();
    });

    it('blocks a hidden album for its locker outside an elevated session', async () => {
      mocks.lock.isAlbumHiddenForViewer.mockResolvedValue(true);
      await expect(sut.assertAlbumVisibleForViewer(notElevated(), newUuid())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('passes for albums the viewer has not hidden', async () => {
      mocks.lock.isAlbumHiddenForViewer.mockResolvedValue(false);
      await expect(sut.assertAlbumVisibleForViewer(notElevated(), newUuid())).resolves.toBeUndefined();
    });
  });

  describe('assertContainerVisibleForViewer', () => {
    it('blocks a hidden folder for its locker outside an elevated session', async () => {
      mocks.lock.isContainerHiddenForViewer.mockResolvedValue(true);
      await expect(sut.assertContainerVisibleForViewer(notElevated(), newUuid())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('passes through for elevated sessions', async () => {
      mocks.lock.isContainerHiddenForViewer.mockResolvedValue(true);
      await expect(sut.assertContainerVisibleForViewer(elevated(), newUuid())).resolves.toBeUndefined();
    });
  });

  describe('moveAssetsToLockedAlbum', () => {
    it('rejects a non-elevated session before anything else', async () => {
      await expect(
        sut.moveAssetsToLockedAlbum(notElevated(), { albumId: newUuid(), assetIds: [newUuid()] }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mocks.lock.isAlbumHiddenForViewer).not.toHaveBeenCalled();
    });

    it('rejects a destination the user has not locked', async () => {
      const auth = elevated();
      mocks.lock.isAlbumHiddenForViewer.mockResolvedValue(false);

      await expect(
        sut.moveAssetsToLockedAlbum(auth, { albumId: newUuid(), assetIds: [newUuid()] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.album.getVisibleMembershipsByAssetIds).not.toHaveBeenCalled();
    });
  });

  describe('getLocks', () => {
    it('rejects a non-elevated session (locks must not be enumerable without the PIN)', async () => {
      await expect(sut.getLocks(notElevated())).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mocks.lock.getLocks).not.toHaveBeenCalled();
    });

    it('returns only the locks of the requesting user', async () => {
      const auth = elevated();
      const locks = { lockedAlbumIds: [newUuid()], lockedContainerIds: [] };
      mocks.lock.getLocks.mockResolvedValue(locks);

      await expect(sut.getLocks(auth)).resolves.toEqual(locks);
      expect(mocks.lock.getLocks).toHaveBeenCalledWith(auth.user.id);
    });
  });
});
