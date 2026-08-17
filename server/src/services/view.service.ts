import { Injectable } from '@nestjs/common';
import { AssetResponseDto, mapAsset } from 'src/dtos/asset-response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { BaseService } from 'src/services/base.service';
import { NO_REVEALED_LOCKS } from 'src/utils/lock-visibility';

@Injectable()
export class ViewService extends BaseService {
  async getUniqueOriginalPaths(auth: AuthDto): Promise<string[]> {
    return this.viewRepository.getUniqueOriginalPaths(auth.user.id, await this.getLockVisibility(auth));
  }

  async getAssetsByOriginalPath(auth: AuthDto, path: string): Promise<AssetResponseDto[]> {
    const assets = await this.viewRepository.getAssetsByOriginalPath(
      auth.user.id,
      path,
      await this.getLockVisibility(auth),
    );
    return assets.map((asset) => mapAsset(asset, { auth }));
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
