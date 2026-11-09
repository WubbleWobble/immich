import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PostgresError } from 'postgres';
import { AssetIdErrorReason, AssetIdsResponseDto } from 'src/dtos/asset-ids.response.dto.js';
import { AssetIdsDto } from 'src/dtos/asset.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  SharedLinkCreateDto,
  SharedLinkEditDto,
  SharedLinkLoginDto,
  SharedLinkResponseDto,
  SharedLinkSearchDto,
  mapSharedLink,
} from 'src/dtos/shared-link.dto.js';
import { AlbumKind, Permission, SharedLinkType } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { LockService, SharedLinkLockTarget } from 'src/services/lock.service.js';
import { OpenGraphTags, findOrFail, getExternalDomain } from 'src/utils/misc.js';

/**
 * Fork (R36-5): a smart album has no stored membership, so a link to one cannot accept uploads. An explicit request
 * for uploads is refused rather than silently dropped; leaving it unspecified defaults to no uploads.
 */
const assertUploadAllowed = (isSmartAlbum: boolean, allowUpload: boolean | undefined) => {
  if (isSmartAlbum && allowUpload === true) {
    throw new BadRequestException('Smart albums do not accept uploads');
  }
};

@Injectable()
export class SharedLinkService extends BaseService {
  async getAll(auth: AuthDto, { id, albumId }: SharedLinkSearchDto): Promise<SharedLinkResponseDto[]> {
    const links = await this.sharedLinkRepository.getAll({ userId: auth.user.id, id, albumId });
    // Fork (spec §15.3, audit 1): a list surface omits links exposing content hidden for the manager - no key, no
    // metadata - unless the manager's own lock is revealed in an elevated session.
    const hidden = await this.lockService().getHiddenSharedLinkIds(auth, links);
    return links
      .filter((link) => !hidden.has(link.id))
      .map((link) => mapSharedLink(link, { stripAssetMetadata: false }));
  }

  async login(auth: AuthDto, dto: SharedLinkLoginDto) {
    if (!auth.sharedLink) {
      throw new ForbiddenException();
    }

    const sharedLink = await this.findOrFail(auth.user.id, auth.sharedLink.id);
    const { id, password } = sharedLink;

    if (!password) {
      throw new BadRequestException('Shared link is not password protected');
    }

    if (password !== dto.password) {
      throw new UnauthorizedException('Invalid password');
    }

    return {
      sharedLink: mapSharedLink(sharedLink, { stripAssetMetadata: !sharedLink.showExif }),
      token: this.asToken({ id, password }),
    };
  }

  async getMine(auth: AuthDto, authTokens: string[]) {
    if (!auth.sharedLink) {
      throw new ForbiddenException();
    }

    const sharedLink = await this.findOrFail(auth.user.id, auth.sharedLink.id);
    const { id, password } = sharedLink;

    if (password && !authTokens.includes(this.asToken({ id, password }))) {
      throw new UnauthorizedException('Password required');
    }

    return mapSharedLink(sharedLink, { stripAssetMetadata: !sharedLink.showExif });
  }

  async get(auth: AuthDto, id: string): Promise<SharedLinkResponseDto> {
    const sharedLink = await this.findManageableOrFail(auth, id);
    return mapSharedLink(sharedLink, { stripAssetMetadata: false });
  }

  async create(auth: AuthDto, dto: SharedLinkCreateDto): Promise<SharedLinkResponseDto> {
    let isSmartAlbum = false;
    switch (dto.type) {
      case SharedLinkType.Album: {
        if (!dto.albumId) {
          throw new BadRequestException('Invalid albumId');
        }
        await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [dto.albumId] });
        // Fork (audit 1): a public link to an album hidden for the manager would hand out the hidden content
        await this.lockService().assertAlbumVisibleForViewer(auth, dto.albumId);
        const album = await this.albumRepository.getById(dto.albumId, { withAssets: false });
        isSmartAlbum = album?.kind === AlbumKind.Smart;
        assertUploadAllowed(isSmartAlbum, dto.allowUpload);
        break;
      }

