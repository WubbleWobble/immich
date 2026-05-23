import { BadRequestException, Injectable } from '@nestjs/common';
import { AuthDto } from 'src/dtos/auth.dto';
import { SmartAlbumFilter } from 'src/dtos/smart-album-filter.dto';
import { TimeBucketAssetDto, TimeBucketDto, TimeBucketsResponseDto } from 'src/dtos/time-bucket.dto';
import { AlbumKind, AlbumUserRole, AssetVisibility, Permission } from 'src/enum';
import { TimeBucketOptions } from 'src/repositories/asset.repository';
import { BaseService } from 'src/services/base.service';
import { requireElevatedPermission } from 'src/utils/access';
import { getMyPartnerIds } from 'src/utils/asset.util';

// v1 cap on smart-album asset enumeration for timeline bucketing.
// TODO: replace with streaming/pagination once we have a stable cursor in the timeline API.
const SMART_ALBUM_TIMELINE_PAGE_SIZE = 1000;

interface SmartAlbumContext {
  filter: SmartAlbumFilter;
  ownerId: string;
}

@Injectable()
export class TimelineService extends BaseService {
  async getTimeBuckets(auth: AuthDto, dto: TimeBucketDto): Promise<TimeBucketsResponseDto[]> {
    await this.timeBucketChecks(auth, dto);
    const timeBucketOptions = await this.buildTimeBucketOptions(auth, dto);

    const smart = await this.loadSmartAlbumContext(dto.albumId);
    if (smart) {
      const ids = await this.getSmartAlbumAssetIds(smart);
      if (ids.length === 0) {
        return [];
      }
      return await this.assetRepository.getTimeBuckets({
        ...timeBucketOptions,
        albumId: undefined,
        assetIds: ids,
      });
    }

    return await this.assetRepository.getTimeBuckets(timeBucketOptions);
  }

  // pre-jsonified response
  async getTimeBucket(auth: AuthDto, dto: TimeBucketAssetDto): Promise<string> {
    await this.timeBucketChecks(auth, dto);
    const timeBucketOptions = await this.buildTimeBucketOptions(auth, { ...dto });

    const smart = await this.loadSmartAlbumContext(dto.albumId);
    if (smart) {
      const range = parseBucketDateRange(dto.timeBucket);
      const ids = await this.getSmartAlbumAssetIds(smart, range);
      if (ids.length === 0) {
        return emptyTimeBucketAssets();
      }
      const bucket = await this.assetRepository.getTimeBucket(
        dto.timeBucket,
        { ...timeBucketOptions, albumId: undefined, assetIds: ids },
        auth,
      );
      return bucket.assets;
    }

    // TODO: use id cursor for pagination
    const bucket = await this.assetRepository.getTimeBucket(dto.timeBucket, timeBucketOptions, auth);
    return bucket.assets;
  }

  private async loadSmartAlbumContext(albumId: string | undefined): Promise<SmartAlbumContext | null> {
    if (!albumId) {
      return null;
    }
    const album = await this.albumRepository.getById(albumId, { withAssets: false });
    if (!album || album.kind !== AlbumKind.Smart || !album.filter) {
      return null;
    }
    const ownerId = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)?.user.id;
    if (!ownerId) {
      return null;
    }
    return { filter: album.filter, ownerId };
  }

  private async getSmartAlbumAssetIds(
    { filter, ownerId }: SmartAlbumContext,
    range?: { takenAfter: Date; takenBefore: Date },
  ): Promise<string[]> {
    const { items } = await this.searchRepository.searchMetadata(
      { page: 1, size: SMART_ALBUM_TIMELINE_PAGE_SIZE },
      { ...filter, ...range, userIds: [ownerId] },
    );
    return items.map((item) => item.id);
  }

  private async buildTimeBucketOptions(auth: AuthDto, dto: TimeBucketDto): Promise<TimeBucketOptions> {
    const { userId, ...options } = dto;
    let userIds: string[] | undefined = undefined;

    if (userId) {
      userIds = [userId];
      if (dto.withPartners) {
        const partnerIds = await getMyPartnerIds({
          userId: auth.user.id,
          repository: this.partnerRepository,
          timelineEnabled: true,
        });
        userIds.push(...partnerIds);
      }
    }

    return { ...options, userIds };
  }

  private async timeBucketChecks(auth: AuthDto, dto: TimeBucketDto) {
    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }

    if (dto.albumId) {
      await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [dto.albumId] });
    } else {
      dto.userId = dto.userId || auth.user.id;
    }

    if (dto.userId) {
      await this.requireAccess({ auth, permission: Permission.TimelineRead, ids: [dto.userId] });
      if (dto.visibility === AssetVisibility.Archive) {
        await this.requireAccess({ auth, permission: Permission.ArchiveRead, ids: [dto.userId] });
      }
    }

    if (dto.tagId) {
      await this.requireAccess({ auth, permission: Permission.TagRead, ids: [dto.tagId] });
    }

    if (dto.withPartners) {
      const requestedArchived = dto.visibility === AssetVisibility.Archive || dto.visibility === undefined;
      const requestedFavorite = dto.isFavorite === true || dto.isFavorite === false;
      const requestedTrash = dto.isTrashed === true;

      if (requestedArchived || requestedFavorite || requestedTrash) {
        throw new BadRequestException(
          'withPartners is only supported for non-archived, non-trashed, non-favorited assets',
        );
      }
    }
  }
}

// Time buckets are month-truncated (YYYY-MM-01). Parse into a half-open [start, nextMonth) range
// for the search query's takenAfter/takenBefore constraints.
function parseBucketDateRange(timeBucket: string): { takenAfter: Date; takenBefore: Date } {
  // Strip any +/- prefix used elsewhere in the asset repo.
  const normalized = timeBucket.replace(/^[+-]/, '');
  const start = new Date(`${normalized}T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return { takenAfter: start, takenBefore: end };
}

// Matches the JSON shape produced by AssetRepository.getTimeBucket so the
// client sees an indistinguishable empty bucket whether served by search or by the asset join.
function emptyTimeBucketAssets(): string {
  return JSON.stringify({
    city: [],
    country: [],
    duration: [],
    id: [],
    visibility: [],
    isFavorite: [],
    isImage: [],
    isTrashed: [],
    livePhotoVideoId: [],
    fileCreatedAt: [],
    localOffsetHours: [],
    createdAt: [],
    ownerId: [],
    projectionType: [],
    ratio: [],
    status: [],
    thumbhash: [],
  });
}
