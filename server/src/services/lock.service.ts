import { BadRequestException, Injectable } from '@nestjs/common';
import { BulkIdErrorReason } from 'src/dtos/asset-ids.response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { LocksResponseDto, MoveToLockedAlbumDto, MoveToLockedAlbumResponseDto } from 'src/dtos/lock.dto';
import { Permission } from 'src/enum';
import { AlbumService } from 'src/services/album.service';
import { BaseService } from 'src/services/base.service';
import { requireElevatedPermission } from 'src/utils/access';
import { NO_REVEALED_LOCKS } from 'src/utils/lock-visibility';

/**
 * Per-user lock toggles for albums and folders. Every operation - including reads - requires
 * an elevated (PIN-verified) session: lock state must not be enumerable by whoever happens
 * to hold an unlocked device (plausible deniability, spec §8.5/§9).
 */
@Injectable()
export class LockService extends BaseService {
  async lockAlbum(auth: AuthDto, albumId: string): Promise<void> {
    requireElevatedPermission(auth);
    // Read access (owner or sharee) is enough: sharees may lock a shared album for
    // themselves without affecting anyone else's view.
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [albumId] });
    await this.lockRepository.lockAlbum(auth.user.id, albumId);
  }

  async unlockAlbum(auth: AuthDto, albumId: string): Promise<void> {
    requireElevatedPermission(auth);
    // No access check: deleting one's own lock row is always safe, and a user who lost
    // access to an album must still be able to clean up their stale lock.
    await this.lockRepository.unlockAlbum(auth.user.id, albumId);
  }

  async lockContainer(auth: AuthDto, containerId: string): Promise<void> {
    requireElevatedPermission(auth);
    const hasAccess = await this.albumContainerRepository.hasAccess(containerId, auth.user.id);
    if (!hasAccess) {
      throw new BadRequestException('Not found or no albumContainer.read access');
    }
    await this.lockRepository.lockContainer(auth.user.id, containerId);
  }

  async unlockContainer(auth: AuthDto, containerId: string): Promise<void> {
    requireElevatedPermission(auth);
    await this.lockRepository.unlockContainer(auth.user.id, containerId);
  }

  async getLocks(auth: AuthDto): Promise<LocksResponseDto> {
    requireElevatedPermission(auth);
    return this.lockRepository.getLocks(auth.user.id);
  }

  /**
   * Server-side "move to locked album": add the assets, remove their other viewer-visible
   * regular memberships (an unlocked membership would rescue them from the lock), and
   * report which assets a viewer-reachable unlocked smart album still matches - all in one
   * request, with smart filters evaluated once over the whole batch rather than per asset.
   * Requires an elevated session and a destination the user has actually locked.
   */
  async moveAssetsToLockedAlbum(auth: AuthDto, dto: MoveToLockedAlbumDto): Promise<MoveToLockedAlbumResponseDto> {
    requireElevatedPermission(auth);
    const hidden = await this.lockRepository.isAlbumHiddenForViewer(auth.user.id, dto.albumId);
    if (!hidden) {
      throw new BadRequestException('Destination album is not locked');
    }

    // Only the viewer's OWN assets can be moved: their locks do not govern partner-owned
    // assets (the partner's do), so a foreign asset filed here would stay visible through
    // partner sharing while being reported hidden. Non-owned ids fail without side effects.
    const owned = await this.accessRepository.asset.checkOwnerAccess(auth.user.id, new Set(dto.assetIds), true);
    const ownedIds = dto.assetIds.filter((id) => owned.has(id));
    const notOwned = dto.assetIds.filter((id) => !owned.has(id));
    if (ownedIds.length === 0) {
      return { moved: [], stillVisible: [], failed: notOwned };
    }

    const albumService = BaseService.create(AlbumService, this);
    // addAssets validates access (owner/editor), rejects smart-album targets, and returns
    // per-asset results; "duplicate" means already filed in the locked album.
    const addResults = await albumService.addAssets(auth, dto.albumId, { ids: ownedIds });
    const added = new Set(
      addResults.filter(({ success, error }) => success || error === BulkIdErrorReason.DUPLICATE).map(({ id }) => id),
    );
    const failed = [...notOwned, ...ownedIds.filter((id) => !added.has(id))];
    const addedIds = ownedIds.filter((id) => added.has(id));
    if (addedIds.length === 0) {
      return { moved: [], stillVisible: [], failed };
    }

    // Remove the other viewer-visible regular memberships, album by album. A removal the
    // viewer is not allowed to make (e.g. viewer-role share) leaves the asset visible there.
    // Memberships in albums the viewer has hidden are skipped outright: a hidden membership
    // cannot rescue the asset, so it neither needs removal nor counts as still-visible.
    const hiddenAlbumIds = new Set(await this.lockRepository.getHiddenAlbumIds(auth.user.id, NO_REVEALED_LOCKS));
    const stillVisible = new Set<string>();
    const memberships = await this.albumRepository.getVisibleMembershipsByAssetIds(auth.user.id, addedIds);
    const removalsPerAlbum = new Map<string, string[]>();
    for (const { assetId, albumId } of memberships) {
      if (albumId === dto.albumId || hiddenAlbumIds.has(albumId)) {
        continue;
      }
      const ids = removalsPerAlbum.get(albumId) ?? [];
      ids.push(assetId);
      removalsPerAlbum.set(albumId, ids);
    }
    for (const [albumId, ids] of removalsPerAlbum) {
      try {
        const results = await albumService.removeAssets(auth, albumId, { ids });
        for (const result of results) {
          if (!result.success) {
            stillVisible.add(result.id);
          }
        }
      } catch {
        for (const id of ids) {
          stillVisible.add(id);
        }
      }
    }

    // Saved-search rescues, evaluated once for the whole batch: each viewer-reachable
    // unlocked smart album's filter runs a single query over all moved ids.
    const smartMatched = await this.accessRepository.asset.checkSmartAlbumAccess(auth.user.id, new Set(addedIds));
    for (const id of smartMatched) {
      stillVisible.add(id);
    }

    return {
      moved: addedIds.filter((id) => !stillVisible.has(id)),
      stillVisible: addedIds.filter((id) => stillVisible.has(id)),
      failed,
    };
  }

  /**
   * Guard for album-scoped surfaces (album detail, album timeline, album download, album
   * map): an effectively-hidden album is unreachable for its locker - even by known id -
   * unless the session is elevated. Shared-link visitors are not the locker and are never
   * blocked; other users are unaffected by construction (the hidden check is per-viewer).
   * Indistinguishable from a no-access error so the response does not confirm existence.
   */
  async assertAlbumVisibleForViewer(auth: AuthDto, albumId: string): Promise<void> {
    if (auth.sharedLink || auth.session?.hasElevatedPermission) {
      return;
    }
    if (await this.lockRepository.isAlbumHiddenForViewer(auth.user.id, albumId)) {
      throw new BadRequestException('Not found or no album.read access');
    }
  }

  /** Folder counterpart of assertAlbumVisibleForViewer. */
  /**
   * Write guard for mutations on a folder whose SUBTREE may contain hidden content: delete
   * cascades through descendants, and moves/share changes propagate cascade access - so an
   * unlocked ancestor is not a safe handle on the locked content beneath it.
   */
  async assertSubtreeVisibleForViewer(auth: AuthDto, containerId: string): Promise<void> {
    if (auth.sharedLink || auth.session?.hasElevatedPermission) {
      return;
    }
    if (await this.lockRepository.subtreeContainsHiddenContent(auth.user.id, containerId)) {
      throw new BadRequestException('Not found or no album.read access');
    }
  }

  async assertContainerVisibleForViewer(auth: AuthDto, containerId: string): Promise<void> {
    if (auth.sharedLink || auth.session?.hasElevatedPermission) {
      return;
    }
    if (await this.lockRepository.isContainerHiddenForViewer(auth.user.id, containerId)) {
      throw new BadRequestException('Not found or no albumContainer.read access');
    }
  }
}
