import { basename, dirname, join, resolve, sep } from 'node:path';
import { v5 as uuidv5 } from 'uuid';
import type { VideoInterfaces } from 'src/types.js';
import { StorageAsset } from 'src/database.js';
import {
  AssetFileType,
  AssetPathType,
  ImageFormat,
  PathType,
  PersonPathType,
  RawExtractedFormat,
  StorageFolder,
  UserPathType,
} from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MoveRepository } from 'src/repositories/move.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { getAssetFile } from 'src/utils/asset.util.js';
import { getConfig } from 'src/utils/config.js';

export interface MoveRequest {
  entityId: string;
  /** a person is owned, so the owner is needed to save the new path */
  ownerId?: string;
  pathType: PathType;
  oldPath: string | null;
  newPath: string;
  assetInfo?: {
    sizeInBytes: number;
    checksum: Buffer;
  };
}

export type ThumbnailPathEntity = { id: string; ownerId: string };

export type PersonThumbnailPathEntity = { personGroupId: string; ownerId: string };

/** fork: one immutable file per thumbnail generation; `generationId` is a fresh uuidv7 */
export type PersonThumbnailGeneration = PersonThumbnailPathEntity & { generationId: string };

/** fork: a person row's published thumbnail pair, as a move reads it */
export type PersonThumbnailMoveEntity = PersonThumbnailPathEntity & {
  thumbnailPath: string;
  thumbnailSourceFaceId: string | null;
};

/**
 * Fork: namespace for per-owner person move keys. `move_history` is unique on (entityId, pathType), and a person group
 * id is shared by every owner of a shared person, so face moves are keyed by uuidv5(ownerId:personGroupId) instead.
 * Never change this value: keys of unfinished moves are derived from it.
 */
export const FORK_PERSON_MOVE_NS = '3f0a2d55-8c1e-4b7a-9d6e-5b2c1f8e4a90';

export type HlsSessionFolder = { ownerId: string; sessionId: string };

export type HlsVariantFolder = { ownerId: string; sessionId: string; variantIndex: number };

export type ImagePathOptions = { fileType: AssetFileType; format: ImageFormat | RawExtractedFormat; isEdited: boolean };

let instance: StorageCore | null;

let mediaLocation: string | undefined;

export class StorageCore {
  private constructor(
    private assetRepository: AssetRepository,
    private configRepository: ConfigRepository,
    private cryptoRepository: CryptoRepository,
    private moveRepository: MoveRepository,
    private personRepository: PersonRepository,
    private storageRepository: StorageRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(StorageCore.name);
  }

  static create(
    assetRepository: AssetRepository,
    configRepository: ConfigRepository,
    cryptoRepository: CryptoRepository,
    moveRepository: MoveRepository,
    personRepository: PersonRepository,
    storageRepository: StorageRepository,
    systemMetadataRepository: SystemMetadataRepository,
    logger: LoggingRepository,
  ) {
    if (!instance) {
      instance = new StorageCore(
        assetRepository,
        configRepository,
        cryptoRepository,
        moveRepository,
        personRepository,
        storageRepository,
        systemMetadataRepository,
        logger,
      );
    }

    return instance;
  }

  static reset() {
    instance = null;
  }

  static getMediaLocation(): string {
    if (mediaLocation === undefined) {
      throw new Error('Media location is not set.');
    }

    return mediaLocation;
  }

  static setMediaLocation(location: string) {
    mediaLocation = location;
  }

  static getFolderLocation(folder: StorageFolder, userId: string) {
    return join(StorageCore.getBaseFolder(folder), userId);
  }

  static getLibraryFolder(user: { storageLabel: string | null; id: string }) {
    return join(StorageCore.getBaseFolder(StorageFolder.Library), user.storageLabel || user.id);
  }

  static getBaseFolder(folder: StorageFolder) {
    return join(StorageCore.getMediaLocation(), folder);
  }

  /** Fork: `<thumbs>/<ownerId>/<xx>/<yy>/<personGroupId>-<generationId>.jpeg`; a published file is never rewritten. */
  static getPersonThumbnailPath({ ownerId, personGroupId, generationId }: PersonThumbnailGeneration) {
    return StorageCore.getNestedPath(StorageFolder.Thumbnails, ownerId, `${personGroupId}-${generationId}.jpeg`);
  }

