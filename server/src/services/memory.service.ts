import { BadRequestException, Injectable } from '@nestjs/common';
import { shuffle } from 'lodash-es';
import { DateTime } from 'luxon';
import { Memory } from 'src/database.js';
import { OnJob } from 'src/decorators.js';
import { BulkIdResponseDto, BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  MemoryCreateDto,
  MemoryResponseDto,
  MemorySearchDto,
  MemoryUpdateDto,
  mapMemory,
} from 'src/dtos/memory.dto.js';
import { DatabaseLock, JobName, MemoryType, Permission, QueueName, SystemMetadataKey } from 'src/enum.js';
import { type YearMonthDay } from 'src/repositories/asset.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { addAssets, removeAssets } from 'src/utils/asset.util.js';
import { OwnerLockVisibility } from 'src/utils/database.js';
import { NO_REVEALED_LOCKS } from 'src/utils/lock-visibility.js';
import { findOrFail } from 'src/utils/misc.js';

const DAYS = 3;
const DAYS_UNTIL_BIRTHDAY = 3;
const BIRTHDAY_MEMORY_ASSETS_PER_YEAR = 5;
const MEMORY_ASSET_LIMIT = 25;

@Injectable()
export class MemoryService extends BaseService {
  @OnJob({ name: JobName.MemoryGenerate, queue: QueueName.BackgroundTask })
  async onMemoriesCreate() {
    const users = await this.userRepository.getList({ withDeleted: false });

    await this.databaseRepository.withLock(DatabaseLock.MemoryCreation, async () => {
      const state = await this.systemMetadataRepository.get(SystemMetadataKey.MemoriesState);
      const start = DateTime.utc().startOf('day').minus({ days: DAYS });
      const lastOnThisDayDate = state?.lastOnThisDayDate ? DateTime.fromISO(state.lastOnThisDayDate) : start;

      // generate a memory +/- X days from today
      for (let i = 0; i <= DAYS * 2; i++) {
        const target = start.plus({ days: i });
        if (lastOnThisDayDate >= target) {
          continue;
        }

        this.logger.log(`Creating memories for ${target.toISO()}`);
        try {
          await Promise.all(
            users.map((owner) =>
              Promise.all([
                this.createOnThisDayMemories(owner.id, target),
                this.createBirthdayMemories(owner.id, target),
              ]),
            ),
          );
        } catch (error) {
          this.logger.error(`Failed to create memories for ${target.toISO()}: ${error}`);
        }
        // update system metadata even when there is an error to minimize the chance of duplicates
        await this.systemMetadataRepository.set(SystemMetadataKey.MemoriesState, {
          ...state,
          lastOnThisDayDate: target.toISO(),
        });
      }
    });
  }

  /**
   * Memory generation is a background job: it never acts as elevated and never uses a reveal set, so the owner's
   * locked content stays out of every generated memory.
   */
  private getJobLockVisibility(ownerId: string) {
    return this.lockRepository.getOwnerLockVisibility({
      viewerId: ownerId,
      ownerIds: [ownerId],
      revealed: NO_REVEALED_LOCKS,
      isElevated: false,
    });
  }

  private async createOnThisDayMemories(ownerId: string, target: DateTime) {
    const lockVisibility = await this.getJobLockVisibility(ownerId);
    const showAt = target.startOf('day').toISO();
    const hideAt = target.endOf('day').toISO();
    const memories = await this.assetRepository.getByDayOfYear([ownerId], target, lockVisibility);
    await Promise.all(
      memories.map(({ year, assets }) =>
        this.memoryRepository.create(
          {
            ownerId,
            type: MemoryType.OnThisDay,
            data: { year },
            memoryAt: target.set({ year }).toISO()!,
            showAt,
            hideAt,
          },
          new Set(assets.map(({ id }) => id)),
        ),
      ),
    );
  }

