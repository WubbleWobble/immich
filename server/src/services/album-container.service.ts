import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AlbumContainerResponseDto,
  AlbumContainerUserCreateDto,
  AlbumContainerUserResponseDto,
  AlbumContainerUserUpdateDto,
  CreateAlbumContainerDto,
  UpdateAlbumContainerDto,
} from 'src/dtos/album-container.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { mapUser } from 'src/dtos/user.dto';
import { AlbumUserRole } from 'src/enum';
import { AlbumService } from 'src/services/album.service';
import { BaseService } from 'src/services/base.service';
import { LockService } from 'src/services/lock.service';
import { NO_REVEALED_LOCKS } from 'src/utils/lock-visibility';

// Folder-tree depth cap. Mirrored on the web side at:
//   web/src/lib/utils/album-folder-utils.ts (buildFolderBreadcrumbPath `maxDepth` default)
// Keep the two values in sync — the web cap is a safety guard for breadcrumb walks
// that assumes server-enforced depth ≤ MAX_DEPTH.
const MAX_DEPTH = 16;

@Injectable()
export class AlbumContainerService extends BaseService {
  /** Viewer's effectively-hidden album ids for mosaic exclusion (no reveal outside elevation). */
  private async getViewerHiddenAlbumIdsForMosaic(auth: AuthDto): Promise<string[]> {
    if (!(await this.lockRepository.hasAnyLocks(auth.user.id))) {
      return [];
    }
    const isElevated = !!auth.session?.hasElevatedPermission;
    const revealed = isElevated ? (auth.revealedLocks ?? NO_REVEALED_LOCKS) : NO_REVEALED_LOCKS;
    return this.lockRepository.getHiddenAlbumIds(auth.user.id, revealed);
  }

  async list(auth: AuthDto): Promise<AlbumContainerResponseDto[]> {
    let containers = await this.albumContainerRepository.getForUser(auth.user.id);

    // Locked folders (and their descendants via the closure cascade) vanish from the list
    // for their locker until revealed in an elevated session, and locked albums must not
    // surface in a visible parent folder's thumbnail mosaic. Other users are unaffected.
    let hiddenAlbumIds: string[] = [];
    if (await this.lockRepository.hasAnyLocks(auth.user.id)) {
      const isElevated = !!auth.session?.hasElevatedPermission;
      const revealed = isElevated ? (auth.revealedLocks ?? NO_REVEALED_LOCKS) : NO_REVEALED_LOCKS;
      const hidden = new Set(await this.lockRepository.getHiddenContainerIds(auth.user.id, revealed.containerIds));
      if (hidden.size > 0) {
        containers = containers.filter((container) => !hidden.has(container.id));
      }
      hiddenAlbumIds = await this.lockRepository.getHiddenAlbumIds(auth.user.id, revealed);
    }

    const ids = containers.map((c) => c.id);
    // Privacy: recipients shouldn't see the full share graph; only fetch users for owned containers.
    const ownedIds = containers.filter((c) => c.ownerId === auth.user.id).map((c) => c.id);
    const usersByContainer = await this.fetchUsersByContainer(ownedIds);
    await this.warmSmartAlbumCachesForContainers(ids, hiddenAlbumIds);
    const thumbnailsByContainer = await this.albumContainerRepository.getThumbnailAssetIdsForContainers(
      ids,
      hiddenAlbumIds,
    );
    return containers.map((container) => {
      const isOwner = container.ownerId === auth.user.id;
      return this.mapToResponse(
        container,
        isOwner ? (usersByContainer.get(container.id) ?? []) : undefined,
        thumbnailsByContainer.get(container.id) ?? [],
      );
    });
  }

  async get(auth: AuthDto, id: string): Promise<AlbumContainerResponseDto> {
    await BaseService.create(LockService, this).assertContainerVisibleForViewer(auth, id);
    const container = await this.albumContainerRepository.getById(id);
    if (!container) {
      throw new NotFoundException('Folder not found');
    }
    const isOwner = container.ownerId === auth.user.id;
    if (!isOwner) {
      const hasCascade = await this.albumContainerRepository.hasAccess(id, auth.user.id);
      if (!hasCascade) {
        throw new ForbiddenException('Not allowed');
      }
    }
    const mosaicHiddenAlbumIds = await this.getViewerHiddenAlbumIdsForMosaic(auth);
    await this.warmSmartAlbumCachesForContainers([id], mosaicHiddenAlbumIds);
    const thumbnailsByContainer = await this.albumContainerRepository.getThumbnailAssetIdsForContainers(
      [id],
      mosaicHiddenAlbumIds,
    );
    // Privacy: recipients shouldn't see the full share graph, so only the owner gets albumContainerUsers.
    let albumContainerUsers: AlbumContainerUserResponseDto[] | undefined;
    if (isOwner) {
      const usersByContainer = await this.fetchUsersByContainer([id]);
      albumContainerUsers = usersByContainer.get(id) ?? [];
    }
    return this.mapToResponse(container, albumContainerUsers, thumbnailsByContainer.get(id) ?? []);
  }

