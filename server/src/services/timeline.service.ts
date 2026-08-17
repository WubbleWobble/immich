import { BadRequestException, Injectable } from '@nestjs/common';
import { AuthDto } from 'src/dtos/auth.dto';
import { toEvaluableSmartAlbumFilter } from 'src/dtos/smart-album-filter.dto';
import { TimeBucketAssetDto, TimeBucketDto, TimeBucketsResponseDto } from 'src/dtos/time-bucket.dto';
import { AlbumKind, AlbumUserRole, AssetVisibility, Permission } from 'src/enum';
import { TimeBucketOptions } from 'src/repositories/asset.repository';
import { AssetSearchBuilderOptions } from 'src/repositories/search.repository';
import { BaseService } from 'src/services/base.service';
import { requireElevatedPermission } from 'src/utils/access';
import { getMyPartnerIds } from 'src/utils/asset.util';

interface SmartAlbumContext {
  /** Owner-scoped membership filter, or null when the album must present as empty. */
  assetFilter: AssetSearchBuilderOptions | null;
}

@Injectable()
export class TimelineService extends BaseService {
  async getTimeBuckets(auth: AuthDto, dto: TimeBucketDto): Promise<TimeBucketsResponseDto[]> {
    await this.timeBucketChecks(auth, dto);
    const timeBucketOptions = await this.buildTimeBucketOptions(auth, dto);

    // Smart-album membership rides along as an id subquery (assetFilter), so every other
    // request option - orderBy, personId, tagId, favorites, visibility, bbox - still applies,
    // and no per-asset id list is materialized. The membership subquery enforces the filter's
    // own visibility (timeline by default), so it intersects correctly with the request's.
    const smart = await this.loadSmartAlbumContext(dto.albumId);
    if (smart) {
      if (!smart.assetFilter) {
        return [];
      }
      return await this.assetRepository.getTimeBuckets({
        ...timeBucketOptions,
        albumId: undefined,
        assetFilter: smart.assetFilter,
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
      // An empty-presenting smart album still needs the repository's empty-bucket JSON
      // shape; assetIds: [] matches nothing while keeping the payload authoritative.
      const bucket = await this.assetRepository.getTimeBucket(
        dto.timeBucket,
        {
          ...timeBucketOptions,
          albumId: undefined,
          ...(smart.assetFilter ? { assetFilter: smart.assetFilter } : { assetIds: [] }),
        },
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
    if (!album || album.kind !== AlbumKind.Smart) {
      return null;
    }
    // Fail closed: a smart album with a missing/unevaluable filter (e.g. a legacy row whose
    // only fields were sanitized away) or no resolvable owner presents as EMPTY. It must not
    // fall through to the album_asset path - smart albums are supposed to have no rows
    // there, but legacy/corrupt rows would otherwise become visible.
    const ownerId = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)?.user.id;
    const filter = album.filter && ownerId ? toEvaluableSmartAlbumFilter(album.filter) : null;
    return { assetFilter: filter && ownerId ? { ...filter, userIds: [ownerId] } : null };
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
