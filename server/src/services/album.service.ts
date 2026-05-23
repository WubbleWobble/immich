import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AddUsersDto,
  AlbumResponseDto,
  AlbumsAddAssetsDto,
  AlbumsAddAssetsResponseDto,
  AlbumStatisticsResponseDto,
  CreateAlbumDto,
  GetAlbumsDto,
  mapAlbum,
  UpdateAlbumDto,
  UpdateAlbumUserDto,
} from 'src/dtos/album.dto';
import { BulkIdErrorReason, BulkIdResponseDto, BulkIdsDto } from 'src/dtos/asset-ids.response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { MapMarkerResponseDto } from 'src/dtos/map.dto';
import { SmartAlbumFilter } from 'src/dtos/smart-album-filter.dto';
import { AlbumKind, AlbumUserRole, Permission } from 'src/enum';
import { AlbumAssetCount, AlbumInfoOptions } from 'src/repositories/album.repository';
import { BaseService } from 'src/services/base.service';
import { addAssets, removeAssets } from 'src/utils/asset.util';
import { asDateString } from 'src/utils/date';
import { getPreferences } from 'src/utils/preferences';

interface SmartAlbumCachedMetadata {
  cachedAssetCount: number;
  cachedThumbnailAssetId: string | null;
  cachedStartDate: string | null;
  cachedEndDate: string | null;
  cacheComputedAt: Date;
}

const toDateOnly = (d: Date) => d.toISOString().slice(0, 10);

const isSmartAlbumCacheStale = (album: {
  cacheComputedAt?: Date | string | null;
  cacheInvalidatedAt?: Date | string | null;
}) => {
  if (album.cacheComputedAt == null) {
    return true;
  }
  if (album.cacheInvalidatedAt == null) {
    return false;
  }
  // After hydration from a JSON-shallow context, timestamps may be strings.
  const computed =
    album.cacheComputedAt instanceof Date ? album.cacheComputedAt.getTime() : Date.parse(album.cacheComputedAt);
  const invalidated =
    album.cacheInvalidatedAt instanceof Date
      ? album.cacheInvalidatedAt.getTime()
      : Date.parse(album.cacheInvalidatedAt);
  return invalidated > computed;
};

@Injectable()
export class AlbumService extends BaseService {
  async getStatistics(auth: AuthDto): Promise<AlbumStatisticsResponseDto> {
    const [owned, shared, notShared] = await Promise.all([
      this.albumRepository.getAll(auth.user.id, { isOwned: true }),
      this.albumRepository.getAll(auth.user.id, { isShared: true }),
      this.albumRepository.getAll(auth.user.id, { isOwned: true, isShared: false }),
    ]);

    return {
      owned: owned.length,
      shared: shared.length,
      notShared: notShared.length,
    };
  }