  /**
   * Fork (d6d094738 lock audit): a person only seeds a birthday memory when at least one of their birthday assets
   * passes the owner's locks (job context, see getJobLockVisibility) - so neither a hidden asset nor a name known only
   * from hidden content ends up in a memory.
   */
  private async createBirthdayMemories(ownerId: string, target: DateTime) {
    const people = await this.personRepository.forBirthdayMemories(ownerId, target);
    if (people.length === 0) {
      return;
    }

    const lockVisibility = await this.getJobLockVisibility(ownerId);

    const showAt = target.minus({ days: DAYS_UNTIL_BIRTHDAY }).startOf('day').toISO();
    const hideAt = target.endOf('day').toISO();

    await Promise.all(
      people.map(async ({ personGroupId, name: personName, birthDate }) => {
        const assets = await this.getBirthdayAssets(ownerId, personGroupId, birthDate, target, lockVisibility);
        if (assets.length === 0) {
          return;
        }

        await this.memoryRepository.create(
          {
            ownerId,
            type: MemoryType.Birthday,
            data: { personId: personGroupId, personName, year: birthDate.year },
            memoryAt: target.startOf('day').toISO()!,
            showAt,
            hideAt,
          },
          new Set(assets.map(({ id }) => id)),
        );
      }),
    );
  }

  private async getBirthdayAssets(
    ownerId: string,
    personGroupId: string,
    birthDate: YearMonthDay,
    until: YearMonthDay,
    lockVisibility: OwnerLockVisibility[],
  ) {
    const years = await this.memoryRepository.getPersonBirthdayYears(
      ownerId,
      personGroupId,
      birthDate,
      until,
      lockVisibility,
    );
    if (years.length === 0) {
      return [];
    }

    let birthdayYears = years;
    let assetsPerYear = Math.min(BIRTHDAY_MEMORY_ASSETS_PER_YEAR, Math.floor(MEMORY_ASSET_LIMIT / years.length));

    // Select random birthdays if there are more than 25 birthdays with assets
    if (years.length > MEMORY_ASSET_LIMIT) {
      birthdayYears = shuffle(years)
        .slice(0, MEMORY_ASSET_LIMIT)
        .sort((a, b) => b - a);
      assetsPerYear = 1;
    }

    const assets = await Promise.all(
      birthdayYears.map((year) =>
        this.memoryRepository.getPersonAssetsByDate(
          ownerId,
          personGroupId,
          { ...birthDate, year },
          assetsPerYear,
          lockVisibility,
        ),
      ),
    );

    return assets.flat();
  }

  @OnJob({ name: JobName.MemoryCleanup, queue: QueueName.BackgroundTask })
  async onMemoriesCleanup() {
    await this.memoryRepository.cleanup();
  }

  /** Memories only contain the viewer's own assets, so the only relevant lock owner is the viewer. */
  private getViewerLockVisibility(auth: AuthDto) {
    return this.lockRepository.getOwnerLockVisibility({
      viewerId: auth.user.id,
      ownerIds: [auth.user.id],
      revealed: auth.revealedLocks ?? NO_REVEALED_LOCKS,
      isElevated: !!auth.session?.hasElevatedPermission,
    });
  }

  async search(auth: AuthDto, dto: MemorySearchDto) {
    const memories = await this.memoryRepository.search(auth.user.id, dto, await this.getViewerLockVisibility(auth));
    return memories
      .filter((memory: Memory) => memory.assets && memory.assets.length > 0)
      .map((memory: Memory) => mapMemory(memory, auth));
  }

  async statistics(auth: AuthDto, dto: MemorySearchDto) {
    return this.memoryRepository.statistics(auth.user.id, dto, await this.getViewerLockVisibility(auth));
  }