  /**
   * The mosaic reads smart albums' cachedThumbnailAssetId, but nothing on the folder
   * path recomputes it - and the web loads albums and folders concurrently, so the
   * album list cannot be relied on to have warmed it first. Refresh stale caches here
   * (hidden albums excluded: their covers are excluded from the mosaic anyway).
   */
  private async warmSmartAlbumCachesForContainers(containerIds: string[], hiddenAlbumIds: string[]): Promise<void> {
    const smartAlbums = (await this.albumContainerRepository.getSmartAlbumsForContainers(containerIds)) ?? [];
    const hidden = new Set(hiddenAlbumIds);
    const candidates = smartAlbums.filter((album) => !hidden.has(album.id));
    if (candidates.length > 0) {
      await BaseService.create(AlbumService, this).warmSmartAlbumCaches(candidates);
    }
  }

  private async fetchUsersByContainer(ids: string[]): Promise<Map<string, AlbumContainerUserResponseDto[]>> {
    const map = new Map<string, AlbumContainerUserResponseDto[]>();
    if (ids.length === 0) {
      return map;
    }
    const rows = await this.albumContainerRepository.getUsersForContainers(ids);
    for (const row of rows) {
      const list = map.get(row.albumContainerId) ?? [];
      list.push({
        userId: row.userId,
        role: row.role as AlbumUserRole,
        user: mapUser({
          id: row.user_id,
          name: row.user_name,
          email: row.user_email,
          avatarColor: row.user_avatarColor,
          profileImagePath: row.user_profileImagePath,
          profileChangedAt: row.user_profileChangedAt,
        }),
      });
      map.set(row.albumContainerId, list);
    }
    return map;
  }

  async create(auth: AuthDto, dto: CreateAlbumContainerDto): Promise<AlbumContainerResponseDto> {
    if (dto.parentId) {
      const parent = await this.albumContainerRepository.getById(dto.parentId);
      if (!parent) {
        throw new BadRequestException('Parent folder not found');
      }
      if (parent.ownerId !== auth.user.id) {
        throw new ForbiddenException("Cannot create folder under another user's folder");
      }
      const parentDepth = await this.albumContainerRepository.getDepth(parent.id);
      if (parentDepth + 1 > MAX_DEPTH) {
        throw new BadRequestException(`Folder depth exceeds limit of ${MAX_DEPTH}`);
      }
    }

    const container = await this.albumContainerRepository.create({
      ownerId: auth.user.id,
      name: dto.name,
      parentId: dto.parentId ?? null,
    });

    return this.mapToResponse(container, [], []);
  }

  async update(auth: AuthDto, id: string, dto: UpdateAlbumContainerDto): Promise<AlbumContainerResponseDto> {
    await BaseService.create(LockService, this).assertContainerVisibleForViewer(auth, id);
    const container = await this.albumContainerRepository.getById(id);
    if (!container) {
      throw new NotFoundException('Folder not found');
    }
    if (container.ownerId !== auth.user.id) {
      throw new ForbiddenException('Not allowed');
    }

    if (dto.parentId !== undefined && dto.parentId !== container.parentId) {
      if (dto.parentId !== null) {
        const parent = await this.albumContainerRepository.getById(dto.parentId);
        if (!parent) {
          throw new BadRequestException('Parent folder not found');
        }
        if (parent.ownerId !== auth.user.id) {
          throw new ForbiddenException("Cannot move folder under another user's folder");
        }

        const isCycle = await this.albumContainerRepository.isDescendantOf(dto.parentId, id);
        if (isCycle) {
          throw new BadRequestException('Cannot move a folder into its own descendant');
        }

        const parentDepth = await this.albumContainerRepository.getDepth(dto.parentId);
        const subtreeHeight = await this.albumContainerRepository.getHeight(id);
        if (parentDepth + 1 + subtreeHeight > MAX_DEPTH) {
          throw new BadRequestException(`Folder depth exceeds limit of ${MAX_DEPTH}`);
        }
      }
      await this.albumContainerRepository.move(id, dto.parentId);
    }

    if (dto.name !== undefined && dto.name !== container.name) {
      await this.albumContainerRepository.rename(id, dto.name);
    }

    const updated = await this.albumContainerRepository.getById(id);
    const usersByContainer = await this.fetchUsersByContainer([id]);
    const thumbnailsByContainer = await this.albumContainerRepository.getThumbnailAssetIdsForContainers(
      [id],
      await this.getViewerHiddenAlbumIdsForMosaic(auth),
    );
    return this.mapToResponse(updated!, usersByContainer.get(id) ?? [], thumbnailsByContainer.get(id) ?? []);
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    await BaseService.create(LockService, this).assertContainerVisibleForViewer(auth, id);
    const container = await this.albumContainerRepository.getById(id);
    if (!container) {
      throw new NotFoundException('Folder not found');
    }
    if (container.ownerId !== auth.user.id) {
      throw new ForbiddenException('Not allowed');
    }
    await this.albumContainerRepository.delete(id);
  }

