import { BadRequestException, Injectable } from '@nestjs/common';
import { BulkIdsDto } from 'src/dtos/asset-ids.response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { StackCreateDto, StackResponseDto, StackSearchDto, StackUpdateDto, mapStack } from 'src/dtos/stack.dto';
import { Permission } from 'src/enum';
import { BaseService } from 'src/services/base.service';
import { OwnerLockVisibility } from 'src/utils/database';
import { NO_REVEALED_LOCKS } from 'src/utils/lock-visibility';
import { UUIDAssetIDParamDto } from 'src/validation';

@Injectable()
export class StackService extends BaseService {
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
    const stacks = await this.stackRepository.search(
      {
        ownerId: auth.user.id,
        primaryAssetId: dto.primaryAssetId,
      },
      await this.getViewerLockVisibility(auth),
    );

    return stacks
      .map((stack) => this.toVisibleStack(stack))
      .filter((stack) => stack !== null)
      .map((stack) => mapStack(stack, { auth }));
  }

  async create(auth: AuthDto, dto: StackCreateDto): Promise<StackResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: dto.assetIds });

    const stack = await this.stackRepository.create({ ownerId: auth.user.id }, dto.assetIds);

    await this.eventRepository.emit('StackCreate', { stackId: stack.id, userId: auth.user.id });

    return mapStack(stack, { auth });
  }

  async get(auth: AuthDto, id: string): Promise<StackResponseDto> {
    await this.requireAccess({ auth, permission: Permission.StackRead, ids: [id] });
    const stack = await this.findOrFail(id, await this.getViewerLockVisibility(auth));
    return mapStack(stack, { auth });
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
    const lockVisibility = await this.getViewerLockVisibility(auth);
    if (lockVisibility.length === 0) {
      return;
    }
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

    // Normalize like the read paths: never expose a hidden primary through the response.
    return mapStack(this.toVisibleStack(updatedStack) ?? updatedStack, { auth });
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.StackDelete, ids: [id] });
    await this.assertStackMutableForViewer(auth, id);
    await this.stackRepository.delete(id);
    await this.eventRepository.emit('StackDelete', { stackId: id, userId: auth.user.id });
  }

  async deleteAll(auth: AuthDto, dto: BulkIdsDto): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.StackDelete, ids: dto.ids });
    for (const id of dto.ids) {
      await this.assertStackMutableForViewer(auth, id);
    }
    await this.stackRepository.deleteAll(dto.ids);
    await this.eventRepository.emit('StackDeleteAll', { stackIds: dto.ids, userId: auth.user.id });
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
    const stack = await this.stackRepository.getById(id, lockVisibility);
    const visible = stack && (!lockVisibility?.length || stack.assets.length > 0) ? this.toVisibleStack(stack) : null;
    if (!visible) {
      throw new BadRequestException('Asset stack not found');
    }

    return visible;
  }
}
