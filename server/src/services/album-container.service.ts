import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AlbumContainerResponseDto,
  AlbumContainerUserCreateDto,
  AlbumContainerUserUpdateDto,
  CreateAlbumContainerDto,
  UpdateAlbumContainerDto,
} from 'src/dtos/album-container.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { BaseService } from 'src/services/base.service';

const MAX_DEPTH = 16;

@Injectable()
export class AlbumContainerService extends BaseService {
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

    return this.mapToResponse(container);
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
        const isCycle = await this.albumContainerRepository.isDescendantOf(dto.parentId, id);
        if (isCycle) {
          throw new BadRequestException('Cannot move a folder into its own descendant');
        }

        const parentDepth = await this.albumContainerRepository.getDepth(dto.parentId);
        if (parentDepth + 1 > MAX_DEPTH) {
          throw new BadRequestException(`Folder depth exceeds limit of ${MAX_DEPTH}`);
        }
      }
      await this.albumContainerRepository.move(id, dto.parentId);
    }

    if (dto.name !== undefined && dto.name !== container.name) {
      await this.albumContainerRepository.rename(id, dto.name);
    }

    const updated = await this.albumContainerRepository.getById(id);
    return this.mapToResponse(updated!);
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
    await this.albumContainerRepository.removeUser(id, userId);
  }

  private mapToResponse(container: {
    id: string;
    name: string;
    ownerId: string;
    parentId: string | null;
    createdAt: Date | string;
    updatedAt: Date | string;
  }): AlbumContainerResponseDto {
    return {
      id: container.id,
      name: container.name,
      ownerId: container.ownerId,
      parentId: container.parentId,
      createdAt: container.createdAt instanceof Date ? container.createdAt.toISOString() : container.createdAt,
      updatedAt: container.updatedAt instanceof Date ? container.updatedAt.toISOString() : container.updatedAt,
    };
  }
}
