import { Injectable } from '@nestjs/common';
import { AssetResponseDto, mapAsset } from 'src/dtos/asset-response.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { BaseService } from 'src/services/base.service.js';
import { LockService } from 'src/services/lock.service.js';
import { NO_REVEALED_LOCKS } from 'src/utils/lock-visibility.js';

@Injectable()
export class ViewService extends BaseService {
  async getUniqueOriginalPaths(auth: AuthDto): Promise<string[]> {
    return this.viewRepository.getUniqueOriginalPaths(auth.user.id, await this.getLockVisibility(auth));
  }

  async getAssetsByOriginalPath(auth: AuthDto, path: string): Promise<AssetResponseDto[]> {
    const lockVisibility = await this.getLockVisibility(auth);
    const assets = await this.viewRepository.getAssetsByOriginalPath(auth.user.id, path, lockVisibility);
    // Fork (R56): a listed still never enumerates a hidden motion part (same entries as the list).
    const visible = await BaseService.create(LockService, this).withholdHiddenMotionIds(assets, lockVisibility);
    return visible.map((asset) => mapAsset(asset, { auth }));
  }

  private getLockVisibility(auth: AuthDto) {
    return this.lockRepository.getOwnerLockVisibility({
      viewerId: auth.user.id,
      ownerIds: [auth.user.id],
      revealed: auth.revealedLocks ?? NO_REVEALED_LOCKS,
      isElevated: !!auth.session?.hasElevatedPermission,
    });
  }
}