  /** Fork: the move_history key of one owner's person thumbnail (see FORK_PERSON_MOVE_NS). */
  static getPersonMoveKey(ownerId: string, personGroupId: string) {
    return uuidv5(`${ownerId}:${personGroupId}`, FORK_PERSON_MOVE_NS);
  }

  static getImagePath(asset: ThumbnailPathEntity, { fileType, format, isEdited }: ImagePathOptions) {
    return StorageCore.getNestedPath(
      StorageFolder.Thumbnails,
      asset.ownerId,
      `${asset.id}_${fileType}${isEdited ? '_edited' : ''}.${format}`,
    );
  }

  static getEncodedVideoPath(asset: ThumbnailPathEntity) {
    return StorageCore.getNestedPath(StorageFolder.EncodedVideo, asset.ownerId, `${asset.id}.mp4`);
  }

  static getHlsSessionFolder({ ownerId, sessionId }: HlsSessionFolder) {
    return StorageCore.getNestedPath(StorageFolder.EncodedVideo, ownerId, sessionId);
  }

  static getHlsVariantFolder({ ownerId, sessionId, variantIndex }: HlsVariantFolder) {
    return join(StorageCore.getHlsSessionFolder({ ownerId, sessionId }), variantIndex.toString());
  }

  static getAndroidMotionPath(asset: ThumbnailPathEntity, uuid: string) {
    return StorageCore.getNestedPath(StorageFolder.EncodedVideo, asset.ownerId, `${uuid}-MP.mp4`);
  }

  static isAndroidMotionPath(originalPath: string) {
    return originalPath.startsWith(StorageCore.getBaseFolder(StorageFolder.EncodedVideo));
  }

  static isImmichPath(path: string) {
    const resolvedPath = resolve(path);
    const resolvedAppMediaLocation = StorageCore.getMediaLocation();
    const normalizedPath = resolvedPath.endsWith('/') ? resolvedPath : resolvedPath + '/';
    const normalizedAppMediaLocation = resolvedAppMediaLocation.endsWith('/')
      ? resolvedAppMediaLocation
      : resolvedAppMediaLocation + '/';
    return normalizedPath.startsWith(normalizedAppMediaLocation);
  }

  async moveAssetImage(asset: StorageAsset, fileType: AssetFileType, format: ImageFormat) {
    const { id: entityId, files } = asset;
    const oldFile = getAssetFile(files, fileType, { isEdited: false });
    return this.moveFile({
      entityId,
      pathType: fileType,
      oldPath: oldFile?.path || null,
      newPath: StorageCore.getImagePath(asset, { fileType, format, isEdited: false }),
    });
  }

  async moveAssetVideo(asset: StorageAsset) {
    const encodedVideoFile = getAssetFile(asset.files, AssetFileType.EncodedVideo, { isEdited: false });
    return this.moveFile({
      entityId: asset.id,
      pathType: AssetPathType.EncodedVideo,
      oldPath: encodedVideoFile?.path || null,
      newPath: StorageCore.getEncodedVideoPath(asset),
    });
  }

  async movePersonFile(person: PersonThumbnailMoveEntity, pathType: PersonPathType) {
    switch (pathType) {
      case PersonPathType.Face: {
        await this.movePersonFace(person);
      }
    }
  }

