import { BadRequestException, Injectable } from '@nestjs/common';
import { parse } from 'node:path';
import sanitize from 'sanitize-filename';
import { StorageCore } from 'src/cores/storage.core.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  DownloadArchiveDto,
  DownloadArchiveInfo,
  DownloadInfoDto,
  DownloadResponseDto,
} from 'src/dtos/download.dto.js';
import { toEvaluableSmartAlbumFilter } from 'src/dtos/smart-album-filter.dto.js';
import { AlbumKind, AlbumUserRole, Permission } from 'src/enum.js';
import { ImmichReadStream } from 'src/repositories/storage.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { LockService } from 'src/services/lock.service.js';
import { HumanReadableSize } from 'src/utils/bytes.js';
import { OwnerLockVisibility } from 'src/utils/database.js';
import { NO_REVEALED_LOCKS } from 'src/utils/lock-visibility.js';
import { getPreferences } from 'src/utils/preferences.js';

@Injectable()
export class DownloadService extends BaseService {
  async getDownloadInfo(auth: AuthDto, dto: DownloadInfoDto): Promise<DownloadResponseDto> {
    let assets;
    // Fork (R56): how a still's motion part is judged before its id enters the response - by the caller's direct read
    // rule for requested ids, by the timeline's lock entries for a whole-user download, and not at all for an album,
    // whose grant reaches a motion part through its still.
    let motionRule: { direct: true } | { entries: OwnerLockVisibility[] } | undefined;

    if (dto.assetIds) {
      const assetIds = dto.assetIds;
      await this.requireAccess({ auth, permission: Permission.AssetDownload, ids: assetIds });
      assets = this.downloadRepository.downloadAssetIds(assetIds);
      motionRule = { direct: true };
    } else if (dto.albumId) {
      const albumId = dto.albumId;
      await this.requireAccess({ auth, permission: Permission.AlbumDownload, ids: [albumId] });
      await BaseService.create(LockService, this).assertAlbumVisibleForViewer(auth, albumId);
      // Smart albums stream membership from the filter. A missing/unevaluable filter (e.g.
      // a legacy row whose only fields were sanitized away) downloads NOTHING - explicitly,
      // never via the album_asset path, where legacy/corrupt rows would otherwise surface.
      const album = await this.albumRepository.getById(albumId, { withAssets: false });
      if (album?.kind === AlbumKind.Smart) {
        const ownerId = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)?.user.id;
        const filter = album.filter && ownerId ? toEvaluableSmartAlbumFilter(album.filter) : null;
        assets =
          filter && ownerId
            ? this.downloadRepository.downloadSearchResults({ ...filter, userIds: [ownerId] })
            : this.downloadRepository.downloadAssetIds([]);
      } else {
        assets = this.downloadRepository.downloadAlbumId(albumId);
      }
    } else if (dto.userId) {
      const userId = dto.userId;
      await this.requireAccess({ auth, permission: Permission.TimelineDownload, ids: [userId] });
      // Whole-user downloads respect locked content the same way the timeline does.
      const lockVisibility = await this.lockRepository.getOwnerLockVisibility({
        viewerId: auth.user.id,
        ownerIds: [userId],
        revealed: auth.revealedLocks ?? NO_REVEALED_LOCKS,
        isElevated: !!auth.session?.hasElevatedPermission,
      });
      assets = this.downloadRepository.downloadUserId(userId, lockVisibility);
      motionRule = { entries: lockVisibility };
    } else {
      throw new BadRequestException('assetIds, albumId, or userId is required');
    }

    const targetSize = dto.archiveSize || HumanReadableSize.GiB * 4;
    const metadata = await this.userRepository.getMetadata(auth.user.id);
    const preferences = getPreferences(metadata);
    const stills: { ownerId: string; livePhotoVideoId: string | null }[] = [];
    const archives: DownloadArchiveInfo[] = [];
    let archive: DownloadArchiveInfo = { size: 0, assetIds: [] };

    const addToArchive = ({ id, size }: { id: string; size: number | null }) => {
      archive.assetIds.push(id);
      archive.size += Number(size || 0);

      if (archive.size <= targetSize) {
        return;
      }

      archives.push(archive);
      archive = { size: 0, assetIds: [] };
    };

    for await (const asset of assets) {
      // motion part of live photos
      if (asset.livePhotoVideoId) {
        stills.push(asset);
      }

      addToArchive(asset);
    }

    const lockService = BaseService.create(LockService, this);
    const reachableStills =
      motionRule && 'direct' in motionRule
        ? await lockService.withholdUnreachableMotionIds(auth, stills)
        : await lockService.withholdHiddenMotionIds(stills, motionRule?.entries);
    const motionIds = new Set(reachableStills.flatMap(({ livePhotoVideoId }) => livePhotoVideoId ?? []));
    if (motionIds.size > 0) {
      const motionAssets = this.downloadRepository.downloadMotionAssetIds([...motionIds]);
      for await (const motionAsset of motionAssets) {
        if (StorageCore.isAndroidMotionPath(motionAsset.originalPath) && !preferences.download.includeEmbeddedVideos) {
          continue;
        }

        addToArchive(motionAsset);
      }
    }

    if (archive.assetIds.length > 0) {
      archives.push(archive);
    }

    let totalSize = 0;
    for (const archive of archives) {
      totalSize += archive.size;
    }

    return { totalSize, archives };
  }

  async downloadArchive(auth: AuthDto, dto: DownloadArchiveDto): Promise<ImmichReadStream> {
    await this.requireAccess({ auth, permission: Permission.AssetDownload, ids: dto.assetIds });

    const zip = this.storageRepository.createZipStream();
    const assets = await this.assetRepository.getForOriginals(dto.assetIds, dto.edited ?? false);
    const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
    const paths: Record<string, number> = {};

    for (const assetId of dto.assetIds) {
      const asset = assetMap.get(assetId);
      if (!asset) {
        continue;
      }

      const { originalPath, editedPath, originalFileName } = asset;

      let filename = sanitize(originalFileName) || 'unnamed';
      const count = paths[filename] || 0;
      paths[filename] = count + 1;
      if (count !== 0) {
        const parsedFilename = parse(filename);
        filename = `${parsedFilename.name}+${count}${parsedFilename.ext}`;
      }

      let realpath = dto.edited && editedPath ? editedPath : originalPath;

      try {
        realpath = await this.storageRepository.realpath(realpath);
      } catch {
        this.logger.warn('Unable to resolve realpath', { originalPath });
      }

      zip.addFile(realpath, filename);
    }

    void zip.finalize();

    return {
      stream: zip.stream,
      disposition: dto.archiveName && `attachment; filename*=UTF-8''${encodeURIComponent(dto.archiveName)}.zip`,
    };
  }
}
