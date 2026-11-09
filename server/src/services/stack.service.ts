import { BadRequestException, Injectable } from '@nestjs/common';
import { BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { StackCreateDto, StackResponseDto, StackSearchDto, StackUpdateDto, mapStack } from 'src/dtos/stack.dto.js';
import { Permission } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { LockService } from 'src/services/lock.service.js';
import { OwnerLockVisibility } from 'src/utils/database.js';
import { NO_REVEALED_LOCKS } from 'src/utils/lock-visibility.js';
import { findOrFail } from 'src/utils/misc.js';
import { UUIDAssetIDParamDto } from 'src/validation.js';

@Injectable()
export class StackService extends BaseService {
  private lockService() {
    return BaseService.create(LockService, this);
  }

  /** Stacks only contain the viewer's own assets, so the only relevant lock owner is the viewer. */
  private getViewerLockVisibility(auth: AuthDto) {
    return this.lockRepository.getOwnerLockVisibility({
      viewerId: auth.user.id,
      ownerIds: [auth.user.id],
      revealed: auth.revealedLocks ?? NO_REVEALED_LOCKS,
      isElevated: !!auth.session?.hasElevatedPermission,
    });
  }

  /**
   * A stack row whose every member is locked away must not surface at all (its ids are
   * hidden identifiers), and a hidden primary must not leak through primaryAssetId -
   * present the first visible member as primary instead.
   */
  private toVisibleStack<T extends { primaryAssetId: string; assets: { id: string }[] }>(stack: T): T | null {
    if (stack.assets.length === 0) {
      return null;
    }
    if (stack.assets.some(({ id }) => id === stack.primaryAssetId)) {
      return stack;
    }
    return { ...stack, primaryAssetId: stack.assets[0].id };
  }

  async search(auth: AuthDto, dto: StackSearchDto): Promise<StackResponseDto[]> {
    const lockVisibility = await this.getViewerLockVisibility(auth);
    const stacks = await this.stackRepository.search(
      {
        ownerId: auth.user.id,
        primaryAssetId: dto.primaryAssetId,
      },
      lockVisibility,
    );

    // Fork (R56): a member never enumerates a hidden motion part (same entries as the members).
    const visible = await this.lockService().withholdHiddenMotionIdsInGroups(stacks, lockVisibility);
    return visible
      .map((stack) => this.toVisibleStack(stack))
      .filter((stack) => stack !== null)
      .map((stack) => mapStack(stack, { auth }));
  }

  async create(auth: AuthDto, dto: StackCreateDto): Promise<StackResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: dto.assetIds });
    await this.assertExistingStacksMutableForViewer(auth, dto.assetIds);

    // Fork (R66): the existing stacks of the requested assets are merged away below; judged before they are gone so
    // their audit rows carry the partner verdict (outside elevation the guard above already refused hidden ones).
    const hiddenStackIds = await this.getHiddenStackIdsOfAssets(auth.user.id, dto.assetIds);
    const stack = await this.stackRepository.create({ ownerId: auth.user.id }, dto.assetIds, { hiddenStackIds });

    await this.eventRepository.emit('StackCreate', { stackId: stack.id, userId: auth.user.id });

    // Fork (R56): the members passed asset.update (the direct rule), so their motion parts are judged by it too.
    const assets = await this.lockService().withholdUnreachableMotionIds(auth, stack.assets);
    return mapStack({ ...stack, assets }, { auth });
  }

  async get(auth: AuthDto, id: string): Promise<StackResponseDto> {
    await this.requireAccess({ auth, permission: Permission.StackRead, ids: [id] });
    const lockVisibility = await this.getViewerLockVisibility(auth);
    const stack = await this.findOrFail(id, lockVisibility);
    const [visible] = await this.lockService().withholdHiddenMotionIdsInGroups([stack], lockVisibility);
    return mapStack(visible, { auth });
  }

  /**
   * Mutation guard: a stack containing ANY locked-away member is immutable outside an
   * elevated session - deleting or editing it is a state change touching hidden content
   * (removing a known hidden member, un-stacking hidden assets on delete). Read paths are
   * softer (they filter members); mutations refuse outright.
   */
  private async assertStackMutableForViewer(auth: AuthDto, id: string): Promise<void> {
    // Elevation itself is the bypass for mutations; reveal headers are presentation state.
    if (auth.sharedLink || auth.session?.hasElevatedPermission) {
      return;
    }
    const lockVisibility = await this.getMutationLockVisibility(auth);
    if (lockVisibility.length === 0) {
      return;
    }
    await this.assertStackHasNoHiddenMember(id, lockVisibility);
  }

  /**
   * Fork (962ffaacc lock audit): creating a stack merges the existing stacks of the requested assets (as primary) and
   * moves secondaries out of theirs - e.g. the mobile client stacking a freshly uploaded edit over its original. That
   * is a mutation of every one of those stacks, so the same guard applies: any stack holding a hidden member refuses,
   * otherwise its hidden members would be re-stacked and returned in the response. (The requested ids themselves
   * already passed asset.update, which refuses hidden assets outside elevation.)
   */
  private async assertExistingStacksMutableForViewer(auth: AuthDto, assetIds: string[]): Promise<void> {
    if (auth.sharedLink || auth.session?.hasElevatedPermission) {
      return;
    }
    const lockVisibility = await this.getMutationLockVisibility(auth);
    if (lockVisibility.length === 0) {
      return;
    }
    const assets = await this.assetRepository.getByIds(assetIds);
    const stackIds = new Set(assets.map(({ stackId }) => stackId).filter((stackId) => stackId !== null));
    for (const stackId of stackIds) {
      await this.assertStackHasNoHiddenMember(stackId, lockVisibility);
    }
  }

  /** R66: the stacks of `assetIds` with a member hidden by the owner's own locks (empty when the owner has no locks). */
  private async getHiddenStackIdsOfAssets(ownerId: string, assetIds: string[]): Promise<string[]> {
    if (!(await this.lockRepository.anyHasLocks([ownerId]))) {
      return [];
    }
    const assets = await this.assetRepository.getByIds(assetIds);
    const stackIds = new Set(assets.map(({ stackId }) => stackId).filter((stackId) => stackId !== null));
    const hidden: string[] = [];
    for (const stackId of stackIds) {
      const { ownerHidden } = await this.lockService().judgeStackForDeletion(ownerId, stackId);
      if (ownerHidden) {
        hidden.push(stackId);
      }
    }
    return hidden;
  }

  /** The viewer's lock entries for a mutation guard: no reveal set - reveal headers never grant writes. */
  private getMutationLockVisibility(auth: AuthDto) {
    return this.lockRepository.getOwnerLockVisibility({
      viewerId: auth.user.id,
      ownerIds: [auth.user.id],
      revealed: NO_REVEALED_LOCKS,
      isElevated: false,
    });
  }

  private async assertStackHasNoHiddenMember(id: string, lockVisibility: OwnerLockVisibility[]): Promise<void> {
    const [full, visible] = await Promise.all([
      this.stackRepository.getById(id),
      this.stackRepository.getById(id, lockVisibility),
    ]);
    if (full && (visible?.assets.length ?? 0) < full.assets.length) {
      throw new BadRequestException('Asset stack not found');
    }
  }

  async update(auth: AuthDto, id: string, dto: StackUpdateDto): Promise<StackResponseDto> {
    await this.requireAccess({ auth, permission: Permission.StackUpdate, ids: [id] });
    await this.assertStackMutableForViewer(auth, id);
    // Mutations bypass list-style filtering entirely when elevated (no reveal needed) -
    // otherwise an elevated user could not re-pick a primary on a stack with hidden members.
    const lockVisibility = auth.session?.hasElevatedPermission ? [] : await this.getViewerLockVisibility(auth);
    const stack = await this.findOrFail(id, lockVisibility);
    if (dto.primaryAssetId && stack.assets.every(({ id }) => id !== dto.primaryAssetId)) {
      throw new BadRequestException('Primary asset must be in the stack');
    }

    const updatedStack = await this.stackRepository.update(
      id,
      { id, primaryAssetId: dto.primaryAssetId },
      lockVisibility,
    );

    await this.eventRepository.emit('StackUpdate', { stackId: id, userId: auth.user.id });

    // Normalize like the read paths: never expose a hidden primary (or, R56, a hidden motion part's id).
    const [visible] = await this.lockService().withholdHiddenMotionIdsInGroups(
      [this.toVisibleStack(updatedStack) ?? updatedStack],
      lockVisibility,
    );
    return mapStack(visible, { auth });
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.StackDelete, ids: [id] });
    await this.assertStackMutableForViewer(auth, id);
    // Fork (R58): judged before the stack is gone - see NotificationService.onStackDelete. R66: the partner verdict
    // (any hidden member) is persisted on the audit row.
    const { hiddenFromOrdinary, ownerHidden } = await this.lockService().judgeStackForDeletion(auth.user.id, id);
    await this.stackRepository.delete(id, { ownerHidden });
    await this.eventRepository.emit('StackDelete', { stackId: id, userId: auth.user.id, hiddenFromOrdinary });
  }

  async deleteAll(auth: AuthDto, dto: BulkIdsDto): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.StackDelete, ids: dto.ids });
    for (const id of dto.ids) {
      await this.assertStackMutableForViewer(auth, id);
    }
    // Fork (R58): one event for all - ordinary sessions get it unless none of them presented any of these stacks.
    // R66: each stack's partner verdict (any hidden member) is persisted on its audit row.
    let hiddenFromOrdinary = true;
    const hiddenIds: string[] = [];
    for (const id of dto.ids) {
      const verdict = await this.lockService().judgeStackForDeletion(auth.user.id, id);
      if (!verdict.hiddenFromOrdinary) {
        hiddenFromOrdinary = false;
      }
      if (verdict.ownerHidden) {
        hiddenIds.push(id);
      }
    }
    await this.stackRepository.deleteAll(dto.ids, { hiddenIds });
    await this.eventRepository.emit('StackDeleteAll', { stackIds: dto.ids, userId: auth.user.id, hiddenFromOrdinary });
  }

  async removeAsset(auth: AuthDto, dto: UUIDAssetIDParamDto): Promise<void> {
    const { id: stackId, assetId } = dto;
    await this.requireAccess({ auth, permission: Permission.StackUpdate, ids: [stackId] });
    await this.assertStackMutableForViewer(auth, stackId);

    const stack = await this.stackRepository.getForAssetRemoval(assetId);

    if (!stack?.id || stack.id !== stackId) {
      throw new BadRequestException('Asset not in stack');
    }

    if (stack.primaryAssetId === assetId) {
      throw new BadRequestException("Cannot remove stack's primary asset");
    }

    await this.assetRepository.update({ id: assetId, stackId: null });
    await this.eventRepository.emit('StackUpdate', { stackId, userId: auth.user.id });
  }

  private async findOrFail(id: string, lockVisibility?: OwnerLockVisibility[]) {
    // Fork: a stack whose every asset is hidden by the viewer's locks reads as not found.
    const stack = await findOrFail(() => this.stackRepository.getById(id, lockVisibility), 'Asset stack');
    const visible = !lockVisibility?.length || stack.assets.length > 0 ? this.toVisibleStack(stack) : null;
    if (!visible) {
      throw new BadRequestException('Asset stack not found');
    }

    return visible;
  }
}