  /**
   * Fork: relocate one owner's published person thumbnail into the current layout, keeping its basename (the
   * generation) and its source. Unlike moveFile, the publish is conditional - it applies only while the row still
   * holds the generation this move read - so a regeneration that publishes meanwhile always wins and a relocated
   * old crop can never end up paired with a newer source. A publish that matches nothing, and every resumed move,
   * goes through settlePersonMove (completed / pending / obsolete).
   */
  private async movePersonFace(person: PersonThumbnailMoveEntity) {
    const { ownerId, personGroupId, thumbnailPath: oldPath, thumbnailSourceFaceId: sourceFaceId } = person;
    const pathType = PersonPathType.Face;

    // upstream keyed person moves by personGroupId, which every owner of a shared person has in common; such a row
    // could relocate another owner's file, so it is never acted on
    const legacy = await this.moveRepository.getByEntity(personGroupId, pathType);
    if (legacy) {
      this.logger.warn(
        `[fork] foreign move_history row ignored: ${legacy.id} (${legacy.oldPath} => ${legacy.newPath})`,
      );
    }

    const entityId = StorageCore.getPersonMoveKey(ownerId, personGroupId);
    const move = await this.moveRepository.getByEntity(entityId, pathType);
    if (move) {
      if (
        !StorageCore.isOwnPersonThumbnailPath(move.oldPath, person) ||
        !StorageCore.isOwnPersonThumbnailPath(move.newPath, person)
      ) {
        this.logger.warn(`[fork] foreign move_history row ignored: ${move.id} (${move.oldPath} => ${move.newPath})`);
        return;
      }

      this.logger.log(`Attempting to finish incomplete move: ${move.oldPath} => ${move.newPath}`);
      await this.settlePersonMove(move, person, sourceFaceId);
      return;
    }

    if (!oldPath) {
      return;
    }

    const newPath = StorageCore.getNestedPath(StorageFolder.Thumbnails, ownerId, basename(oldPath));
    if (oldPath === newPath) {
      return;
    }

    // only files this row can own are moved: anything else (pre-upgrade `<group>.jpeg` crops, files named after
    // another group after a merge) stays where it is until regeneration replaces it, and never gets a history row
    // that a resume would have to reject
    if (!StorageCore.isOwnPersonThumbnailPath(oldPath, person)) {
      this.logger.debug(`Not moving person thumbnail ${oldPath}: not a generation file of ${ownerId}/${personGroupId}`);
      return;
    }

    this.ensureFolders(newPath);
    const created = await this.moveRepository.create({ entityId, pathType, oldPath, newPath });
    if (!(await this.relocatePersonFile(oldPath, newPath))) {
      return;
    }

    const published = await this.personRepository.updateThumbnailPathIfUnchanged({
      ownerId,
      personGroupId,
      oldPath,
      newPath,
      sourceFaceId,
    });
    if (published) {
      await this.moveRepository.delete(created.id);
      return;
    }

    await this.settlePersonMove(created, person, sourceFaceId);
  }

  /**
   * Fork: decide what an unfinished person move means from the row's CURRENT pair. `capturedSourceFaceId` is the
   * source the move read with the row. Never unlinks a path that some person row references.
   * - completed (row already points at newPath, e.g. a crash after the publish): keep newPath, drop the history, and
   *   remove an unreferenced leftover at oldPath;
   * - pending (row still holds oldPath with the captured source): finish with the conditional publish;
   * - obsolete (anything else, e.g. regeneration replaced it): remove an unreferenced newPath, drop the history, and
   *   leave the newer pair untouched.
   */
  private async settlePersonMove(
    move: { id: string; oldPath: string; newPath: string },
    { ownerId, personGroupId }: PersonThumbnailPathEntity,
    capturedSourceFaceId: string | null,
    canFinish = true,
  ): Promise<void> {
    const current = await this.personRepository.getThumbnailPair({ ownerId, personGroupId });

    if (current?.thumbnailPath === move.newPath) {
      if (
        (await this.storageRepository.checkFileExists(move.oldPath)) &&
        !(await this.personRepository.isThumbnailPathReferenced(move.oldPath))
      ) {
        await this.storageRepository.unlink(move.oldPath);
      }
      await this.moveRepository.delete(move.id);
      return;
    }

    const isPending = current?.thumbnailPath === move.oldPath && current.thumbnailSourceFaceId === capturedSourceFaceId;
    if (isPending) {
      if (!canFinish) {
        this.logger.warn(`Unable to complete move ${move.oldPath} => ${move.newPath}; it will be retried`);
        return;
      }

      this.ensureFolders(move.newPath);
      if (!(await this.relocatePersonFile(move.oldPath, move.newPath))) {
        return;
      }

      const published = await this.personRepository.updateThumbnailPathIfUnchanged({
        ownerId,
        personGroupId,
        oldPath: move.oldPath,
        newPath: move.newPath,
        sourceFaceId: capturedSourceFaceId,
      });
      if (published) {
        await this.moveRepository.delete(move.id);
        return;
      }

      await this.settlePersonMove(move, { ownerId, personGroupId }, capturedSourceFaceId, false);
      return;
    }

    this.logger.log(`Discarding obsolete move ${move.oldPath} => ${move.newPath}: the thumbnail was replaced`);
    if (!(await this.personRepository.isThumbnailPathReferenced(move.newPath))) {
      await this.storageRepository.unlink(move.newPath);
    }
    await this.moveRepository.delete(move.id);
  }

