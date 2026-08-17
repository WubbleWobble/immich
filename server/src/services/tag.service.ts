import { BadRequestException, Injectable } from '@nestjs/common';
import { Insertable } from 'kysely';
import { OnJob } from 'src/decorators';
import { BulkIdResponseDto, BulkIdsDto } from 'src/dtos/asset-ids.response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import {
  TagBulkAssetsDto,
  TagBulkAssetsResponseDto,
  TagCreateDto,
  TagResponseDto,
  TagUpdateDto,
  TagUpsertDto,
  mapTag,
} from 'src/dtos/tag.dto';
import { JobName, JobStatus, Permission, QueueName } from 'src/enum';
import { TagAssetTable } from 'src/schema/tables/tag-asset.table';
import { AlbumService } from 'src/services/album.service';
import { BaseService } from 'src/services/base.service';
import { addAssets, removeAssets } from 'src/utils/asset.util';
import { updateLockedColumns } from 'src/utils/database';
import { NO_REVEALED_LOCKS } from 'src/utils/lock-visibility';
import { upsertTags } from 'src/utils/tag';

@Injectable()
export class TagService extends BaseService {
  async getAll(auth: AuthDto) {
    // Tags only attach to the viewer's own assets, so the viewer is the only relevant lock owner.
    const lockVisibility = await this.lockRepository.getOwnerLockVisibility({
      viewerId: auth.user.id,
      ownerIds: [auth.user.id],
      revealed: auth.revealedLocks ?? NO_REVEALED_LOCKS,
      isElevated: !!auth.session?.hasElevatedPermission,
    });
    const tags = await this.tagRepository.getAll(auth.user.id, lockVisibility);
    return tags.map((tag) => mapTag(tag));
  }

  async get(auth: AuthDto, id: string): Promise<TagResponseDto> {
    await this.requireAccess({ auth, permission: Permission.TagRead, ids: [id] });
    const tag = await this.findOrFail(id);
    return mapTag(tag);
  }

  async create(auth: AuthDto, dto: TagCreateDto) {
    let parent;
    if (dto.parentId) {
      await this.requireAccess({ auth, permission: Permission.TagRead, ids: [dto.parentId] });
      parent = await this.tagRepository.get(dto.parentId);
      if (!parent) {
        throw new BadRequestException('Tag not found');
      }
    }

    const userId = auth.user.id;
    const value = parent ? `${parent.value}/${dto.name}` : dto.name;
    const duplicate = await this.tagRepository.getByValue(userId, value);
    if (duplicate) {
      throw new BadRequestException(`A tag with that name already exists`);
    }

    const { color } = dto;
    const tag = await this.tagRepository.create({ userId, value, color, parentId: parent?.id });

    return mapTag(tag);
  }

  async update(auth: AuthDto, id: string, dto: TagUpdateDto): Promise<TagResponseDto> {
    await this.requireAccess({ auth, permission: Permission.TagUpdate, ids: [id] });

    const { color } = dto;
    const tag = await this.tagRepository.update(id, { color });
    return mapTag(tag);
  }

  async upsert(auth: AuthDto, dto: TagUpsertDto) {
    const tags = await upsertTags(this.tagRepository, { userId: auth.user.id, tags: dto.tags });
    return tags.map((tag) => mapTag(tag));
  }

  async remove(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.TagDelete, ids: [id] });

    // TODO sync tag changes for affected assets

    await this.tagRepository.delete(id);

    // Self-heal smart album filters that still reference the deleted tag id. With AND
    // semantics across tagIds, a dangling reference would otherwise make the album match
    // nothing. Safe wrapper: failure here must not abort the tag delete from the user's POV.
    await BaseService.create(AlbumService, this).pruneTagIdsFromSmartAlbumsSafe([id]);
  }

  async bulkTagAssets(auth: AuthDto, dto: TagBulkAssetsDto): Promise<TagBulkAssetsResponseDto> {
    const [tagIds, assetIds] = await Promise.all([
      this.checkAccess({ auth, permission: Permission.TagAsset, ids: dto.tagIds }),
      this.checkAccess({ auth, permission: Permission.AssetUpdate, ids: dto.assetIds }),
    ]);

    const items: Insertable<TagAssetTable>[] = [];
    for (const tagId of tagIds) {
      for (const assetId of assetIds) {
        items.push({ tagId, assetId });
      }
    }

    const results = await this.tagRepository.upsertAssetIds(items);
    const affectedAssetIds = [...new Set(results.map((item) => item.assetId))];
    for (const assetId of affectedAssetIds) {
      await this.updateTags(assetId);
      await this.eventRepository.emit('AssetTag', { assetId });
    }

    // Tag membership shifts can change smart-album results that filter by tagIds.
    await BaseService.create(AlbumService, this).invalidateSmartAlbumsForAssetIdsSafe(affectedAssetIds);

    return { count: results.length };
  }

  async addAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.TagAsset, ids: [id] });

    const results = await addAssets(
      auth,
      { access: this.accessRepository, bulk: this.tagRepository },
      { parentId: id, assetIds: dto.ids },
    );

    const taggedAssetIds: string[] = [];
    for (const { id: assetId, success } of results) {
      if (success) {
        await this.updateTags(assetId);
        await this.eventRepository.emit('AssetTag', { assetId });
        taggedAssetIds.push(assetId);
      }
    }

    await BaseService.create(AlbumService, this).invalidateSmartAlbumsForAssetIdsSafe(taggedAssetIds);

    return results;
  }

  async removeAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.TagAsset, ids: [id] });

    const results = await removeAssets(
      auth,
      { access: this.accessRepository, bulk: this.tagRepository },
      { parentId: id, assetIds: dto.ids, canAlwaysRemove: Permission.TagDelete },
    );

    const untaggedAssetIds: string[] = [];
    for (const { id: assetId, success } of results) {
      if (success) {
        await this.updateTags(assetId);
        await this.eventRepository.emit('AssetUntag', { assetId });
        untaggedAssetIds.push(assetId);
      }
    }

    await BaseService.create(AlbumService, this).invalidateSmartAlbumsForAssetIdsSafe(untaggedAssetIds);

    return results;
  }

  @OnJob({ name: JobName.TagCleanup, queue: QueueName.BackgroundTask })
  async handleTagCleanup() {
    const deletedIds = await this.tagRepository.deleteEmptyTags();
    if (deletedIds.length > 0) {
      // Self-heal any smart album filters that still reference the cleaned-up tag ids.
      await BaseService.create(AlbumService, this).pruneTagIdsFromSmartAlbumsSafe(deletedIds);
    }
    return JobStatus.Success;
  }

  private async findOrFail(id: string) {
    const tag = await this.tagRepository.get(id);
    if (!tag) {
      throw new BadRequestException('Tag not found');
    }
    return tag;
  }

  private async updateTags(assetId: string) {
    const { tags } = await this.assetRepository.getForUpdateTags(assetId);
    await this.assetRepository.upsertExif({
      exif: updateLockedColumns({ assetId, tags: tags.map(({ value }) => value) }),
      lockedPropertiesBehavior: 'append',
    });
  }
}
