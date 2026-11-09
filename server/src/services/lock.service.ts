import { BadRequestException, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { BulkIdErrorReason } from 'src/dtos/asset-ids.response.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { LocksResponseDto, MoveToLockedAlbumDto, MoveToLockedAlbumResponseDto } from 'src/dtos/lock.dto.js';
import { Permission, SharedLinkType } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { AlbumService } from 'src/services/album.service.js';
import { BaseService } from 'src/services/base.service.js';
import { requireElevatedPermission } from 'src/utils/access.js';
import { OwnerLockVisibility } from 'src/utils/database.js';
import { NO_REVEALED_LOCKS, RevealedLocks } from 'src/utils/lock-visibility.js';
import { setDifference } from 'src/utils/set.js';

/** The parts of a shared link that decide whether it exposes content hidden for its manager. */
export type SharedLinkLockTarget = { id: string; type: SharedLinkType; albumId: string | null };

/** R56: copies of `assets` whose motion part is not in `reachable` carry `livePhotoVideoId: null`. */
const withheldMotionIds = <T extends { livePhotoVideoId: string | null }>(assets: T[], reachable: Set<string>): T[] =>
  assets.map((asset) =>
    asset.livePhotoVideoId && !reachable.has(asset.livePhotoVideoId) ? { ...asset, livePhotoVideoId: null } : asset,
  );

/**
 * How an authenticated surface consults the viewer's OWN locks (other owners' locks always apply, never revealed):
 * - `direct`: direct-by-id access - an elevated session bypasses the viewer's own locks, with no reveal (spec §15.3);
 * - `list`: list-like surfaces - the viewer's own locks apply even when elevated, minus the reveal set (elevated only).
 */
type LockMode = 'direct' | 'list';

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
   * Shared-link management (spec §4, §15.3; audit finding 1): whether an authenticated manager's link exposes content
   * hidden for them, judged for direct-by-id management (get/update/remove/addAssets/removeAssets).
   *
   * - an album link is hidden when its album is effectively hidden by the manager's OWN locks (an album owner's locks
   *   never bind a sharee);
   * - an individual link is hidden when ANY of its assets is hidden for the manager: the key - and so the whole
   *   link - is the secret, so a mixed visible/hidden link counts as hidden.
   *
   * Hiddenness is per item, by its source owner: elevation bypasses only the manager's own locks; an asset hidden by
   * another owner's locks (e.g. a partner's later-locked photo) stays hidden in every session unless the manager
   * holds another legitimate grant to it (an album shared with them that is not hidden for them).
   *
   * Public visitors holding a key (auth.sharedLink) are a separate, deliberate grant and are never judged here.
   */
  async isSharedLinkHiddenForViewer(auth: AuthDto, link: SharedLinkLockTarget): Promise<boolean> {
    const hidden = await this.findHiddenSharedLinks(auth, [link], 'direct');
    return hidden.has(link.id);
  }

  /** Batched list-surface counterpart of isSharedLinkHiddenForViewer (getAll): the reveal set applies when elevated. */
  getHiddenSharedLinkIds(auth: AuthDto, links: SharedLinkLockTarget[]): Promise<Set<string>> {
    return this.findHiddenSharedLinks(auth, links, 'list');
  }

  /**
   * Revocation guard (ruling R30): removing a link returns and reveals nothing and only reduces exposure, so only
   * the manager's OWN locks can stop it, and only outside elevation (§15.2). A link hidden solely by another owner's
   * locks - a partner's or a former partner's - stays revocable in every session.
   */
  async isSharedLinkHiddenByOwnLocks(auth: AuthDto, link: SharedLinkLockTarget): Promise<boolean> {
    if (auth.session?.hasElevatedPermission) {
      return false;
    }
    const hidden = await this.findHiddenSharedLinks(auth, [link], 'direct', true);
    return hidden.has(link.id);
  }

  /**
   * Minting guard (create an individual link, addAssets): the subset of `assetIds` hidden for the manager under the
   * direct-by-id rule. Callers treat these exactly like missing or unshareable assets (ruling R32: no lock-state
   * oracle). Only assets the manager owns or reaches as a partner are judged; any other asset fails the regular
   * asset.share check anyway.
   */
  getUnshareableHiddenAssetIds(auth: AuthDto, assetIds: string[]): Promise<Set<string>> {
    return this.getHiddenAssetIds(auth, assetIds, 'direct', { relatedOnly: true });
  }

  /**
   * Shared-link upload guard (7A.8a): whether the link owner's asset that an upload matched by checksum is hidden for
   * that owner. The visitor is never elevated and holds no reveal set, so the owner's own locks apply in full - adding
   * the asset to the link (or its album) would be a non-elevated mutation of hidden content that also exposes it to
   * every link holder.
   */
  async isAssetHiddenForSharedLinkOwner(auth: AuthDto, assetId: string): Promise<boolean> {
    const hidden = await this.getOwnHiddenAssetIdsForUpload({ user: auth.user }, [assetId]);
    return hidden.has(assetId);
  }

  /**
   * Upload duplicate guard (7A.8a, ruling R49): the subset of `assetIds` that are the uploader's OWN assets hidden by
   * their own locks under the direct-by-id rule. Empty in an elevated session (elevation bypasses the viewer's own
   * locks); the reveal set never applies (an upload is a write, spec §15.3). A shared-link visitor is judged as the
   * link owner without a session (see isAssetHiddenForSharedLinkOwner), so the owner's locks apply in full.
   */
  getOwnHiddenAssetIdsForUpload(auth: AuthDto, assetIds: string[]): Promise<Set<string>> {
    return this.getHiddenAssetIds(auth, assetIds, 'direct', { ownOnly: true });
  }

  /**
   * Write guard for an existing asset an upload or update references by id (ruling R51: `livePhotoVideoId`): whether
   * the caller's own asset is hidden for them under the direct-access rule - bypassed only by elevation, never
   * revealed. A shared-link visitor is judged as the link owner without a session (the owner's locks apply in full).
   */
  async isOwnAssetHiddenForWrite(auth: AuthDto, assetId: string): Promise<boolean> {
    const viewer = auth.sharedLink ? { user: auth.user } : auth;
    const hidden = await this.getOwnHiddenAssetIdsForUpload(viewer, [assetId]);
    return hidden.has(assetId);
  }

  /**
   * Direct-by-id read filter (7A.8c, the stack summary of asset detail): the subset of `assetIds` hidden for the
   * viewer - the viewer's own locks are bypassed in an elevated session, another owner's always apply.
   */
  getHiddenAssetIdsForRead(auth: AuthDto, assetIds: string[]): Promise<Set<string>> {
    return this.getHiddenAssetIds(auth, assetIds, 'direct');
  }

  /**
   * Ruling R56, direct-by-id responses (asset detail and its stripped shared-link form, single-object mutation
   * responses): withhold `livePhotoVideoId` - set it to null - where the caller cannot reach the still's motion part
   * under their asset.read rule. That rule is reused as is, in one batched access check: the viewer's own locks
   * (bypassed by elevation), a partner owner's locks (never bypassed), and the album and shared-link grants that reach
   * a motion part through its still (`livePhotoVideoId = any(target)`).
   *
   * Fast path: only lock rows can make the motion part of a reachable still unreachable, so the check runs only when
   * an owner of the stills (the motion part's owner - a Live Photo is linked within one owner's library) or the viewer
   * (whose locks withhold album grants), holds any; an elevated viewer's own locks never matter here. Responses without
   * a Live Photo pay nothing; one without relevant locks pays one indexed probe.
   */
  async withholdUnreachableMotionIds<T extends { ownerId: string; livePhotoVideoId: string | null }>(
    auth: AuthDto,
    assets: T[],
  ): Promise<T[]> {
    const stills = assets.filter(({ livePhotoVideoId }) => !!livePhotoVideoId);
    if (stills.length === 0) {
      return assets;
    }

    const lockHolders = new Set(stills.map(({ ownerId }) => ownerId));
    if (auth.sharedLink || !auth.session?.hasElevatedPermission) {
      lockHolders.add(auth.user.id);
    } else if (stills.every(({ ownerId }) => ownerId === auth.user.id)) {
      return assets;
    }
    if (!(await this.lockRepository.anyHasLocks([...lockHolders]))) {
      return assets;
    }

    const motionIds = [...new Set(stills.map(({ livePhotoVideoId }) => livePhotoVideoId!))];
    const reachable = await this.checkAccess({ auth, permission: Permission.AssetRead, ids: motionIds });
    return withheldMotionIds(assets, reachable);
  }

  /**
   * Ruling R56, list responses: withhold `livePhotoVideoId` where the still's motion part does not pass the lock
   * entries the list was filtered with (owner and partner entries, the viewer's reveal set applied by the caller), unless
   * the still sits in one of the list's granted albums (its album arm). One batched query, and none at all when the
   * list has no entries.
   */
  async withholdHiddenMotionIds<T extends { livePhotoVideoId: string | null }>(
    assets: T[],
    entries: OwnerLockVisibility[] | undefined,
    grantedAlbumIds: string[] = [],
  ): Promise<T[]> {
    if (!entries?.length) {
      return assets;
    }
    const motionIds = [
      ...new Set(assets.flatMap(({ livePhotoVideoId }) => (livePhotoVideoId ? [livePhotoVideoId] : []))),
    ];
    if (motionIds.length === 0) {
      return assets;
    }
    const visible = await this.lockRepository.getVisibleMotionIds(motionIds, entries, grantedAlbumIds);
    return withheldMotionIds(assets, visible);
  }

  /** {@link withholdHiddenMotionIds} over the assets of several groups (memories, stacks, duplicates) in one query. */
  async withholdHiddenMotionIdsInGroups<A extends { livePhotoVideoId: string | null }, G extends { assets: A[] }>(
    groups: G[],
    entries: OwnerLockVisibility[] | undefined,
  ): Promise<G[]> {
    const flat = groups.flatMap(({ assets }) => assets);
    const withheld = await this.withholdHiddenMotionIds(flat, entries);
    if (withheld === flat) {
      return groups;
    }
    let index = 0;
    return groups.map((group) => ({ ...group, assets: group.assets.map(() => withheld[index++]) }));
  }

  private async findHiddenSharedLinks(
    auth: AuthDto,
    links: SharedLinkLockTarget[],
    mode: LockMode,
    ownOnly = false,
  ): Promise<Set<string>> {
    const hidden = new Set<string>();
    if (auth.sharedLink || links.length === 0) {
      return hidden;
    }

    const isElevated = !!auth.session?.hasElevatedPermission;
    const albumLinks = links.filter(
      (link): link is SharedLinkLockTarget & { albumId: string } =>
        link.type === SharedLinkType.Album && !!link.albumId,
    );
    // Album links: only the manager's own effective album hiding applies, which elevation bypasses for direct-by-id.
    if (albumLinks.length > 0 && !(isElevated && mode === 'direct')) {
      const hiddenAlbumIds = new Set(
        await this.lockRepository.getHiddenAlbumIds(auth.user.id, this.getOwnReveal(auth, mode)),
      );
      for (const link of albumLinks) {
        if (hiddenAlbumIds.has(link.albumId)) {
          hidden.add(link.id);
        }
      }
    }

    const individualLinkIds = links.filter(({ type }) => type === SharedLinkType.Individual).map(({ id }) => id);
    if (individualLinkIds.length > 0) {
      const rows = await this.sharedLinkRepository.getAssetIds(individualLinkIds);
      const hiddenAssetIds = await this.getHiddenAssetIds(
        auth,
        [...new Set(rows.map(({ assetId }) => assetId))],
        mode,
        { ownOnly },
      );
      for (const { sharedLinkId, assetId } of rows) {
        if (hiddenAssetIds.has(assetId)) {
          hidden.add(sharedLinkId);
        }
      }
    }

    return hidden;
  }

  /**
   * The subset of `assetIds` hidden for the viewer, each judged by its OWNER's locks: the viewer's own (bypassed in an
   * elevated direct-by-id session; minus the reveal set on an elevated list) or another owner's (always, never
   * revealed). An asset hidden by another owner is rescued by the viewer's own album or smart-album grant to it, the
   * grant itself subject to the viewer's locks (spec §15.1) in the same mode. With `relatedOnly`, only assets the
   * viewer owns or reaches as a partner are judged; with `ownOnly`, only the viewer's own assets (own locks).
   */
  private async getHiddenAssetIds(
    auth: AuthDto,
    assetIds: string[],
    mode: LockMode,
    { relatedOnly = false, ownOnly = false }: { relatedOnly?: boolean; ownOnly?: boolean } = {},
  ): Promise<Set<string>> {
    if (assetIds.length === 0) {
      return new Set();
    }

    const viewerId = auth.user.id;
    const isElevated = !!auth.session?.hasElevatedPermission;
    const bypassOwnLocks = isElevated && mode === 'direct';
    const owners = await this.lockRepository.getAssetOwners(viewerId, assetIds);
    const candidates = owners.filter(
      ({ ownerId, isPartner }) => ownerId === viewerId || (!ownOnly && (!relatedOnly || isPartner)),
    );
    const ownerIds = [...new Set(candidates.map(({ ownerId }) => ownerId))].filter(
      (ownerId) => !(bypassOwnLocks && ownerId === viewerId),
    );
    if (ownerIds.length === 0) {
      return new Set();
    }

    // Reveal only ever applies to the viewer's own locks, and only on an elevated list (getOwnerLockVisibility
    // ignores it for every other owner and whenever isElevated is false).
    const entries = await this.lockRepository.getOwnerLockVisibility({
      viewerId,
      ownerIds,
      revealed: auth.revealedLocks ?? NO_REVEALED_LOCKS,
      isElevated: isElevated && mode === 'list',
    });
    if (entries.length === 0) {
      return new Set();
    }

    const lockingOwners = new Set(entries.map(({ ownerId }) => ownerId));
    const checked = candidates.filter(({ ownerId }) => lockingOwners.has(ownerId));
    const visible = await this.lockRepository.getVisibleAssetIds(
      checked.map(({ id }) => id),
      entries,
    );
    const hidden = new Set(checked.filter(({ id }) => !visible.has(id)).map(({ id }) => id));

    const foreign = new Set(
      checked.filter(({ id, ownerId }) => hidden.has(id) && ownerId !== viewerId).map(({ id }) => id),
    );
    if (foreign.size > 0) {
      const revealed = this.getOwnReveal(auth, mode);
      const isAlbum = await this.accessRepository.asset.checkAlbumAccess(viewerId, foreign, bypassOwnLocks, revealed);
      const isSmartAlbum = await this.accessRepository.asset.checkSmartAlbumAccess(
        viewerId,
        setDifference(foreign, isAlbum),
        bypassOwnLocks,
        revealed,
      );
      for (const id of [...isAlbum, ...isSmartAlbum]) {
        hidden.delete(id);
      }
    }

    return hidden;
  }

  /** The viewer's reveal set as it applies to their own locks in `mode`: elevated list surfaces only (spec §15.3). */
  private getOwnReveal(auth: AuthDto, mode: LockMode): RevealedLocks {
    return auth.session?.hasElevatedPermission && mode === 'list'
      ? (auth.revealedLocks ?? NO_REVEALED_LOCKS)
      : NO_REVEALED_LOCKS;
  }

  /**
   * Guard for album-scoped surfaces (album detail, album timeline, album download, album
   * map): an effectively-hidden album is unreachable for its locker - even by known id -
   * unless the session is elevated. Shared-link visitors are not the locker and are never
   * blocked; other users are unaffected by construction (the hidden check is per-viewer).
   * Indistinguishable from a no-access error so the response does not confirm existence;
   * `message` lets a caller reuse its own missing-content error (ruling R32).
   */
  async assertAlbumVisibleForViewer(
    auth: AuthDto,
    albumId: string,
    message = 'Not found or no album.read access',
  ): Promise<void> {
    if (auth.sharedLink || auth.session?.hasElevatedPermission) {
      return;
    }
    if (await this.lockRepository.isAlbumHiddenForViewer(auth.user.id, albumId)) {
      throw new BadRequestException(message);
    }
  }

  /** Folder counterpart of assertAlbumVisibleForViewer. */
  /**
   * Write guard for mutations on a folder whose SUBTREE may contain hidden content: delete
   * cascades through descendants, and moves/share changes propagate cascade access - so an
   * unlocked ancestor is not a safe handle on the locked content beneath it.
   */
  async assertSubtreeVisibleForViewer(auth: AuthDto, containerId: string, tx?: Kysely<DB>): Promise<void> {
    if (auth.sharedLink || auth.session?.hasElevatedPermission) {
      return;
    }
    if (await this.lockRepository.subtreeContainsHiddenContent(auth.user.id, containerId, tx)) {
      throw new BadRequestException('Not found or no album.read access');
    }
  }

  /**
   * Read guard for a folder, and the write guard for creating or placing content inside one
   * (a hidden destination is hidden content too). `tx` is the caller's folder-structure
   * transaction, so the closure it judges is the one the mutation will build on.
   */
  async assertContainerVisibleForViewer(auth: AuthDto, containerId: string, tx?: Kysely<DB>): Promise<void> {
    if (auth.sharedLink || auth.session?.hasElevatedPermission) {
      return;
    }
    if (await this.lockRepository.isContainerHiddenForViewer(auth.user.id, containerId, tx)) {
      throw new BadRequestException('Not found or no albumContainer.read access');
    }
  }
}