  /** Fork: put the file at newPath (rename, or copy-verify-delete across devices). True when it is there. */
  private async relocatePersonFile(oldPath: string, newPath: string): Promise<boolean> {
    if (!(await this.storageRepository.checkFileExists(oldPath))) {
      if (await this.storageRepository.checkFileExists(newPath)) {
        return true;
      }
      this.logger.warn(`Unable to complete move. File does not exist at either location: ${oldPath}, ${newPath}`);
      return false;
    }

    try {
      await this.storageRepository.rename(oldPath, newPath);
      return true;
    } catch (error: any) {
      if (error.code !== 'EXDEV') {
        this.logger.warn(`Unable to complete move. Error renaming file with code ${error.code}: ${error.message}`);
        return false;
      }
    }

    await this.storageRepository.copyFile(oldPath, newPath);
    if (!(await this.verifyNewPathContentsMatchesExpected(oldPath, newPath))) {
      this.logger.warn(`Skipping move due to file size mismatch`);
      await this.storageRepository.unlink(newPath);
      return false;
    }

    const { atime, mtime } = await this.storageRepository.stat(oldPath);
    await this.storageRepository.utimes(newPath, atime, mtime);
    try {
      await this.storageRepository.unlink(oldPath);
    } catch (error: any) {
      this.logger.warn(`Unable to delete old file, it will now no longer be tracked by Immich: ${error.message}`);
    }
    return true;
  }

  /**
   * Fork: a path a person move may act on - inside the owner's own thumbs folder, named after the person group
   * (`<personGroupId>-<generationId>.jpeg`).
   */
  static isOwnPersonThumbnailPath(path: string, { ownerId, personGroupId }: PersonThumbnailPathEntity) {
    const root = resolve(StorageCore.getFolderLocation(StorageFolder.Thumbnails, ownerId)) + sep;
    return resolve(path).startsWith(root) && basename(path).startsWith(`${personGroupId}-`);
  }

  async moveFile(request: MoveRequest) {
    const { entityId, ownerId, pathType, oldPath, newPath, assetInfo } = request;
    if (!oldPath || oldPath === newPath) {
      return;
    }

    this.ensureFolders(newPath);

    let move = await this.moveRepository.getByEntity(entityId, pathType);
    if (move) {
      this.logger.log(`Attempting to finish incomplete move: ${move.oldPath} => ${move.newPath}`);
      const isOldPathExists = await this.storageRepository.checkFileExists(move.oldPath);
      const isNewPathExists = await this.storageRepository.checkFileExists(move.newPath);
      const newPathCheck = isNewPathExists ? move.newPath : null;
      const actualPath = isOldPathExists ? move.oldPath : newPathCheck;
      if (!actualPath) {
        this.logger.warn('Unable to complete move. File does not exist at either location.');
        return;
      }

      const isFileAtNewLocation = actualPath === move.newPath;
      this.logger.log(`Found file at ${isFileAtNewLocation ? 'new' : 'old'} location`);

      if (
        isFileAtNewLocation &&
        !(await this.verifyNewPathContentsMatchesExpected(move.oldPath, move.newPath, assetInfo))
      ) {
        this.logger.fatal(
          `Skipping move as file verification failed, old file is missing and new file is different to what was expected`,
        );
        return;
      }

      move = await this.moveRepository.update(move.id, { id: move.id, oldPath: actualPath, newPath });
    } else {
      move = await this.moveRepository.create({ entityId, pathType, oldPath, newPath });
    }

    if (pathType === AssetPathType.Original && !assetInfo) {
      this.logger.warn(`Unable to complete move. Missing asset info for ${entityId}`);
      return;
    }

    if (move.oldPath !== newPath) {
      try {
        this.logger.debug(`Attempting to rename file: ${move.oldPath} => ${newPath}`);
        await this.storageRepository.rename(move.oldPath, newPath);
      } catch (error: any) {
        if (error.code !== 'EXDEV') {
          this.logger.warn(
            `Unable to complete move. Error renaming file with code ${error.code} and message: ${error.message}`,
          );
          return;
        }
        this.logger.debug(`Unable to rename file. Falling back to copy, verify and delete`);
        await this.storageRepository.copyFile(move.oldPath, newPath);

        if (!(await this.verifyNewPathContentsMatchesExpected(move.oldPath, newPath, assetInfo))) {
          this.logger.warn(`Skipping move due to file size mismatch`);
          await this.storageRepository.unlink(newPath);
          return;
        }

        const { atime, mtime } = await this.storageRepository.stat(move.oldPath);
        await this.storageRepository.utimes(newPath, atime, mtime);

        try {
          await this.storageRepository.unlink(move.oldPath);
        } catch (error: any) {
          this.logger.warn(`Unable to delete old file, it will now no longer be tracked by Immich: ${error.message}`);
        }
      }
    }

    await this.savePath(pathType, entityId, newPath, ownerId);
    await this.moveRepository.delete(move.id);
  }