  async addUser(auth: AuthDto, id: string, dto: AlbumContainerUserCreateDto): Promise<void> {
    await BaseService.create(LockService, this).assertContainerVisibleForViewer(auth, id);
    const container = await this.albumContainerRepository.getById(id);
    if (!container) {
      throw new NotFoundException('Folder not found');
    }
    if (container.ownerId !== auth.user.id) {
      throw new ForbiddenException('Not allowed');
    }

    if (dto.role === AlbumUserRole.Owner) {
      throw new BadRequestException('Cannot add another owner');
    }

    if (dto.userId === auth.user.id) {
      throw new BadRequestException('Cannot share folder with yourself');
    }

    const existing = await this.albumContainerRepository.getUser(id, dto.userId);
    if (existing) {
      throw new BadRequestException('User already added');
    }

    const user = await this.userRepository.get(dto.userId, {});
    if (!user) {
      this.logger.debug('Adding user to folder failed: user not found');
      throw new BadRequestException('Invalid user');
    }

    await this.albumContainerRepository.addUser(id, dto.userId, dto.role);
  }

  async updateUser(auth: AuthDto, id: string, userId: string, dto: AlbumContainerUserUpdateDto): Promise<void> {
    await BaseService.create(LockService, this).assertContainerVisibleForViewer(auth, id);
    const container = await this.albumContainerRepository.getById(id);
    if (!container) {
      throw new NotFoundException('Folder not found');
    }
    if (container.ownerId !== auth.user.id) {
      throw new ForbiddenException('Not allowed');
    }
    if (dto.role === AlbumUserRole.Owner) {
      throw new BadRequestException('Cannot add another owner');
    }
    const existing = await this.albumContainerRepository.getUser(id, userId);
    if (!existing) {
      throw new NotFoundException('Share not found');
    }
    await this.albumContainerRepository.updateUserRole(id, userId, dto.role);
  }

  async removeUser(auth: AuthDto, id: string, userId: string): Promise<void> {
    await BaseService.create(LockService, this).assertContainerVisibleForViewer(auth, id);
    const container = await this.albumContainerRepository.getById(id);
    if (!container) {
      throw new NotFoundException('Folder not found');
    }
    if (container.ownerId !== auth.user.id) {
      throw new ForbiddenException('Not allowed');
    }
    const existing = await this.albumContainerRepository.getUser(id, userId);
    if (!existing) {
      throw new NotFoundException('Share not found');
    }
    await this.albumContainerRepository.removeUser(id, userId);
  }

  private mapToResponse(
    container: {
      id: string;
      name: string;
      ownerId: string;
      parentId: string | null;
      createdAt: Date | string;
      updatedAt: Date | string;
    },
    albumContainerUsers: AlbumContainerUserResponseDto[] | undefined,
    thumbnailAssetIds: string[] = [],
  ): AlbumContainerResponseDto {
    return {
      id: container.id,
      name: container.name,
      ownerId: container.ownerId,
      parentId: container.parentId,
      thumbnailAssetIds,
      ...(albumContainerUsers === undefined ? {} : { albumContainerUsers }),
      createdAt: container.createdAt instanceof Date ? container.createdAt.toISOString() : container.createdAt,
      updatedAt: container.updatedAt instanceof Date ? container.updatedAt.toISOString() : container.updatedAt,
    };
  }
}
