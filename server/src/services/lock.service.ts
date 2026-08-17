import { BadRequestException, Injectable } from '@nestjs/common';
import { AuthDto } from 'src/dtos/auth.dto';
import { LocksResponseDto } from 'src/dtos/lock.dto';
import { Permission } from 'src/enum';
import { BaseService } from 'src/services/base.service';
import { requireElevatedPermission } from 'src/utils/access';

/**
 * Per-user lock toggles for albums and folders. Every operation - including reads - requires
 * an elevated (PIN-verified) session: lock state must not be enumerable by whoever happens
 * to hold an unlocked device (plausible deniability, spec §8.5/§9).
 */
@Injectable()
export class LockService extends BaseService {
  async lockAlbum(auth: AuthDto, albumId: string): Promise<void> {
    requireElevatedPermission(auth);
    // Read access (owner or sharee) is enough: sharees may lock a shared album for
    // themselves without affecting anyone else's view.
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [albumId] });
    await this.lockRepository.lockAlbum(auth.user.id, albumId);
  }

  async unlockAlbum(auth: AuthDto, albumId: string): Promise<void> {
    requireElevatedPermission(auth);
    // No access check: deleting one's own lock row is always safe, and a user who lost
    // access to an album must still be able to clean up their stale lock.
    await this.lockRepository.unlockAlbum(auth.user.id, albumId);
  }

  async lockContainer(auth: AuthDto, containerId: string): Promise<void> {
    requireElevatedPermission(auth);
    const hasAccess = await this.albumContainerRepository.hasAccess(containerId, auth.user.id);
    if (!hasAccess) {
      throw new BadRequestException('Not found or no albumContainer.read access');
    }
    await this.lockRepository.lockContainer(auth.user.id, containerId);
  }

  async unlockContainer(auth: AuthDto, containerId: string): Promise<void> {
    requireElevatedPermission(auth);
    await this.lockRepository.unlockContainer(auth.user.id, containerId);
  }

  async getLocks(auth: AuthDto): Promise<LocksResponseDto> {
    requireElevatedPermission(auth);
    return this.lockRepository.getLocks(auth.user.id);
  }
}
