import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
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
import {
  isEmptySmartAlbumFilter,
  SmartAlbumFilter,
  toEvaluableSmartAlbumFilter,
} from 'src/dtos/smart-album-filter.dto';
import { AlbumKind, AlbumUserRole, Permission } from 'src/enum';
import { AlbumAssetCount, AlbumInfoOptions } from 'src/repositories/album.repository';
import { BaseService } from 'src/services/base.service';
import { LockService } from 'src/services/lock.service';
import { addAssets, removeAssets } from 'src/utils/asset.util';
import { asDateString, asDateTimeString } from 'src/utils/date';
import { NO_REVEALED_LOCKS } from 'src/utils/lock-visibility';
import { getPreferences } from 'src/utils/preferences';

interface SmartAlbumCachedMetadata {
  cachedAssetCount: number;
  cachedThumbnailAssetId: string | null;
  cachedStartDate: string | null;
  cachedEndDate: string | null;
  cacheComputedAt: Date;
}

const toDateOnly = (d: Date) => d.toISOString().slice(0, 10);

// Display metadata for a smart album that must present as empty (missing or unevaluable
// filter). Served instead of the cache, whose values may predate the filter becoming
// unevaluable and still describe broad results.
const emptySmartAlbumDisplayMetadata = {
  cachedAssetCount: 0,
  cachedThumbnailAssetId: null,
  cachedStartDate: null,
  cachedEndDate: null,
};

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

    // Counts must match what getAll lists: albums hidden by the viewer's locks don't count.
    const hiddenAlbumIds = await this.getViewerHiddenAlbumIds(auth);
    const countVisible = (albums: { id: string }[]) => albums.filter((album) => !hiddenAlbumIds.has(album.id)).length;

    return {
      owned: countVisible(owned),
      shared: countVisible(shared),
      notShared: countVisible(notShared),
    };
  }

  async getAll(auth: AuthDto, { assetId, ...rest }: GetAlbumsDto): Promise<AlbumResponseDto[]> {
    const ownerId = auth.user.id;
    await this.albumRepository.updateThumbnails();

    let albums = assetId
      ? [
          ...(await this.albumRepository.getByAssetId(ownerId, assetId)),
          // Smart membership is computed, not stored: include reachable smart albums whose
          // filter matches, so "appears in" is complete (the web locked-move flow relies on
          // this to detect that an unlocked saved search still rescues the asset).
          ...(await this.albumRepository.getMatchingSmartAlbumsByAssetId(ownerId, assetId)),
        ]
      : await this.albumRepository.getAll(ownerId, rest);

    // Locked albums (directly, or via a locked folder) vanish from every list surface for
    // their locker until revealed in an elevated session. Other users are unaffected.
    const hiddenAlbumIds = await this.getViewerHiddenAlbumIds(auth);
    if (hiddenAlbumIds.size > 0) {
      albums = albums.filter((album) => !hiddenAlbumIds.has(album.id));
    }

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
    // See `invalidateSmartAlbumsForAssetsSafe` for the invalidation side.
    for (const album of albums) {
      if (album.kind !== AlbumKind.Smart) {
        continue;
      }
      // A missing/unevaluable filter or no resolvable owner (corrupt data) presents as
      // empty regardless of cache freshness: the cached values may predate the album
      // becoming unevaluable and still describe broad results.
      const albumOwnerId = album.albumUsers?.find(({ role }) => role === AlbumUserRole.Owner)?.user.id;
      if (!albumOwnerId || !album.filter || !toEvaluableSmartAlbumFilter(album.filter)) {
        Object.assign(album, emptySmartAlbumDisplayMetadata);
        continue;
      }
      if (!isSmartAlbumCacheStale(album)) {
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
        startDate: asDateTimeString((isSmart ? album.cachedStartDate : albumMetadata[album.id]?.startDate) ?? undefined),
        endDate: asDateTimeString((isSmart ? album.cachedEndDate : albumMetadata[album.id]?.endDate) ?? undefined),
        assetCount: isSmart ? (album.cachedAssetCount ?? 0) : (albumMetadata[album.id]?.assetCount ?? 0),
        // lastModifiedAssetTimestamp is only used in mobile app, please remove if not need
        lastModifiedAssetTimestamp: asDateTimeString(albumMetadata[album.id]?.lastModifiedAssetTimestamp ?? undefined),
      };
    });
  }

  async get(auth: AuthDto, id: string): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });
    await BaseService.create(LockService, this).assertAlbumVisibleForViewer(auth, id);
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
    if (album.kind === AlbumKind.Smart) {
      const ownerId = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)?.user.id;
      if (album.filter && ownerId) {
        // recomputeSmartAlbumCache itself fails closed (persists zeros) for an
        // unevaluable filter.
        const fresh = await this.recomputeSmartAlbumCache(album.id, ownerId, album.filter);
        Object.assign(album, fresh);
      } else {
        // No filter / no resolvable owner: present as empty rather than serve whatever
        // the cache last recorded.
        Object.assign(album, emptySmartAlbumDisplayMetadata);
      }
    }

    const isSmart = album.kind === AlbumKind.Smart;

    return {
      ...mapAlbum(album),
      albumThumbnailAssetId: isSmart ? (album.cachedThumbnailAssetId ?? null) : album.albumThumbnailAssetId,
      startDate: asDateTimeString((isSmart ? album.cachedStartDate : albumMetadataForIds?.startDate) ?? undefined),
      endDate: asDateTimeString((isSmart ? album.cachedEndDate : albumMetadataForIds?.endDate) ?? undefined),
      assetCount: isSmart ? (album.cachedAssetCount ?? 0) : (albumMetadataForIds?.assetCount ?? 0),
      lastModifiedAssetTimestamp: asDateTimeString(albumMetadataForIds?.lastModifiedAssetTimestamp ?? undefined),
      contributorCounts: isShared ? await this.albumRepository.getContributorCounts(album.id) : undefined,
    };
  }

  async getMapMarkers(auth: AuthDto, id: string): Promise<MapMarkerResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });
    await BaseService.create(LockService, this).assertAlbumVisibleForViewer(auth, id);

    if (auth.sharedLink && !auth.sharedLink.showExif) {
      return [];
    }

    // Smart albums resolve markers from the filter. A missing/unevaluable filter (e.g. a
    // legacy row whose only fields were sanitized away) has no markers - explicitly, never
    // via the album_asset path, where legacy/corrupt rows would otherwise surface.
    const album = await this.findOrFail(id, auth.user.id, { withAssets: false });
    if (album.kind === AlbumKind.Smart) {
      const ownerId = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)?.user.id;
      const filter = album.filter && ownerId ? toEvaluableSmartAlbumFilter(album.filter) : null;
      if (!ownerId || !filter) {
        return [];
      }
      return this.mapRepository.getMapMarkersForSearch({
        ...filter,
        userIds: [ownerId],
      });
    }

    return this.mapRepository.getAlbumMapMarkers(id);
  }

  async create(auth: AuthDto, dto: CreateAlbumDto): Promise<AlbumResponseDto> {
    const albumUsers = (dto.albumUsers || []).filter(({ userId }) => userId !== auth.user.id);
    const kind = dto.kind ?? AlbumKind.Regular;
    const filter = kind === AlbumKind.Smart ? (dto.filter ?? null) : null;

    if (kind === AlbumKind.Smart && !dto.filter) {
      throw new BadRequestException('Smart albums require a filter');
    }

    // An empty filter matches the owner's entire timeline - almost always an accident
    // (e.g. a semantic-only search saved as a smart album), and once shared it exposes
    // the whole library.
    if (kind === AlbumKind.Smart && dto.filter && isEmptySmartAlbumFilter(dto.filter)) {
      throw new BadRequestException('Smart album filter must contain at least one criterion');
    }

    if (kind === AlbumKind.Regular && dto.filter) {
      throw new BadRequestException('Filter is only valid for smart albums');
    }

    if (kind === AlbumKind.Smart && dto.assetIds && dto.assetIds.length > 0) {
      throw new BadRequestException('Smart albums cannot be created with initial assetIds');
    }

    // Smart albums are read-only and single-owner, so shares collapse to Viewer. An Editor
    // could broaden the filter and browse the owner's whole library; a second Owner breaks
    // the single-owner assumption used to resolve whose library the filter runs against.
    if (kind === AlbumKind.Smart && albumUsers.some(({ role }) => role !== AlbumUserRole.Viewer)) {
      throw new BadRequestException('Smart albums only support the viewer role');
    }

    for (const { userId } of albumUsers) {
      const exists = await this.userRepository.get(userId, {});
      if (!exists) {
        this.logger.debug('Album creation failed: user not found');
        throw new BadRequestException('Invalid user');
      }
    }

    if (dto.containerId) {
      const container = await this.albumContainerRepository.getById(dto.containerId);
      if (!container) {
        throw new BadRequestException('Folder not found');
      }
      if (container.ownerId !== auth.user.id) {
        throw new ForbiddenException("Cannot create album in another user's folder");
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
        containerId: dto.containerId ?? null,
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
    await BaseService.create(LockService, this).assertAlbumVisibleForViewer(auth, id);

    const album = await this.findOrFail(id, auth.user.id, { withAssets: true });

    if ('kind' in dto && dto.kind !== undefined && dto.kind !== album.kind) {
      throw new BadRequestException('Album kind is immutable');
    }

    if (dto.filter !== undefined && album.kind !== AlbumKind.Smart) {
      throw new BadRequestException('Filter can only be set on smart albums');
    }

    // Filter mutation is owner-only. Smart-album reads always evaluate against the owner's
    // library, so anyone else who can broaden the filter can browse the owner's assets.
    if (dto.filter !== undefined) {
      const ownerId = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)?.user.id;
      if (ownerId !== auth.user.id) {
        throw new BadRequestException('Only the album owner can update a smart album filter');
      }
      // An empty filter matches the owner's entire timeline; see create().
      if (isEmptySmartAlbumFilter(dto.filter)) {
        throw new BadRequestException('Smart album filter must contain at least one criterion');
      }
    }

    if (dto.albumThumbnailAssetId) {
      const results = await this.albumRepository.getAssetIds(id, [dto.albumThumbnailAssetId]);
      if (results.size === 0) {
        throw new BadRequestException('Invalid album thumbnail');
      }
    }

    if (dto.containerId !== undefined && dto.containerId !== album.containerId) {
      const albumOwnerId = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)?.user.id;
      if (auth.user.id !== albumOwnerId) {
        throw new ForbiddenException('Only the album owner can move it to a folder');
      }

      if (dto.containerId !== null) {
        const container = await this.albumContainerRepository.getById(dto.containerId);
        if (!container) {
          throw new BadRequestException('Folder not found');
        }
        if (container.ownerId !== auth.user.id) {
          throw new ForbiddenException("Cannot move album to another user's folder");
        }
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
        containerId: dto.containerId,
      },
      auth.user.id,
    );

    if (dto.filter !== undefined) {
      // The list view serves cached metadata; a changed filter means the cached count,
      // thumbnail, and date range no longer describe the album.
      await this.albumRepository.markCacheInvalidated([album.id], new Date());
    }

    return mapAlbum({ ...updatedAlbum, assets: album.assets });
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AlbumDelete, ids: [id] });
    // Deleting a locked album would cascade locked_album and album_asset rows and could
    // un-hide formerly zero-container assets - hidden targets are write-protected too.
    await BaseService.create(LockService, this).assertAlbumVisibleForViewer(auth, id);
    await this.albumRepository.delete(id);
  }

  async addAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    const album = await this.findOrFail(id, auth.user.id, { withAssets: false });
    await this.requireAccess({ auth, permission: Permission.AlbumAssetCreate, ids: [id] });
    await BaseService.create(LockService, this).assertAlbumVisibleForViewer(auth, id);

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

      const userIds = album.albumUsers.map(({ user }) => user.id);
      const recipientIds = userIds.filter((userId) => userId !== auth.user.id);
      await this.eventRepository.emit('AlbumUpdate', { id, userIds, recipientIds });
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

    // Smart albums are read-only; the bulk path must enforce the same guard as addAssets().
    // Hidden albums are write-protected for their locker outside an elevated session, so
    // they are excluded from the bulk targets as well. Elevated sessions bypass entirely
    // (same rule as assertAlbumVisibleForViewer).
    const hiddenTargetIds = auth.session?.hasElevatedPermission
      ? new Set<string>()
      : await this.getViewerHiddenAlbumIds(auth);
    const targetAlbums = [];
    for (const albumId of allowedAlbumIds) {
      if (hiddenTargetIds.has(albumId)) {
        continue;
      }
      const album = await this.findOrFail(albumId, auth.user.id, { withAssets: false });
      if (album.kind !== AlbumKind.Smart) {
        targetAlbums.push(album);
      }
    }
    if (targetAlbums.length === 0) {
      results.error = BulkIdErrorReason.NO_PERMISSION;
      return results;
    }

    const albumAssetValues: { albumId: string; assetId: string }[] = [];
    const events: { id: string; userIds: string[]; recipientIds: string[] }[] = [];
    for (const album of targetAlbums) {
      const albumId = album.id;
      const existingAssetIds = await this.albumRepository.getAssetIds(albumId, [...allowedAssetIds]);
      const notPresentAssetIds = [...allowedAssetIds.difference(existingAssetIds)];
      if (notPresentAssetIds.length === 0) {
        continue;
      }
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
      const userIds = album.albumUsers.map(({ user }) => user.id);
      const recipientIds = userIds.filter((userId) => userId !== auth.user.id);
      events.push({ id: albumId, userIds, recipientIds });
    }

    await this.albumRepository.addAssetIdsToAlbums(albumAssetValues);
    for (const event of events) {
      await this.eventRepository.emit('AlbumUpdate', event);
    }

    return results;
  }

  async removeAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AlbumAssetDelete, ids: [id] });
    await BaseService.create(LockService, this).assertAlbumVisibleForViewer(auth, id);

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
    if (removedIds.length > 0) {
      if (album.albumThumbnailAssetId && removedIds.includes(album.albumThumbnailAssetId)) {
        await this.albumRepository.updateThumbnails();
      }

      await this.eventRepository.emit('AlbumUpdate', {
        id,
        userIds: album.albumUsers.map(({ user }) => user.id),
        recipientIds: [],
      });
    }

    return results;
  }

  async addUsers(auth: AuthDto, id: string, { albumUsers }: AddUsersDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });
    await BaseService.create(LockService, this).assertAlbumVisibleForViewer(auth, id);

    const album = await this.findOrFail(id, auth.user.id, { withAssets: false });

    const isSmart = album.kind === AlbumKind.Smart;

    for (const { userId, role } of albumUsers) {
      if (role === AlbumUserRole.Owner) {
        throw new BadRequestException('Cannot add another owner');
      }

      // Smart albums are read-only, so shares collapse to Owner + Viewer (an Editor could
      // broaden the filter). Without an explicit role the DB default is Editor, so a smart
      // album must default to Viewer instead.
      if (isSmart && role === AlbumUserRole.Editor) {
        throw new BadRequestException('Smart albums only support the viewer role');
      }
      const effectiveRole = role ?? (isSmart ? AlbumUserRole.Viewer : undefined);

      const exists = album.albumUsers.some(({ user: { id } }) => id === userId);
      if (exists) {
        continue;
      }

      const user = await this.userRepository.get(userId, {});
      if (!user) {
        this.logger.debug('Adding user to album failed: user not found');
        throw new BadRequestException('Invalid user');
      }

      await this.albumUserRepository.create({ userId, albumId: id, role: effectiveRole });
      await this.eventRepository.emit('AlbumInvite', { id, userId, senderName: auth.user.name });
    }

    return mapAlbum(await this.findOrFail(id, auth.user.id, { withAssets: true }));
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
    // Hidden albums are write-protected even for self-removal: leaving a locked shared
    // album is a state change on hidden content (it can even un-hide the sharee's own
    // assets by making them zero-container), so it requires an elevated session too.
    await BaseService.create(LockService, this).assertAlbumVisibleForViewer(auth, id);

    await this.albumUserRepository.delete({ albumId: id, userId });
  }

  async updateUser(auth: AuthDto, id: string, userId: string, dto: UpdateAlbumUserDto): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });
    await BaseService.create(LockService, this).assertAlbumVisibleForViewer(auth, id);

    const album = await this.findOrFail(id, auth.user.id, { withAssets: false });
    if (album.kind === AlbumKind.Smart) {
      // Viewer is the only sharable role on a smart album: an Editor could broaden the filter,
      // and a second Owner breaks the single-owner assumption every smart-album evaluation
      // path relies on when resolving whose library the filter runs against.
      if (dto.role !== AlbumUserRole.Viewer) {
        throw new BadRequestException('Smart albums only support the viewer role');
      }
    }

    // The owner row is immutable for regular and smart albums alike.
    const target = album.albumUsers.find(({ user: { id: albumUserId } }) => albumUserId === userId);
    if (target?.role === AlbumUserRole.Owner) {
      throw new BadRequestException('User is owner');
    }

    await this.albumUserRepository.update({ albumId: id, userId }, { role: dto.role });
  }

  /**
   * The viewer's effectively-hidden album ids (empty for the common no-locks case). The
   * reveal set applies only in an elevated session.
   */
  private async getViewerHiddenAlbumIds(auth: AuthDto): Promise<Set<string>> {
    if (auth.sharedLink || !(await this.lockRepository.hasAnyLocks(auth.user.id))) {
      return new Set();
    }
    const isElevated = !!auth.session?.hasElevatedPermission;
    const revealed = isElevated ? (auth.revealedLocks ?? NO_REVEALED_LOCKS) : NO_REVEALED_LOCKS;
    return new Set(await this.lockRepository.getHiddenAlbumIds(auth.user.id, revealed));
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
  /**
   * Refresh the list-view cache of any stale smart albums in the batch. Used by surfaces
   * that read cachedThumbnailAssetId without going through the album list (e.g. folder
   * mosaics, which the web loads concurrently with - not after - the album list).
   */
  async warmSmartAlbumCaches(
    albums: {
      id: string;
      filter: SmartAlbumFilter | null;
      ownerId: string;
      cacheComputedAt: Date | string | null;
      cacheInvalidatedAt: Date | string | null;
    }[],
  ): Promise<void> {
    // Defensive dedupe: an overlapping batch (e.g. a folder subtree queried per ancestor)
    // must not recompute the same album more than once.
    const seen = new Set<string>();
    for (const album of albums) {
      if (seen.has(album.id) || !album.filter || !isSmartAlbumCacheStale(album)) {
        continue;
      }
      seen.add(album.id);
      // recomputeSmartAlbumCache fails closed (persists zeros) for unevaluable filters.
      await this.recomputeSmartAlbumCache(album.id, album.ownerId, album.filter);
    }
  }

  private async recomputeSmartAlbumCache(
    albumId: string,
    ownerId: string,
    filter: SmartAlbumFilter,
  ): Promise<SmartAlbumCachedMetadata> {
    // Fail closed: an unevaluable filter (e.g. a legacy row whose only fields were
    // sanitized away) matches nothing, not the owner's entire timeline.
    const evaluable = toEvaluableSmartAlbumFilter(filter);
    if (!evaluable) {
      const empty: SmartAlbumCachedMetadata = {
        cachedAssetCount: 0,
        cachedThumbnailAssetId: null,
        cachedStartDate: null,
        cachedEndDate: null,
        cacheComputedAt: new Date(),
      };
      await this.albumRepository.updateCachedMetadata(albumId, empty);
      return empty;
    }

    const options = { ...evaluable, userIds: [ownerId] };
    // Count and date range are aggregates so albums beyond any page size stay accurate;
    // only the thumbnail needs an actual row (most recent match).
    const [{ total }, range, { items }] = await Promise.all([
      this.searchRepository.searchStatistics(options),
      this.searchRepository.searchDateRange(options),
      this.searchRepository.searchMetadata({ page: 1, size: 1 }, options),
    ]);
    const toDateOnlyOrNull = (raw: Date | string | null) => {
      if (raw == null) {
        return null;
      }
      const date = raw instanceof Date ? raw : new Date(raw);
      return Number.isNaN(date.getTime()) ? null : toDateOnly(date);
    };
    const fresh: SmartAlbumCachedMetadata = {
      cachedAssetCount: Number(total),
      cachedThumbnailAssetId: items[0]?.id ?? null,
      cachedStartDate: toDateOnlyOrNull(range.startDate),
      cachedEndDate: toDateOnlyOrNull(range.endDate),
      cacheComputedAt: new Date(),
    };
    await this.albumRepository.updateCachedMetadata(albumId, fresh);
    return fresh;
  }

  /**
   * Mark smart-album caches as stale after asset writes owned by `ownerId`.
   *
   * Invalidation is deliberately blanket (every smart album of the owner) rather than
   * per-filter: a write can REMOVE an asset from an album's matches (unfavorite, untag,
   * trash, date/rating edits), and a post-write match check cannot see removals - it would
   * leave the cached list count/date range stale. A blanket mark is also cheaper on the
   * write path (one UPDATE instead of one search per smart album), and recompute is a lazy
   * aggregate on the next Albums-list view.
   *
   * Safe wrapper: failures are logged but do not throw.
   */
  async invalidateSmartAlbumsForAssetsSafe(ownerId: string, assetIds: readonly string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }
    await this.invalidateAllSmartAlbumsForOwnerSafe(ownerId);
  }

  /**
   * Invalidate the cache for every smart album owned by `ownerId`.
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
   * Look up each asset's owner and invalidate that owner's smart-album caches (blanket,
   * see invalidateSmartAlbumsForAssetsSafe for why). Use this when callers only have
   * assetIds (e.g. tag/untag events) and not the owner.
   * Safe wrapper: failures are logged but do not throw.
   */
  async invalidateSmartAlbumsForAssetIdsSafe(assetIds: readonly string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }
    try {
      const assets = await this.assetRepository.getByIds([...assetIds]);
      const ownerIds = new Set(assets.map((asset) => asset.ownerId));
      for (const ownerId of ownerIds) {
        await this.invalidateAllSmartAlbumsForOwnerSafe(ownerId);
      }
    } catch (error: unknown) {
      this.logger.warn(`Failed to load assets for smart-album invalidation: ${(error as Error)?.message ?? error}`);
    }
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