  async getAll(
    { user: { id: ownerId } }: AuthDto,
    { assetId, isOwned, isShared }: GetAlbumsDto,
  ): Promise<AlbumResponseDto[]> {
    await this.albumRepository.updateThumbnails();

    const albums = assetId
      ? await this.albumRepository.getByAssetId(ownerId, assetId)
      : await this.albumRepository.getAll(ownerId, { isOwned, isShared });

    if (albums.length === 0) {
      return [];
    }

    // Get asset count for each album. Then map the result to an object:
    // { [albumId]: assetCount }
    const results = await this.albumRepository.getMetadataForIds(albums.map((album) => album.id));
    const albumMetadata: Record<string, AlbumAssetCount> = {};
    for (const metadata of results) {
      albumMetadata[metadata.albumId] = metadata;
    }

    // For smart albums, serve the list-view metadata (count, thumbnail, date range) from the
    // per-album cache stored on the album row. Recompute only when the cache is stale or missing.
    // See `invalidateSmartAlbumsForAsset` for the invalidation side.
    for (const album of albums) {
      if (album.kind !== AlbumKind.Smart || !album.filter) {
        continue;
      }
      if (!isSmartAlbumCacheStale(album)) {
        continue;
      }
      const albumOwnerId = album.albumUsers?.find(({ role }) => role === AlbumUserRole.Owner)?.user.id;
      if (!albumOwnerId) {
        continue;
      }
      const fresh = await this.recomputeSmartAlbumCache(album.id, albumOwnerId, album.filter);
      Object.assign(album, fresh);
    }

    return albums.map((album) => {
      const isSmart = album.kind === AlbumKind.Smart;
      return {
        ...mapAlbum(album),
        sharedLinks: undefined,
        albumThumbnailAssetId: isSmart ? (album.cachedThumbnailAssetId ?? null) : album.albumThumbnailAssetId,
        startDate: asDateString((isSmart ? album.cachedStartDate : albumMetadata[album.id]?.startDate) ?? undefined),
        endDate: asDateString((isSmart ? album.cachedEndDate : albumMetadata[album.id]?.endDate) ?? undefined),
        assetCount: isSmart ? (album.cachedAssetCount ?? 0) : (albumMetadata[album.id]?.assetCount ?? 0),
        // lastModifiedAssetTimestamp is only used in mobile app, please remove if not need
        lastModifiedAssetTimestamp: asDateString(albumMetadata[album.id]?.lastModifiedAssetTimestamp ?? undefined),
      };
    });
  }

