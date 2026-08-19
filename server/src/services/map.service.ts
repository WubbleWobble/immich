import { Injectable } from '@nestjs/common';
import { AuthDto } from 'src/dtos/auth.dto';
import { MapMarkerDto, MapMarkerResponseDto, MapReverseGeocodeDto } from 'src/dtos/map.dto';
import { BaseService } from 'src/services/base.service';
import { getMyPartnerIds } from 'src/utils/asset.util';
import { NO_REVEALED_LOCKS } from 'src/utils/lock-visibility';

@Injectable()
export class MapService extends BaseService {
  async getMapMarkers(auth: AuthDto, options: MapMarkerDto): Promise<MapMarkerResponseDto[]> {
    const userIds = [auth.user.id];
    if (options.withPartners) {
      const partnerIds = await getMyPartnerIds({ userId: auth.user.id, repository: this.partnerRepository });
      userIds.push(...partnerIds);
    }

    let albumIds = options.withSharedAlbums ? await this.albumRepository.getAllIds(auth.user.id) : [];
    // Album-sourced markers must not reveal albums the viewer has locked away - including
    // shared albums the viewer locked for themselves (list semantics: reveal only when elevated).
    if (albumIds.length > 0 && (await this.lockRepository.hasAnyLocks(auth.user.id))) {
      const isElevated = !!auth.session?.hasElevatedPermission;
      const revealed = isElevated ? (auth.revealedLocks ?? NO_REVEALED_LOCKS) : NO_REVEALED_LOCKS;
      const hidden = new Set(await this.lockRepository.getHiddenAlbumIds(auth.user.id, revealed));
      albumIds = albumIds.filter((id) => !hidden.has(id));
    }

    const lockVisibility = await this.lockRepository.getOwnerLockVisibility({
      viewerId: auth.user.id,
      ownerIds: userIds,
      revealed: auth.revealedLocks ?? NO_REVEALED_LOCKS,
      isElevated: !!auth.session?.hasElevatedPermission,
    });

    return this.mapRepository.getMapMarkers(userIds, albumIds, options, lockVisibility);
  }

  async reverseGeocode(dto: MapReverseGeocodeDto) {
    const { lat: latitude, lon: longitude } = dto;
    // eventually this should probably return an array of results
    const result = await this.mapRepository.reverseGeocode({ latitude, longitude });
    return result ? [result] : [];
  }
}
