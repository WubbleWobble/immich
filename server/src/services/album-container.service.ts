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
import { BaseService } from 'src/services/base.service';

// Folder-tree depth cap. Mirrored on the web side at:
//   web/src/lib/utils/album-folder-utils.ts (buildFolderBreadcrumbPath `maxDepth` default)
// Keep the two values in sync — the web cap is a safety guard for breadcrumb walks
// that assumes server-enforced depth ≤ MAX_DEPTH.
const MAX_DEPTH = 16;

@Injectable()
export class AlbumContainerService extends BaseService {
  async list(auth: AuthDto): Promise<AlbumContainerResponseDto[]> {
    const containers = await this.albumContainerRepository.getForUser(auth.user.id);
    const ids = containers.map((c) => c.id);
    // Privacy: recipients shouldn't see the full share graph; only fetch users for owned containers.
    const ownedIds = containers.filter((c) => c.ownerId === auth.user.id).map((c) => c.id);
    const usersByContainer = await this.fetchUsersByContainer(ownedIds);
    const thumbnailsByContainer = await this.albumContainerRepository.getThumbnailAssetIdsForContainers(ids);
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
    const thumbnailsByContainer = await this.albumContainerRepository.getThumbnailAssetIdsForContainers([id]);
    // Privacy: recipients shouldn't see the full share graph, so only the owner gets albumContainerUsers.
    let albumContainerUsers: AlbumContainerUserResponseDto[] | undefined;
    if (isOwner) {
      const usersByContainer = await this.fetchUsersByContainer([id]);
      albumContainerUsers = usersByContainer.get(id) ?? [];
    }
    return this.mapToResponse(container, albumContainerUsers, thumbnailsByContainer.get(id) ?? []);
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
    const thumbnailsByContainer = await this.albumContainerRepository.getThumbnailAssetIdsForContainers([id]);
    return this.mapToResponse(updated!, usersByContainer.get(id) ?? [], thumbnailsByContainer.get(id) ?? []);
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
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