  async get(auth: AuthDto, id: string): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });
    await this.albumRepository.updateThumbnails();
    const album = await this.findOrFail(id, auth.user.id, { withAssets: false });
    const [albumMetadataForIds] = await this.albumRepository.getMetadataForIds([album.id]);

    const hasSharedUsers = album.albumUsers && album.albumUsers.length > 1;
    const hasSharedLink = album.sharedLinks && album.sharedLinks.length > 0;
    const isShared = hasSharedUsers || hasSharedLink;

    // Single-album views always recompute. The cache exists primarily to keep the Albums *list*
    // page fast (no N searches per page); for a single-album view, the cost of one search query
    // is negligible and the freshness guarantee is worth more than the saving. Side-effect: this
    // self-heals any stale-cache state we missed via an unhooked write path.
    if (album.kind === AlbumKind.Smart && album.filter) {
      const ownerId = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)?.user.id;
      if (ownerId) {
        const fresh = await this.recomputeSmartAlbumCache(album.id, ownerId, album.filter);
        Object.assign(album, fresh);
      }
    }

    const isSmart = album.kind === AlbumKind.Smart;

    return {
      ...mapAlbum(album),
      albumThumbnailAssetId: isSmart ? (album.cachedThumbnailAssetId ?? null) : album.albumThumbnailAssetId,
      startDate: asDateString((isSmart ? album.cachedStartDate : albumMetadataForIds?.startDate) ?? undefined),
      endDate: asDateString((isSmart ? album.cachedEndDate : albumMetadataForIds?.endDate) ?? undefined),
      assetCount: isSmart ? (album.cachedAssetCount ?? 0) : (albumMetadataForIds?.assetCount ?? 0),
      lastModifiedAssetTimestamp: asDateString(albumMetadataForIds?.lastModifiedAssetTimestamp ?? undefined),
      contributorCounts: isShared ? await this.albumRepository.getContributorCounts(album.id) : undefined,
    };
  }

  async getMapMarkers(auth: AuthDto, id: string): Promise<MapMarkerResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });

    if (auth.sharedLink && !auth.sharedLink.showExif) {
      return [];
    }

    return this.mapRepository.getAlbumMapMarkers(id);
  }

  async create(auth: AuthDto, dto: CreateAlbumDto): Promise<AlbumResponseDto> {
    const albumUsers = dto.albumUsers || [];
    const kind = dto.kind ?? AlbumKind.Regular;
    const filter = kind === AlbumKind.Smart ? (dto.filter ?? null) : null;

    if (kind === AlbumKind.Smart && !dto.filter) {
      throw new BadRequestException('Smart albums require a filter');
    }

    if (kind === AlbumKind.Regular && dto.filter) {
      throw new BadRequestException('Filter is only valid for smart albums');
    }

    if (kind === AlbumKind.Smart && dto.assetIds && dto.assetIds.length > 0) {
      throw new BadRequestException('Smart albums cannot be created with initial assetIds');
    }

    for (const { userId } of albumUsers) {
      const exists = await this.userRepository.get(userId, {});
      if (!exists) {
        this.logger.debug('Album creation failed: user not found');
        throw new BadRequestException('Invalid user');
      }

      if (userId == auth.user.id) {
        throw new BadRequestException('Cannot share album with owner');
      }
    }

    const allowedAssetIdsSet = await this.checkAccess({
      auth,
      permission: Permission.AssetShare,
      ids: dto.assetIds || [],
    });
    const assetIds = [...allowedAssetIdsSet].map((id) => id);

    const userMetadata = await this.userRepository.getMetadata(auth.user.id);

    const album = await this.albumRepository.create(
      {
        albumName: dto.albumName,
        description: dto.description,
        albumThumbnailAssetId: assetIds[0] || null,
        order: getPreferences(userMetadata).albums.defaultAssetOrder,
        kind,
        filter,
      },
      assetIds,
      [{ userId: auth.user.id, role: AlbumUserRole.Owner }, ...albumUsers],
      auth.user.id,
    );

    for (const { userId } of albumUsers) {
      await this.eventRepository.emit('AlbumInvite', { id: album.id, userId, senderName: auth.user.name });
    }

    return mapAlbum(album);
  }

  async update(auth: AuthDto, id: string, dto: UpdateAlbumDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumUpdate, ids: [id] });

    const album = await this.findOrFail(id, auth.user.id, { withAssets: true });

    if ('kind' in dto && dto.kind !== undefined && dto.kind !== album.kind) {
      throw new BadRequestException('Album kind is immutable');
    }

    if (dto.filter !== undefined && album.kind !== AlbumKind.Smart) {
      throw new BadRequestException('Filter can only be set on smart albums');
    }

    if (dto.albumThumbnailAssetId) {
      const results = await this.albumRepository.getAssetIds(id, [dto.albumThumbnailAssetId]);
      if (results.size === 0) {
        throw new BadRequestException('Invalid album thumbnail');
      }
    }
    const updatedAlbum = await this.albumRepository.update(
      album.id,
      {
        id: album.id,
        albumName: dto.albumName,
        description: dto.description,
        albumThumbnailAssetId: dto.albumThumbnailAssetId,
        isActivityEnabled: dto.isActivityEnabled,
        order: dto.order,
        ...(dto.filter === undefined ? {} : { filter: dto.filter }),
      },
      auth.user.id,
    );

    return mapAlbum({ ...updatedAlbum, assets: album.assets });
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AlbumDelete, ids: [id] });
    await this.albumRepository.delete(id);
  }

  async addAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    const album = await this.findOrFail(id, auth.user.id, { withAssets: false });
    await this.requireAccess({ auth, permission: Permission.AlbumAssetCreate, ids: [id] });

    if (album.kind === AlbumKind.Smart) {
      throw new BadRequestException('Cannot add assets to a smart album');
    }

    const results = await addAssets(
      auth,
      { access: this.accessRepository, bulk: this.albumRepository },
      { parentId: id, assetIds: dto.ids },
    );

    const { id: firstNewAssetId } = results.find(({ success }) => success) || {};
    if (firstNewAssetId) {
      await this.albumRepository.update(
        id,
        {
          id,
          updatedAt: new Date(),
          albumThumbnailAssetId: album.albumThumbnailAssetId ?? firstNewAssetId,
        },
        auth.user.id,
      );

      const allUsersExceptUs = album.albumUsers.map(({ user }) => user.id).filter((userId) => userId !== auth.user.id);

      for (const recipientId of allUsersExceptUs) {
        await this.eventRepository.emit('AlbumUpdate', { id, recipientId });
      }
    }

    return results;
  }

  async addAssetsToAlbums(auth: AuthDto, dto: AlbumsAddAssetsDto): Promise<AlbumsAddAssetsResponseDto> {
    const results: AlbumsAddAssetsResponseDto = {
      success: false,
      error: BulkIdErrorReason.DUPLICATE,
    };

    const allowedAlbumIds = await this.checkAccess({
      auth,
      permission: Permission.AlbumAssetCreate,
      ids: dto.albumIds,
    });
    if (allowedAlbumIds.size === 0) {
      results.error = BulkIdErrorReason.NO_PERMISSION;
      return results;
    }

    const allowedAssetIds = await this.checkAccess({ auth, permission: Permission.AssetShare, ids: dto.assetIds });
    if (allowedAssetIds.size === 0) {
      results.error = BulkIdErrorReason.NO_PERMISSION;
      return results;
    }

    const albumAssetValues: { albumId: string; assetId: string }[] = [];
    const events: { id: string; recipients: string[] }[] = [];
    for (const albumId of allowedAlbumIds) {
      const existingAssetIds = await this.albumRepository.getAssetIds(albumId, [...allowedAssetIds]);
      const notPresentAssetIds = [...allowedAssetIds].filter((id) => !existingAssetIds.has(id));
      if (notPresentAssetIds.length === 0) {
        continue;
      }
      const album = await this.findOrFail(albumId, auth.user.id, { withAssets: false });
      results.error = undefined;
      results.success = true;

      for (const assetId of notPresentAssetIds) {
        albumAssetValues.push({ albumId, assetId });
      }
      await this.albumRepository.update(
        albumId,
        {
          id: albumId,
          updatedAt: new Date(),
          albumThumbnailAssetId: album.albumThumbnailAssetId ?? notPresentAssetIds[0],
        },
        auth.user.id,
      );
      const allUsersExceptUs = album.albumUsers.map(({ user }) => user.id).filter((userId) => userId !== auth.user.id);
      events.push({ id: albumId, recipients: allUsersExceptUs });
    }

    await this.albumRepository.addAssetIdsToAlbums(albumAssetValues);
    for (const event of events) {
      for (const recipientId of event.recipients) {
        await this.eventRepository.emit('AlbumUpdate', { id: event.id, recipientId });
      }
    }

    return results;
  }

  async removeAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AlbumAssetDelete, ids: [id] });

    const album = await this.findOrFail(id, auth.user.id, { withAssets: false });

    if (album.kind === AlbumKind.Smart) {
      throw new BadRequestException('Cannot remove assets from a smart album');
    }

    const results = await removeAssets(
      auth,
      { access: this.accessRepository, bulk: this.albumRepository },
      { parentId: id, assetIds: dto.ids, canAlwaysRemove: Permission.AlbumDelete },
    );

    const removedIds = results.filter(({ success }) => success).map(({ id }) => id);
    if (removedIds.length > 0 && album.albumThumbnailAssetId && removedIds.includes(album.albumThumbnailAssetId)) {
      await this.albumRepository.updateThumbnails();
    }

    return results;
  }

  async addUsers(auth: AuthDto, id: string, { albumUsers }: AddUsersDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });

    const album = await this.findOrFail(id, auth.user.id, { withAssets: false });

    for (const { userId, role } of albumUsers) {
      if (role === AlbumUserRole.Owner) {
        throw new BadRequestException('Cannot add another owner');
      }

      const exists = album.albumUsers.find(({ user: { id } }) => id === userId);
      if (exists) {
        throw new BadRequestException('User already added');
      }

      const user = await this.userRepository.get(userId, {});
      if (!user) {
        this.logger.debug('Adding user to album failed: user not found');
        throw new BadRequestException('Invalid user');
      }

      await this.albumUserRepository.create({ userId, albumId: id, role });
      await this.eventRepository.emit('AlbumInvite', { id, userId, senderName: auth.user.name });
    }

    return this.findOrFail(id, auth.user.id, { withAssets: true }).then(mapAlbum);
  }

  async removeUser(auth: AuthDto, id: string, userId: string | 'me'): Promise<void> {
    if (userId === 'me') {
      userId = auth.user.id;
    }

    const album = await this.findOrFail(id, auth.user.id, { withAssets: false });

    const exists = album.albumUsers.find(({ user: { id } }) => id === userId);
    if (!exists) {
      throw new BadRequestException('Album not shared with user');
    }

    if (
      exists.role === AlbumUserRole.Owner &&
      album.albumUsers.filter(({ role }) => role === AlbumUserRole.Owner).length === 1
    ) {
      throw new BadRequestException('Cannot remove the last album owner');
    }

    // non-admin can remove themselves
    if (auth.user.id !== userId) {
      await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });
    }

    await this.albumUserRepository.delete({ albumId: id, userId });
  }

  async updateUser(auth: AuthDto, id: string, userId: string, dto: UpdateAlbumUserDto): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });
    await this.albumUserRepository.update({ albumId: id, userId }, { role: dto.role });
  }

  private async findOrFail(id: string, authUserId: string, options: AlbumInfoOptions) {
    const album = await this.albumRepository.getById(id, options, authUserId);
    if (!album) {
      throw new BadRequestException('Album not found');
    }
    return album;
  }

  /**
   * Recompute smart-album list-view metadata against the live search index and persist
   * the result on the album row. Returns the freshly computed values.
   */
  private async recomputeSmartAlbumCache(
    albumId: string,
    ownerId: string,
    filter: SmartAlbumFilter,
  ): Promise<SmartAlbumCachedMetadata> {
    const { items } = await this.searchRepository.searchMetadata(
      { page: 1, size: 1000 },
      { ...filter, userIds: [ownerId] },
    );
    const dateMillis: number[] = [];
    for (const item of items) {
      const raw = item.localDateTime ?? item.fileCreatedAt;
      if (raw == null) {
        continue;
      }
      const ms = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
      if (!Number.isNaN(ms)) {
        dateMillis.push(ms);
      }
    }
    const fresh: SmartAlbumCachedMetadata = {
      cachedAssetCount: items.length,
      cachedThumbnailAssetId: items[0]?.id ?? null,
      cachedStartDate: dateMillis.length > 0 ? toDateOnly(new Date(Math.min(...dateMillis))) : null,
      cachedEndDate: dateMillis.length > 0 ? toDateOnly(new Date(Math.max(...dateMillis))) : null,
      cacheComputedAt: new Date(),
    };
    await this.albumRepository.updateCachedMetadata(albumId, fresh);
    return fresh;
  }

  /**
   * Mark smart-album caches as stale for several assets owned by `ownerId`.
   * Safe wrapper: failures are logged but do not throw.
   */
  async invalidateSmartAlbumsForAssetsSafe(ownerId: string, assetIds: readonly string[]): Promise<void> {
    for (const assetId of assetIds) {
      try {
        await this.invalidateSmartAlbumsForAsset(ownerId, assetId);
      } catch (error: unknown) {
        this.logger.warn(
          `Failed to invalidate smart-album caches for asset ${assetId}: ${(error as Error)?.message ?? error}`,
        );
      }
    }
  }

  /**
   * Invalidate the cache for every smart album owned by `ownerId`. Use for coarse-grained
   * write paths where the affected asset list isn't readily known (e.g. trash bulk restore).
   * Safe wrapper: failures are logged but do not throw.
   */
  async invalidateAllSmartAlbumsForOwnerSafe(ownerId: string): Promise<void> {
    try {
      const smartAlbums = await this.albumRepository.getSmartAlbumsForOwner(ownerId);
      if (smartAlbums.length === 0) {
        return;
      }
      await this.albumRepository.markCacheInvalidated(
        smartAlbums.map((a) => a.id),
        new Date(),
      );
    } catch (error: unknown) {
      this.logger.warn(
        `Failed to invalidate smart-album caches for owner ${ownerId}: ${(error as Error)?.message ?? error}`,
      );
    }
  }

  /**
   * Look up each asset's owner and invalidate that owner's smart-album caches.
   * Use this when callers only have an assetId (e.g. tag/untag events) and not the owner.
   * Safe wrapper: failures are logged but do not throw.
   */
  async invalidateSmartAlbumsForAssetIdsSafe(assetIds: readonly string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }
    try {
      const assets = await this.assetRepository.getByIds([...assetIds]);
      for (const asset of assets) {
        try {
          await this.invalidateSmartAlbumsForAsset(asset.ownerId, asset.id);
        } catch (error: unknown) {
          this.logger.warn(
            `Failed to invalidate smart-album caches for asset ${asset.id}: ${(error as Error)?.message ?? error}`,
          );
        }
      }
    } catch (error: unknown) {
      this.logger.warn(`Failed to load assets for smart-album invalidation: ${(error as Error)?.message ?? error}`);
    }
  }

  /**
   * Mark smart-album caches as stale for any smart album owned by `ownerId` whose filter
   * matches the given asset (i.e. the asset would appear in that album's results). Also
   * invalidates any smart album whose cached thumbnail is `assetId`.
   *
   * Callers should wrap this in try/catch — invalidation failure must not abort the write.
   */
  async invalidateSmartAlbumsForAsset(ownerId: string, assetId: string): Promise<void> {
    const smartAlbums = await this.albumRepository.getSmartAlbumsForOwner(ownerId);
    const idsToInvalidate: string[] = [];

    for (const album of smartAlbums) {
      if (!album.filter) {
        continue;
      }
      // The stored SmartAlbumFilter explicitly omits `id`, but `searchMetadata`'s options
      // accept it — we add it here to ask "does this single asset match the filter?"
      const { items } = await this.searchRepository.searchMetadata(
        { page: 1, size: 1 },
        { ...(album.filter as SmartAlbumFilter), userIds: [ownerId], id: assetId },
      );
      if (items.length > 0) {
        idsToInvalidate.push(album.id);
      }
    }

    // Albums whose current thumbnail IS this asset must also be refreshed (e.g. after a delete
    // where the asset would otherwise still be referenced).
    const thumbnailMatches = await this.albumRepository.getSmartAlbumsWithCachedThumbnail(assetId);
    for (const id of thumbnailMatches) {
      if (!idsToInvalidate.includes(id)) {
        idsToInvalidate.push(id);
      }
    }

    await this.albumRepository.markCacheInvalidated(idsToInvalidate, new Date());
  }

  /**
   * Mark smart-album caches as stale for any smart album owned by `ownerId` whose stored
   * `filter.personIds` references ANY of the given person ids. Use this on a person-merge
   * write path with `[sourceId, targetId]` — the narrow JSONB overlap check is cheaper than
   * a full per-asset filter recheck and is sufficient because merging only shifts membership
   * for albums that already pin on one of those two persons.
   */
  async invalidateSmartAlbumsForPersonMerge(ownerId: string, personIds: string[]): Promise<void> {
    if (personIds.length === 0) {
      return;
    }
    const albums = (await this.albumRepository.getSmartAlbumsForOwnerByPersonIds(ownerId, personIds)) ?? [];
    if (albums.length === 0) {
      return;
    }
    await this.albumRepository.markCacheInvalidated(
      albums.map((a) => a.id),
      new Date(),
    );
  }

  /**
   * Safe wrapper around `invalidateSmartAlbumsForPersonMerge`: failures are logged but not
   * propagated, so a cache-invalidation failure cannot abort the merge.
   */
  async invalidateSmartAlbumsForPersonMergeSafe(ownerId: string, personIds: string[]): Promise<void> {
    try {
      await this.invalidateSmartAlbumsForPersonMerge(ownerId, personIds);
    } catch (error: unknown) {
      this.logger.warn(
        `Failed to invalidate smart-album caches for person merge (owner ${ownerId}): ${(error as Error)?.message ?? error}`,
      );
    }
  }

  /**
   * Invalidate the cache for every active smart album that pins on `personIds`, across
   * ALL owners. Used by system-wide face-reset jobs (force-detect / force-recognize)
   * which wipe person-asset assignments globally, so any user's person-filtered smart
   * album may have shifted membership.
   */
  async invalidateAllSmartAlbumsByPersonFilter(): Promise<void> {
    await this.albumRepository.markAllSmartAlbumsWithPersonFilterInvalidated(new Date());
  }

  /**
   * Safe wrapper around `invalidateAllSmartAlbumsByPersonFilter`: failures are logged
   * but not propagated, so a cache-invalidation failure cannot abort the underlying job.
   */
  async invalidateAllSmartAlbumsByPersonFilterSafe(): Promise<void> {
    try {
      await this.invalidateAllSmartAlbumsByPersonFilter();
    } catch (error: unknown) {
      this.logger.error(
        `Failed to invalidate smart albums for system-wide face wipe: ${(error as Error)?.message ?? error}`,
      );
    }
  }

  /**
   * Splice the given deleted person ids out of `filter.personIds` on every smart album
   * that references any of them, and bump `cacheInvalidatedAt` so the album is recomputed
   * from the now-clean filter. With AND semantics across personIds, a dangling reference
   * makes the album match nothing; pruning self-heals filters on person delete.
   */
  async prunePersonIdsFromSmartAlbums(deletedPersonIds: string[]): Promise<void> {
    if (deletedPersonIds.length === 0) {
      return;
    }
    const affected = await this.albumRepository.prunePersonIdsFromSmartAlbums(deletedPersonIds);
    if (affected.length > 0) {
      this.logger.debug(
        `Pruned ${deletedPersonIds.length} deleted person id(s) from ${affected.length} smart album filter(s)`,
      );
    }
  }

  /**
   * Safe wrapper around `prunePersonIdsFromSmartAlbums`: failures are logged but not
   * propagated, so a smart-album filter cleanup failure cannot abort the person delete.
   */
  async prunePersonIdsFromSmartAlbumsSafe(deletedPersonIds: string[]): Promise<void> {
    try {
      await this.prunePersonIdsFromSmartAlbums(deletedPersonIds);
    } catch (error: unknown) {
      this.logger.error(
        `Failed to prune deleted person ids from smart album filters: ${(error as Error)?.message ?? error}`,
      );
    }
  }

  /**
   * Splice the given deleted tag ids out of `filter.tagIds` on every smart album that
   * references any of them, and bump `cacheInvalidatedAt` so the album is recomputed
   * from the now-clean filter.
   */
  async pruneTagIdsFromSmartAlbums(deletedTagIds: string[]): Promise<void> {
    if (deletedTagIds.length === 0) {
      return;
    }
    const affected = await this.albumRepository.pruneTagIdsFromSmartAlbums(deletedTagIds);
    if (affected.length > 0) {
      this.logger.debug(
        `Pruned ${deletedTagIds.length} deleted tag id(s) from ${affected.length} smart album filter(s)`,
      );
    }
  }

  /**
   * Safe wrapper around `pruneTagIdsFromSmartAlbums`: failures are logged but not
   * propagated, so a smart-album filter cleanup failure cannot abort the tag delete.
   */
  async pruneTagIdsFromSmartAlbumsSafe(deletedTagIds: string[]): Promise<void> {
    try {
      await this.pruneTagIdsFromSmartAlbums(deletedTagIds);
    } catch (error: unknown) {
      this.logger.error(
        `Failed to prune deleted tag ids from smart album filters: ${(error as Error)?.message ?? error}`,
      );
    }
  }
}
