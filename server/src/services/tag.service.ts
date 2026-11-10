import { BadRequestException, Injectable } from '@nestjs/common';
import { Insertable } from 'kysely';
import { OnJob } from 'src/decorators.js';
import { BulkIdErrorReason, BulkIdResponseDto, BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  TagBulkAssetsDto,
  TagBulkAssetsResponseDto,
  TagCreateDto,
  TagResponseDto,
  TagUpdateDto,
  TagUpsertDto,
  mapTag,
} from 'src/dtos/tag.dto.js';
import { JobName, JobStatus, Permission, QueueName } from 'src/enum.js';
import { TagAssetTable } from 'src/schema/tables/tag-asset.table.js';
import { AlbumService } from 'src/services/album.service.js';
import { BaseService } from 'src/services/base.service.js';
import { addAssets, removeAssets } from 'src/utils/asset.util.js';
import { updateLockedColumns } from 'src/utils/database.js';
import { NO_REVEALED_LOCKS } from 'src/utils/lock-visibility.js';
import { findOrFail } from 'src/utils/misc.js';
import { upsertTags } from 'src/utils/tag.js';

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

    const { name, color } = dto;
    const existing = await this.findOrFail(id);

    let value;
    if (name) {
      const parts = existing.value.split('/');
      parts[parts.length - 1] = name;
      value = parts.join('/');
    } else {
      value = existing.value;
    }

    const assetIds = value === existing.value ? [] : await this.tagRepository.getAssetIdsByTagId(id);
    const tag = await this.tagRepository.update(id, { value, color });
    await this.syncAssetTags(assetIds);
    return mapTag(tag);
  }

  async upsert(auth: AuthDto, dto: TagUpsertDto) {
    const tags = await upsertTags(this.tagRepository, { userId: auth.user.id, tags: dto.tags });
    return tags.map((tag) => mapTag(tag));
  }

  async remove(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.TagDelete, ids: [id] });
    // Fork (rulings R71, R72): deleting a tag (or an ancestor) untags every photo below it at once, hidden ones
    // included, and a photo that only a locked smart album filtering on the tag was hiding would become visible.
    await this.requireElevationForLockSensitiveWrite(auth);

    const assetIds = await this.tagRepository.getAssetIdsByTagId(id);
    await this.tagRepository.delete(id);
    // Fork lock audit (54987c764): a consistency write over the tag owner's assets, hidden ones included (see
    // getAssetIdsByTagId); nothing about them is returned.
    await this.syncAssetTags(assetIds);

    // D12: smart-album filters keep the deleted tag id; it dangles and zero-matches. Rewriting the filter instead
    // would drop a restriction and broaden what an already-shared album exposes. The assets that lost the tag (and
    // its descendants) may have left some smart albums, so their owners' caches are invalidated. Safe wrapper:
    // failure here must not abort the tag delete from the user's POV.
    await BaseService.create(AlbumService, this).invalidateSmartAlbumsForAssetIdsSafe(assetIds);
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
      await this.eventRepository.emit('AssetTag', { assetId, userId: auth.user.id });
    }

    // Tag membership shifts can change smart-album results that filter by tagIds.
    await BaseService.create(AlbumService, this).invalidateSmartAlbumsForAssetIdsSafe(affectedAssetIds);

    return { count: results.length };
  }

  async addAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.TagAsset, ids: [id] });

    // Fork (ruling R32): the helper answers `duplicate` before it checks the asset, which would tell an ordinary
    // session that a photo hidden for it carries this tag. Only photos the caller may update reach it; every other id
    // gets the answer of a missing or foreign photo.
    const updatableIds = await this.checkAccess({ auth, permission: Permission.AssetUpdate, ids: dto.ids });
    const added = await addAssets(
      auth,
      { access: this.accessRepository, bulk: this.tagRepository },
      {
        parentId: id,
        assetIds: dto.ids.filter((assetId) => updatableIds.has(assetId)),
        permission: Permission.AssetUpdate,
      },
    );
    const addedById = new Map(added.map((result) => [result.id, result]));
    const results: BulkIdResponseDto[] = dto.ids.map(
      (assetId) => addedById.get(assetId) ?? { id: assetId, success: false, error: BulkIdErrorReason.NO_PERMISSION },
    );

    const taggedAssetIds: string[] = [];
    for (const { id: assetId, success } of results) {
      if (!success) {
        continue;
      }

      await this.updateTags(assetId);
      await this.eventRepository.emit('AssetTag', { assetId, userId: auth.user.id });
      taggedAssetIds.push(assetId);
    }

    await BaseService.create(AlbumService, this).invalidateSmartAlbumsForAssetIdsSafe(taggedAssetIds);

    return results;
  }

  async removeAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.TagAsset, ids: [id] });

    // Fork (ruling R71): untagging edits the photo, so it takes the same permission as tagging it - asset.update,
    // which leaves out photos hidden for the caller outside an elevated session. The tag owner's "can always remove"
    // shortcut alone would untag a hidden photo and release it from a locked smart album filtering on the tag. A
    // photo the caller may not update is reported like one that does not carry the tag (ruling R32).
    const updatableIds = await this.checkAccess({ auth, permission: Permission.AssetUpdate, ids: dto.ids });
    const removed = await removeAssets(
      auth,
      { access: this.accessRepository, bulk: this.tagRepository },
      {
        parentId: id,
        assetIds: dto.ids.filter((assetId) => updatableIds.has(assetId)),
        canAlwaysRemove: Permission.TagDelete,
      },
    );
    const removedById = new Map(removed.map((result) => [result.id, result]));
    const results: BulkIdResponseDto[] = dto.ids.map(
      (assetId) => removedById.get(assetId) ?? { id: assetId, success: false, error: BulkIdErrorReason.NOT_FOUND },
    );

    const untaggedAssetIds: string[] = [];
    for (const { id: assetId, success } of results) {
      if (!success) {
        continue;
      }

      await this.updateTags(assetId);
      await this.eventRepository.emit('AssetUntag', { assetId });
      untaggedAssetIds.push(assetId);
    }

    await BaseService.create(AlbumService, this).invalidateSmartAlbumsForAssetIdsSafe(untaggedAssetIds);

    return results;
  }

  @OnJob({ name: JobName.TagCleanup, queue: QueueName.BackgroundTask })
  async handleTagCleanup() {
    // D12: smart-album filters keep the deleted ids (they dangle and zero-match). An empty tag tagged nothing, so
    // no smart album's membership or cache changes.
    await this.tagRepository.deleteEmptyTags();
    return JobStatus.Success;
  }

  private findOrFail(id: string) {
    return findOrFail(() => this.tagRepository.get(id), 'Tag');
  }

  private async updateTags(assetId: string) {
    const { tags } = await this.assetRepository.getForUpdateTags(assetId);
    await this.assetRepository.upsertExif({
      exif: updateLockedColumns({ assetId, tags: tags.map(({ value }) => value) }),
      lockedPropertiesBehavior: 'append',
    });
  }

  private async syncAssetTags(assetIds: string[]) {
    if (assetIds.length === 0) {
      return;
    }

    for (const assetId of assetIds) {
      await this.updateTags(assetId);
    }

    await this.jobRepository.queueAll(assetIds.map((id) => ({ name: JobName.SidecarWrite, data: { id } })));
  }
}