      case SharedLinkType.Individual: {
        if (!dto.assetIds || dto.assetIds.length === 0) {
          throw new BadRequestException('Invalid assetIds');
        }

        await this.requireAccess({ auth, permission: Permission.AssetShare, ids: dto.assetIds });
        // Fork (audit 1): a link to a hidden asset would hand it out. Refused exactly like a missing or unshareable
        // asset (ruling R32: no lock-state oracle).
        const hidden = await this.lockService().getUnshareableHiddenAssetIds(auth, dto.assetIds);
        if (hidden.size > 0) {
          throw new BadRequestException(`Not found or no ${Permission.AssetShare} access`);
        }

        break;
      }
    }

    try {
      const sharedLink = await this.sharedLinkRepository.create({
        key: this.cryptoRepository.randomBytes(50),
        userId: auth.user.id,
        type: dto.type,
        albumId: dto.albumId || null,
        assetIds: dto.assetIds,
        description: dto.description || null,
        password: dto.password,
        expiresAt: dto.expiresAt || null,
        // Fork (R36-5): a smart album's link defaults to no uploads (its membership is its filter)
        allowUpload: dto.allowUpload ?? !isSmartAlbum,
        allowDownload: dto.showMetadata === false ? false : (dto.allowDownload ?? true),
        showExif: dto.showMetadata ?? true,
        slug: dto.slug || null,
      });

      return mapSharedLink(sharedLink, { stripAssetMetadata: false });
    } catch (error) {
      this.handleError(error);
    }
  }

  private handleError(error: unknown): never {
    if ((error as PostgresError).constraint_name === 'shared_link_slug_uq') {
      this.logger.debug('Shared link with this slug already exists');
      throw new BadRequestException('Failed to save shared link');
    }
    throw error;
  }

  async update(auth: AuthDto, id: string, dto: SharedLinkEditDto) {
    const existing = await this.findManageableOrFail(auth, id);
    assertUploadAllowed(existing.album?.kind === AlbumKind.Smart, dto.allowUpload);
    try {
      const sharedLink = await this.sharedLinkRepository.update({
        id,
        userId: auth.user.id,
        description: dto.description,
        password: dto.password,
        expiresAt: dto.expiresAt,
        allowUpload: dto.allowUpload,
        allowDownload: dto.allowDownload,
        showExif: dto.showMetadata,
        slug: dto.slug || null,
      });
      return mapSharedLink(sharedLink, { stripAssetMetadata: false });
    } catch (error) {
      this.handleError(error);
    }
  }

  async remove(auth: AuthDto, id: string): Promise<void> {
    // Fork (ruling R30): revoking reveals nothing and reduces exposure, so only the manager's own locks (outside
    // elevation) refuse it; a link hidden solely by another owner's locks stays revocable.
    const sharedLink = await this.findManageableOrFail(auth, id, (link) =>
      this.lockService().isSharedLinkHiddenByOwnLocks(auth, link),
    );
    await this.sharedLinkRepository.remove(sharedLink.id);
  }

  // TODO: replace `userId` with permissions and access control checks
  private findOrFail(userId: string, id: string) {
    return findOrFail(() => this.sharedLinkRepository.get(userId, id), 'Shared link');
  }

  /**
   * Fork (audit 1): authenticated management of an existing link. A link exposing content hidden for the manager is
   * unreachable by id (spec §15.3: elevation bypasses only the manager's own locks, never another owner's), and is
   * refused exactly like a non-existent id (ruling R32: no existence or lock-state oracle).
   */
  private findManageableOrFail(
    auth: AuthDto,
    id: string,
    isHidden: (link: SharedLinkLockTarget) => Promise<boolean> = (link) =>
      this.lockService().isSharedLinkHiddenForViewer(auth, link),
  ) {
    return findOrFail(async () => {
      const sharedLink = await this.sharedLinkRepository.get(auth.user.id, id);
      return sharedLink && (await isHidden(sharedLink)) ? undefined : sharedLink;
    }, 'Shared link');
  }

  private lockService() {
    return BaseService.create(LockService, this);
  }

  async addAssets(auth: AuthDto, id: string, dto: AssetIdsDto): Promise<AssetIdsResponseDto[]> {
    const sharedLink = await this.findManageableOrFail(auth, id);
    if (sharedLink.type !== SharedLinkType.Individual) {
      throw new BadRequestException('Invalid shared link type');
    }

    const existingAssetIds = new Set(sharedLink.assets.map((asset) => asset.id));
    const notPresentAssetIds = dto.assetIds.filter((assetId) => !existingAssetIds.has(assetId));
    const allowedAssetIds = new Set(
      await this.checkAccess({
        auth,
        permission: Permission.AssetShare,
        ids: notPresentAssetIds,
      }),
    );
    // Fork (audit 1): adding a hidden asset would make the key a route to it. Reported exactly like a missing asset
    // (ruling R32: no lock-state oracle).
    for (const assetId of await this.lockService().getUnshareableHiddenAssetIds(auth, [...allowedAssetIds])) {
      allowedAssetIds.delete(assetId);
    }

    const results: AssetIdsResponseDto[] = [];
    for (const assetId of dto.assetIds) {
      const hasAsset = existingAssetIds.has(assetId);
      if (hasAsset) {
        results.push({ assetId, success: false, error: AssetIdErrorReason.DUPLICATE });
        continue;
      }

      const hasAccess = allowedAssetIds.has(assetId);
      if (!hasAccess) {
        results.push({ assetId, success: false, error: AssetIdErrorReason.NO_PERMISSION });
        continue;
      }

      results.push({ assetId, success: true });
    }

    await this.sharedLinkRepository.update({
      ...sharedLink,
      assetIds: results.filter(({ success }) => success).map(({ assetId }) => assetId),
    });

    return results;
  }

  async removeAssets(auth: AuthDto, id: string, dto: AssetIdsDto): Promise<AssetIdsResponseDto[]> {
    const sharedLink = await this.findManageableOrFail(auth, id);

    if (sharedLink.type !== SharedLinkType.Individual) {
      throw new BadRequestException('Invalid shared link type');
    }

    const removedAssetIds = await this.sharedLinkAssetRepository.remove(id, dto.assetIds);

    const results: AssetIdsResponseDto[] = [];
    for (const assetId of dto.assetIds) {
      const wasRemoved = removedAssetIds.includes(assetId);
      if (!wasRemoved) {
        results.push({ assetId, success: false, error: AssetIdErrorReason.NOT_FOUND });
        continue;
      }

      results.push({ assetId, success: true });
      sharedLink.assets = sharedLink.assets.filter((asset) => asset.id !== assetId);
    }

    await this.sharedLinkRepository.update(sharedLink);

    return results;
  }

  async getMetadataTags(auth: AuthDto, defaultDomain?: string): Promise<null | OpenGraphTags> {
    if (!auth.sharedLink || auth.sharedLink.password) {
      return null;
    }

    const config = await this.getConfig({ withCache: true });
    const sharedLink = await this.findOrFail(auth.sharedLink.userId, auth.sharedLink.id);
    const assetId = sharedLink.album?.albumThumbnailAssetId || sharedLink.assets[0]?.id;
    const assetCount = sharedLink.assets.length > 0 ? sharedLink.assets.length : sharedLink.album?.assets?.length || 0;
    const imagePath = assetId
      ? `/api/assets/${assetId}/thumbnail?key=${sharedLink.key.toString('base64url')}`
      : '/feature-panel.png';

    return {
      title: sharedLink.album ? sharedLink.album.albumName : 'Public Share',
      description: sharedLink.description || `${assetCount} shared photos & videos`,
      imageUrl: new URL(imagePath, getExternalDomain(config.server, defaultDomain)).href,
    };
  }

  private asToken(sharedLink: { id: string; password: string }) {
    return this.cryptoRepository.hashSha256(`${sharedLink.id}-${sharedLink.password}`).toString('base64');
  }
}