  /**
   * Fork (7A.8e, R36-4, §15.2): outside elevation, a memory whose every asset is hidden is not found - matching
   * search({ id }) (the memories-page rule) - and refused exactly like a missing memory (ruling R32), for reads and for
   * every mutation (a write on hidden content). A memory that never had an asset is unaffected, so not-found is no
   * lock-state oracle. Returns the viewer's lock entries for reuse.
   */
  private async assertMemoryReachable(auth: AuthDto, id: string, permission: Permission) {
    const lockVisibility = await this.getViewerLockVisibility(auth);
    if (auth.session?.hasElevatedPermission || lockVisibility.length === 0) {
      return lockVisibility;
    }
    const filtered = await this.memoryRepository.get(id, lockVisibility);
    if (filtered && filtered.assets.length === 0) {
      const unfiltered = await this.memoryRepository.get(id);
      if (unfiltered && unfiltered.assets.length > 0) {
        throw new BadRequestException(`Not found or no ${permission} access`);
      }
    }
    return lockVisibility;
  }

  async get(auth: AuthDto, id: string): Promise<MemoryResponseDto> {
    await this.requireAccess({ auth, permission: Permission.MemoryRead, ids: [id] });
    const lockVisibility = await this.assertMemoryReachable(auth, id, Permission.MemoryRead);
    const memory = await this.findOrFail(id, lockVisibility);
    return mapMemory(memory, auth);
  }

  async create(auth: AuthDto, dto: MemoryCreateDto) {
    const assetIds = dto.assetIds || [];
    const allowedAssetIds = await this.checkAccess({
      auth,
      permission: Permission.AssetUpdate,
      ids: assetIds,
    });
    const memory = await this.memoryRepository.create(
      {
        ownerId: auth.user.id,
        type: dto.type,
        data: dto.data,
        isSaved: dto.isSaved,
        memoryAt: dto.memoryAt,
        showAt: dto.showAt,
        hideAt: dto.hideAt,
        seenAt: dto.seenAt,
      },
      allowedAssetIds,
    );

    return mapMemory(memory, auth);
  }

  async update(auth: AuthDto, id: string, dto: MemoryUpdateDto): Promise<MemoryResponseDto> {
    await this.requireAccess({ auth, permission: Permission.MemoryUpdate, ids: [id] });

    const lockVisibility = await this.assertMemoryReachable(auth, id, Permission.MemoryUpdate);
    const memory = await this.memoryRepository.update(
      id,
      {
        isSaved: dto.isSaved,
        memoryAt: dto.memoryAt,
        seenAt: dto.seenAt,
      },
      lockVisibility,
    );

    return mapMemory(memory, auth);
  }

  async remove(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.MemoryDelete, ids: [id] });
    await this.assertMemoryReachable(auth, id, Permission.MemoryDelete);
    await this.memoryRepository.delete(id);
  }

  async addAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.MemoryRead, ids: [id] });
    await this.assertMemoryReachable(auth, id, Permission.MemoryRead);

    const repos = { access: this.accessRepository, bulk: this.memoryRepository };
    const results = await addAssets(auth, repos, {
      parentId: id,
      assetIds: dto.ids,
      permission: Permission.AssetUpdate,
    });

    const hasSuccess = results.some(({ success }) => success);
    if (hasSuccess) {
      await this.memoryRepository.update(id, { updatedAt: new Date() });
    }

    return results;
  }

  async removeAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.MemoryUpdate, ids: [id] });
    await this.assertMemoryReachable(auth, id, Permission.MemoryUpdate);

    const repos = { access: this.accessRepository, bulk: this.memoryRepository };
    const results = await removeAssets(auth, repos, {
      parentId: id,
      assetIds: dto.ids,
      canAlwaysRemove: Permission.MemoryDelete,
    });

    const hasSuccess = results.some(({ success }) => success);
    if (hasSuccess) {
      await this.memoryRepository.update(id, { id, updatedAt: new Date() });
    }

    return results;
  }

  private findOrFail(id: string, lockVisibility?: OwnerLockVisibility[]) {
    return findOrFail(() => this.memoryRepository.get(id, lockVisibility), 'Memory');
  }
}
