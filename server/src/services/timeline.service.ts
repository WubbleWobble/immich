import { BadRequestException, Injectable } from '@nestjs/common';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { toEvaluableSmartAlbumFilter } from 'src/dtos/smart-album-filter.dto.js';
import { TimeBucketAssetDto, TimeBucketDto, TimeBucketsResponseDto } from 'src/dtos/time-bucket.dto.js';
import { AlbumKind, AlbumUserRole, AssetVisibility, Permission } from 'src/enum.js';
import { TimeBucketOptions } from 'src/repositories/asset.repository.js';
import { AssetSearchBuilderOptions } from 'src/repositories/search.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { LockService } from 'src/services/lock.service.js';
import { requireElevatedPermission } from 'src/utils/access.js';
import { getMyPartnerIds } from 'src/utils/asset.util.js';
import { OwnerLockVisibility } from 'src/utils/database.js';
import { NO_REVEALED_LOCKS } from 'src/utils/lock-visibility.js';

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
      return await this.assetRepository.getTimeBuckets(
        {
          ...timeBucketOptions,
          albumId: undefined,
          assetFilter: smart.assetFilter,
        },
        auth,
      );
    }

    // Album-scoped views are deliberately not lock-filtered (spec §8.4): the album is the
    // container being inspected.
    if (dto.albumId) {
      return await this.assetRepository.getTimeBuckets(timeBucketOptions, auth);
    }

    // Person timelines also include assets in albums shared with the viewer (upstream 28bd3a550). Those follow
    // album-grant rules in the repository: only the viewer's own entry (its hidden shares) applies to them.
    return await this.assetRepository.getTimeBuckets(
      {
        ...timeBucketOptions,
        lockVisibility: await this.getLockVisibility(auth, timeBucketOptions.userIds),
        hiddenSharedAlbumIds: await this.getHiddenSharedAlbumIds(auth, timeBucketOptions),
      },
      auth,
    );
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
    const bucket = await this.assetRepository.getTimeBucket(
      dto.timeBucket,
      dto.albumId
        ? timeBucketOptions
        : {
            ...timeBucketOptions,
            lockVisibility: await this.getLockVisibility(auth, timeBucketOptions.userIds),
            hiddenSharedAlbumIds: await this.getHiddenSharedAlbumIds(auth, timeBucketOptions),
          },
      auth,
    );
    return bucket.assets;
  }

  /**
   * Locked-content filter for non-album timeline views (main timeline, partner, person, tag
   * buckets). Each owner in the query contributes their OWN lock state; the viewer's reveal
   * set applies only to the viewer's own locks and only in an elevated session. Album-scoped
   * views are deliberately not filtered: an album the viewer can open IS the container being
   * inspected (spec §8.4).
   *
   * Person timelines (personId) also return assets in albums shared with the viewer, whose owners need no entry:
   * album grants are unaffected by the album owner's locks (spec §4, ruling R19); the viewer's own entry drops the
   * shares the viewer locked for themselves.
   */
  private async getLockVisibility(
    auth: AuthDto,
    ownerIds: string[] | undefined,
  ): Promise<OwnerLockVisibility[] | undefined> {
    const owners = ownerIds && ownerIds.length > 0 ? ownerIds : [auth.user.id];
    const entries = await this.lockRepository.getOwnerLockVisibility({
      viewerId: auth.user.id,
      ownerIds: owners,
      revealed: auth.revealedLocks ?? NO_REVEALED_LOCKS,
      isElevated: !!auth.session?.hasElevatedPermission,
    });
    return entries.length > 0 ? entries : undefined;
  }

  /**
   * Person timelines grant assets in albums shared with the viewer (album-grant rules): only the viewer's own
   * effectively hidden albums withhold that grant (spec §15.1; reveal only when elevated), whoever else locked them.
   */
  private async getHiddenSharedAlbumIds(auth: AuthDto, options: TimeBucketOptions): Promise<string[] | undefined> {
    if (!options.personId || !(await this.lockRepository.hasAnyLocks(auth.user.id))) {
      return undefined;
    }
    const isElevated = !!auth.session?.hasElevatedPermission;
    return this.lockRepository.getHiddenAlbumIds(
      auth.user.id,
      isElevated ? (auth.revealedLocks ?? NO_REVEALED_LOCKS) : NO_REVEALED_LOCKS,
    );
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
    let userIds: string[] | undefined;

    if (userId) {
      userIds = [userId];
      if (dto.withPartners) {
        const partnerIds = await getMyPartnerIds({
          userId: auth.user.id,
          repository: this.partnerRepository,
          timelineEnabled: !options.personId || undefined,
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
      // Album-scoped asset queries are not lock-filtered, so the album itself must be
      // unreachable for its locker outside an elevated session.
      await BaseService.create(LockService, this).assertAlbumVisibleForViewer(auth, dto.albumId);
    } else {
      dto.userId ||= auth.user.id;
    }

    if (dto.userId) {
      await this.requireAccess({ auth, permission: Permission.TimelineRead, ids: [dto.userId] });
      if (dto.visibility === AssetVisibility.Archive) {
        await this.requireAccess({ auth, permission: Permission.ArchiveRead, ids: [dto.userId] });
      }
      if (dto.visibility === AssetVisibility.Locked && dto.userId !== auth.user.id) {
        throw new BadRequestException("You may not access another user's locked timeline");
      }
    }

    if (dto.tagId) {
      await this.requireAccess({ auth, permission: Permission.TagRead, ids: [dto.tagId] });
    }

    if (auth.sharedLink && !auth.sharedLink.showExif) {
      dto.withCoordinates = false;
    }

    // eslint-disable-next-line unicorn/prefer-early-return
    if (dto.withPartners) {
      const isRequestedLocked = dto.visibility === AssetVisibility.Locked;
      const isRequestedArchived = dto.visibility === AssetVisibility.Archive || dto.visibility === undefined;
      const isRequestedFavorite = dto.isFavorite === true || dto.isFavorite === false;
      const isRequestedTrash = dto.isTrashed === true;

      if (isRequestedLocked || isRequestedArchived || isRequestedFavorite || isRequestedTrash) {
        throw new BadRequestException(
          'withPartners is only supported for non-archived, non-trashed, non-favorited, non-locked assets',
        );
      }
    }
  }
}