  private async verifyNewPathContentsMatchesExpected(
    oldPath: string,
    newPath: string,
    assetInfo?: { sizeInBytes: number; checksum: Buffer },
  ) {
    const oldStat = await this.storageRepository.stat(oldPath);
    const newStat = await this.storageRepository.stat(newPath);
    const oldPathSize = assetInfo ? assetInfo.sizeInBytes : oldStat.size;
    const newPathSize = newStat.size;
    this.logger.debug(`File size check: ${newPathSize} === ${oldPathSize}`);
    if (newPathSize !== oldPathSize) {
      this.logger.warn(`Unable to complete move. File size mismatch: ${newPathSize} !== ${oldPathSize}`);
      return false;
    }
    const repos = {
      configRepo: this.configRepository,
      metadataRepo: this.systemMetadataRepository,
      logger: this.logger,
    };
    const config = await getConfig(repos, { withCache: true });
    if (assetInfo && config.storageTemplate.hashVerificationEnabled) {
      const { checksum } = assetInfo;
      const newChecksum = await this.cryptoRepository.hashFile(newPath);
      if (!newChecksum.equals(checksum)) {
        this.logger.warn(
          `Unable to complete move. File checksum mismatch: ${newChecksum.toString('base64')} !== ${checksum.toString(
            'base64',
          )}`,
        );
        return false;
      }
      this.logger.debug(`File checksum check: ${newChecksum.toString('base64')} === ${checksum.toString('base64')}`);
    }
    return true;
  }

  ensureFolders(input: string) {
    this.storageRepository.mkdirSync(dirname(input));
  }

  removeEmptyDirs(folder: StorageFolder) {
    return this.storageRepository.removeEmptyDirs(StorageCore.getBaseFolder(folder));
  }

  async getVideoInterfaces(): Promise<VideoInterfaces> {
    const [dri, mali] = await Promise.all([this.getDevices(), this.hasMaliOpenCL()]);
    return { dri, mali };
  }

  private savePath(pathType: PathType, id: string, newPath: string, ownerId?: string) {
    switch (pathType) {
      case AssetPathType.Original: {
        return this.assetRepository.update({ id, originalPath: newPath });
      }

      case AssetFileType.FullSize:
      case AssetFileType.EncodedVideo:
      case AssetFileType.Thumbnail:
      case AssetFileType.Preview:
      case AssetFileType.Sidecar:
      case AssetPathType.EncodedVideo: {
        return this.assetRepository.upsertFile({ assetId: id, type: pathType as AssetFileType, path: newPath });
      }

      case PersonPathType.Face: {
        // fork: person thumbnails move through movePersonFace, whose publish is conditional on the generation; an
        // unconditional path write here could pair an old crop with a newer source
        this.logger.error(`Refusing unconditional person thumbnail path update for ${ownerId}/${id}`);
        return;
      }

      case UserPathType.Profile: {
        this.logger.warn('Unexpected path type:', pathType);
        return;
      }
    }
  }

  static getNestedFolder(folder: StorageFolder, ownerId: string, filename: string): string {
    return join(StorageCore.getFolderLocation(folder, ownerId), filename.slice(0, 2), filename.slice(2, 4));
  }

  static getNestedPath(folder: StorageFolder, ownerId: string, filename: string): string {
    return join(StorageCore.getNestedFolder(folder, ownerId, filename), filename);
  }

  private async getDevices() {
    try {
      return await this.storageRepository.readdir('/dev/dri');
    } catch {
      this.logger.debug('No devices found in /dev/dri.');
      return [];
    }
  }

  private async hasMaliOpenCL() {
    try {
      const [maliIcdStat, maliDeviceStat] = await Promise.all([
        this.storageRepository.stat('/etc/OpenCL/vendors/mali.icd'),
        this.storageRepository.stat('/dev/mali0'),
      ]);
      return maliIcdStat.isFile() && maliDeviceStat.isCharacterDevice();
    } catch {
      this.logger.debug('OpenCL not available for transcoding, so RKMPP acceleration will use CPU tonemapping');
      return false;
    }
  }
}
