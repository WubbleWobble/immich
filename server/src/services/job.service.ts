import { BadRequestException, Injectable } from '@nestjs/common';
import type { AssetRepository } from 'src/repositories/asset.repository.js';
import type { JobItem } from 'src/types.js';
import { OnEvent } from 'src/decorators.js';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { JobCreateDto } from 'src/dtos/job.dto.js';
import { AssetType, AssetVisibility, IntegrityReport, JobName, JobStatus, ManualJobName } from 'src/enum.js';
import { ArgsOf } from 'src/repositories/event.repository.js';
import { AlbumService } from 'src/services/album.service.js';
import { BaseService } from 'src/services/base.service.js';
import { LockService } from 'src/services/lock.service.js';
import { hexOrBufferToBase64 } from 'src/utils/bytes.js';

type UploadReadyAsset = Awaited<ReturnType<AssetRepository['getByIdsWithAllRelationsButStacks']>>[number];

const asJobItem = (dto: JobCreateDto): JobItem => {
  switch (dto.name) {
    case ManualJobName.TagCleanup: {
      return { name: JobName.TagCleanup };
    }

    case ManualJobName.PersonCleanup: {
      return { name: JobName.PersonCleanup };
    }

    case ManualJobName.UserCleanup: {
      return { name: JobName.UserDeleteCheck };
    }

    case ManualJobName.MemoryCleanup: {
      return { name: JobName.MemoryCleanup };
    }

    case ManualJobName.MemoryCreate: {
      return { name: JobName.MemoryGenerate };
    }

    case ManualJobName.BackupDatabase: {
      return { name: JobName.DatabaseBackup };
    }

    case ManualJobName.IntegrityMissingFiles: {
      return { name: JobName.IntegrityMissingFilesQueueAll };
    }

    case ManualJobName.IntegrityUntrackedFiles: {
      return { name: JobName.IntegrityUntrackedFilesQueueAll };
    }

    case ManualJobName.IntegrityChecksumFiles: {
      return { name: JobName.IntegrityChecksumFiles };
    }

    case ManualJobName.IntegrityMissingFilesRefresh: {
      return { name: JobName.IntegrityMissingFilesQueueAll, data: { refreshOnly: true } };
    }

    case ManualJobName.IntegrityUntrackedFilesRefresh: {
      return { name: JobName.IntegrityUntrackedFilesQueueAll, data: { refreshOnly: true } };
    }

    case ManualJobName.IntegrityChecksumFilesRefresh: {
      return { name: JobName.IntegrityChecksumFiles, data: { refreshOnly: true } };
    }

    case ManualJobName.IntegrityMissingFilesDeleteAll: {
      return { name: JobName.IntegrityDeleteReportType, data: { type: IntegrityReport.MissingFile } };
    }

    case ManualJobName.IntegrityUntrackedFilesDeleteAll: {
      return { name: JobName.IntegrityDeleteReportType, data: { type: IntegrityReport.UntrackedFile } };
    }

    case ManualJobName.IntegrityChecksumFilesDeleteAll: {
      return { name: JobName.IntegrityDeleteReportType, data: { type: IntegrityReport.ChecksumFail } };
    }

    default: {
      throw new BadRequestException('Invalid job name');
    }
  }
};

@Injectable()
export class JobService extends BaseService {
  async create(dto: JobCreateDto): Promise<void> {
    await this.jobRepository.queue(asJobItem(dto));
  }

  @OnEvent({ name: 'JobRun' })
  async onJobRun(...[queueName, job]: ArgsOf<'JobRun'>) {
    try {
      await this.eventRepository.emit('JobStart', queueName, job);
      const response = await this.jobRepository.run(job);
      await this.eventRepository.emit('JobSuccess', { job, response });
      if (response && typeof response === 'string' && [JobStatus.Success, JobStatus.Skipped].includes(response)) {
        await this.onDone(job);
      }
    } catch (error: Error | any) {
      await this.eventRepository.emit('JobError', { job, error });
    } finally {
      await this.eventRepository.emit('JobComplete', queueName, job);
    }
  }

