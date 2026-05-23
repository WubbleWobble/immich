import { Injectable } from '@nestjs/common';
import { JOBS_ASSET_PAGINATION_SIZE } from 'src/constants';
import { OnEvent, OnJob } from 'src/decorators';
import { BulkIdsDto } from 'src/dtos/asset-ids.response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { TrashResponseDto } from 'src/dtos/trash.dto';
import { JobName, JobStatus, Permission, QueueName } from 'src/enum';
import { AlbumService } from 'src/services/album.service';
import { BaseService } from 'src/services/base.service';

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
    const assets = this.trashRepository.getDeletedIds();

    let count = 0;
    const batch: string[] = [];
    for await (const { id } of assets) {
      batch.push(id);

      if (batch.length === JOBS_ASSET_PAGINATION_SIZE) {
        await this.handleBatch(batch);
        count += batch.length;
        batch.length = 0;
      }
    }

    await this.handleBatch(batch);
    count += batch.length;
    batch.length = 0;

    this.logger.log(`Queued ${count} asset(s) for deletion from the trash`);

    return JobStatus.Success;
  }

  private async handleBatch(ids: string[]) {
    this.logger.debug(`Queueing ${ids.length} asset(s) for deletion from the trash`);
    await this.jobRepository.queueAll(
      ids.map((assetId) => ({
        name: JobName.AssetDelete,
        data: {
          id: assetId,
          deleteOnDisk: true,
        },
      })),
    );
  }
}
