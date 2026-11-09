import { Injectable } from '@nestjs/common';
import { OnEvent, OnJob } from 'src/decorators.js';
import { BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { TrashResponseDto } from 'src/dtos/trash.dto.js';
import { JobName, JobStatus, Permission, QueueName } from 'src/enum.js';
import { AlbumService } from 'src/services/album.service.js';
import { BaseService } from 'src/services/base.service.js';
import { batched } from 'src/utils/misc.js';

@Injectable()
export class TrashService extends BaseService {
  async restoreAssets(auth: AuthDto, dto: BulkIdsDto): Promise<TrashResponseDto> {
    const { ids } = dto;
    if (ids.length === 0) {
      return { count: 0 };
    }

    await this.requireAccess({ auth, permission: Permission.AssetDelete, ids });
    await this.trashRepository.restoreAll(ids);
    await this.eventRepository.emit('AssetRestoreAll', { assetIds: ids, userId: auth.user.id });

    this.logger.log(`Restored ${ids.length} asset(s) from trash`);

    // Restoring an asset can re-introduce it into a smart album's results.
    await BaseService.create(AlbumService, this).invalidateSmartAlbumsForAssetIdsSafe(ids);

    return { count: ids.length };
  }

  async restore(auth: AuthDto): Promise<TrashResponseDto> {
    const count = await this.trashRepository.restore(auth.user.id);
    if (count > 0) {
      this.logger.log(`Restored ${count} asset(s) from trash`);
      // Affected asset ids aren't easily enumerated here, so invalidate all of the user's
      // smart albums; next read recomputes exactly the ones whose membership shifted.
      await BaseService.create(AlbumService, this).invalidateAllSmartAlbumsForOwnerSafe(auth.user.id);
    }
    return { count };
  }

  async empty(auth: AuthDto): Promise<TrashResponseDto> {
    const count = await this.trashRepository.empty(auth.user.id);
    if (count > 0) {
      await this.jobRepository.queue({ name: JobName.AssetEmptyTrash, data: {} });
      // The actual hard-delete is queued; invalidate now because trashed-but-still-present
      // assets just transitioned to deleted-on-disk.
      await BaseService.create(AlbumService, this).invalidateAllSmartAlbumsForOwnerSafe(auth.user.id);
    }
    return { count };
  }

  @OnEvent({ name: 'AssetDeleteAll' })
  async onAssetsDelete() {
    await this.jobRepository.queue({ name: JobName.AssetEmptyTrash, data: {} });
  }

  @OnJob({ name: JobName.AssetEmptyTrash, queue: QueueName.BackgroundTask })
  async handleEmptyTrash() {
    let count = 0;
    for await (const assets of batched(this.trashRepository.getDeletedIds())) {
      await this.jobRepository.queueAll(
        assets.map(({ id }) => ({ name: JobName.AssetDelete, data: { id, deleteOnDisk: true } })),
      );
      count += assets.length;
    }

    this.logger.log(`Queued ${count} asset(s) for deletion from the trash`);

    return JobStatus.Success;
  }
}