  /**
   * Queue follow up jobs
   */
  private async onDone(item: JobItem) {
    switch (item.name) {
      case JobName.SidecarCheck: {
        await this.jobRepository.queue({ name: JobName.AssetExtractMetadata, data: item.data });
        break;
      }

      case JobName.SidecarWrite: {
        await this.jobRepository.queue({
          name: JobName.AssetExtractMetadata,
          data: { id: item.data.id, source: 'sidecar-write' },
        });
        break;
      }

      case JobName.StorageTemplateMigrationSingle: {
        if (item.data.source === 'upload' || item.data.source === 'copy') {
          await this.jobRepository.queue({ name: JobName.AssetGenerateThumbnails, data: item.data });
        }
        break;
      }

      case JobName.PersonGenerateThumbnail: {
        const { ownerId, personGroupId } = item.data;
        // Fork (R60): a person group the owner's ordinary sessions do not list is announced to elevated sessions only.
        const hidden = await this.lockService().isPersonGroupHiddenForOwnerEvents(ownerId, personGroupId);
        for (const room of await this.lockService().getOwnerEventRooms(ownerId, hidden)) {
          this.websocketRepository.clientSend('on_person_thumbnail', room, personGroupId);
        }
        break;
      }

      case JobName.AssetEditThumbnailGeneration: {
        const edited = await this.assetRepository.getById(item.data.id);
        const edits = await this.assetEditRepository.getWithSyncInfo(item.data.id);

        // Fork (R58): judged under the owner's non-elevated direct rule (see LockService.getOwnerEventDeliveries).
        const deliveries = edited ? await this.lockService().getOwnerEventDeliveries([edited]) : [];
        for (const { asset, rooms } of deliveries) {
          for (const room of rooms) {
            this.websocketRepository.clientSend('AssetEditReadyV2', room, {
              asset: {
                id: asset.id,
                ownerId: asset.ownerId,
                originalFileName: asset.originalFileName,
                thumbhash: asset.thumbhash ? hexOrBufferToBase64(asset.thumbhash) : null,
                checksum: hexOrBufferToBase64(asset.checksum),
                fileCreatedAt: asset.fileCreatedAt,
                fileModifiedAt: asset.fileModifiedAt,
                createdAt: asset.createdAt,
                localDateTime: asset.localDateTime,
                duration: asset.duration,
                type: asset.type,
                deletedAt: asset.deletedAt,
                isFavorite: asset.isFavorite,
                visibility: asset.visibility,
                livePhotoVideoId: asset.livePhotoVideoId,
                stackId: asset.stackId,
                libraryId: asset.libraryId,
                width: asset.width,
                height: asset.height,
                isEdited: asset.isEdited,
              },
              edit: edits,
            });
          }
        }

        break;
      }

      case JobName.AssetGenerateThumbnails: {
        if (!item.data.notify && item.data.source !== 'upload') {
          break;
        }

        const [asset] = await this.assetRepository.getByIdsWithAllRelationsButStacks([item.data.id]);
        if (!asset) {
          this.logger.warn(`Could not find asset ${item.data.id} after generating thumbnails`);
          break;
        }

        const jobs: JobItem[] = [
          { name: JobName.SmartSearch, data: item.data },
          { name: JobName.AssetDetectFaces, data: item.data },
          { name: JobName.Ocr, data: item.data },
        ];

        if (asset.type === AssetType.Video) {
          jobs.push({ name: JobName.AssetEncodeVideo, data: item.data });
        }

        await this.jobRepository.queueAll(jobs);

        // Asset has finished its initial post-upload pipeline (EXIF + thumbnail). Smart-album
        // caches for matching filters need to refresh on next read.
        await BaseService.create(AlbumService, this).invalidateSmartAlbumsForAssetsSafe(asset.ownerId, [asset.id]);

        if (asset.visibility === AssetVisibility.Timeline || asset.visibility === AssetVisibility.Archive) {
          // Fork (R58): judged under the owner's non-elevated direct rule (see LockService.getOwnerEventDeliveries).
          const [delivery] = await this.lockService().getOwnerEventDeliveries([asset]);
          for (const room of delivery.rooms) {
            this.sendUploadReady(room, delivery.asset);
          }
        }
        break;
      }

      case JobName.SmartSearch: {
        if (item.data.source === 'upload') {
          await this.jobRepository.queue({ name: JobName.AssetDetectDuplicates, data: item.data });
        }
        break;
      }

      // no default
    }
  }

  private lockService() {
    return BaseService.create(LockService, this);
  }

  /** `on_upload_success` and, with exif, `AssetUploadReadyV2` for one asset to one room. */
  private sendUploadReady(room: string, asset: UploadReadyAsset) {
    this.websocketRepository.clientSend('on_upload_success', room, mapAsset(asset));
    if (!asset.exifInfo) {
      return;
    }

    const exif = asset.exifInfo;
    this.websocketRepository.clientSend('AssetUploadReadyV2', room, {
      // TODO remove `on_upload_success` and then modify the query to select only the required fields)
      asset: {
        id: asset.id,
        ownerId: asset.ownerId,
        originalFileName: asset.originalFileName,
        thumbhash: asset.thumbhash ? hexOrBufferToBase64(asset.thumbhash) : null,
        checksum: hexOrBufferToBase64(asset.checksum),
        fileCreatedAt: asset.fileCreatedAt,
        fileModifiedAt: asset.fileModifiedAt,
        createdAt: asset.createdAt,
        localDateTime: asset.localDateTime,
        duration: asset.duration,
        type: asset.type,
        deletedAt: asset.deletedAt,
        isFavorite: asset.isFavorite,
        visibility: asset.visibility,
        livePhotoVideoId: asset.livePhotoVideoId,
        stackId: asset.stackId,
        libraryId: asset.libraryId,
        width: asset.width,
        height: asset.height,
        isEdited: asset.isEdited,
      },
      exif: {
        assetId: exif.assetId,
        description: exif.description,
        exifImageWidth: exif.exifImageWidth,
        exifImageHeight: exif.exifImageHeight,
        fileSizeInByte: exif.fileSizeInByte,
        orientation: exif.orientation,
        dateTimeOriginal: exif.dateTimeOriginal ? new Date(exif.dateTimeOriginal) : null,
        modifyDate: exif.modifyDate ? new Date(exif.modifyDate) : null,
        timeZone: exif.timeZone,
        latitude: exif.latitude,
        longitude: exif.longitude,
        projectionType: exif.projectionType,
        city: exif.city,
        state: exif.state,
        country: exif.country,
        make: exif.make,
        model: exif.model,
        lensModel: exif.lensModel,
        fNumber: exif.fNumber,
        focalLength: exif.focalLength,
        iso: exif.iso,
        exposureTime: exif.exposureTime,
        profileDescription: exif.profileDescription,
        rating: exif.rating,
        fps: exif.fps,
      },
    });
  }
}
