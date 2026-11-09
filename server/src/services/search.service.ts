import { BadRequestException, Injectable } from '@nestjs/common';
import { LRUMap } from 'mnemonist';
import { AssetMapOptions, AssetResponseDto, MapAsset, mapAsset } from 'src/dtos/asset-response.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { SystemConfig } from 'src/dtos/config.dto.js';
import { PersonResponseDto, mapPerson } from 'src/dtos/person.dto.js';
import {
  LargeAssetSearchDto,
  MetadataSearchDto,
  PlacesResponseDto,
  RandomSearchDto,
  SearchFilter,
  SearchPeopleDto,
  SearchPlacesDto,
  SearchResponseDto,
  SearchStatisticsResponseDto,
  SearchSuggestionRequestDto,
  SearchSuggestionType,
  SmartSearchDto,
  StatisticsSearchDto,
  isFullyAlbumConfined,
  isNewShapeRequest,
  mapPlaces,
} from 'src/dtos/search.dto.js';
import { AssetOrder, AssetVisibility, Permission } from 'src/enum.js';
import { AssetSearchScope } from 'src/repositories/search.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { LockService } from 'src/services/lock.service.js';
import { requireElevatedPermission } from 'src/utils/access.js';
import { getMyPartnerIds } from 'src/utils/asset.util.js';
import { OwnerLockVisibility } from 'src/utils/database.js';
import { NO_REVEALED_LOCKS } from 'src/utils/lock-visibility.js';
import { isSmartSearchEnabled } from 'src/utils/misc.js';
import { decodeSearchCursor, encodeSearchCursor } from 'src/utils/search-cursor.js';
import { collectFilterIds } from 'src/utils/search-filter.js';

@Injectable()
export class SearchService extends BaseService {
  private embeddingCache = new LRUMap<string, string>(100);

  async searchPerson(auth: AuthDto, dto: SearchPeopleDto): Promise<PersonResponseDto[]> {
    // Same scope and lock rules as the people list: own/partner faces follow their owner's locks (the viewer's reveal
    // set only for the viewer's own, when elevated); shared-album faces follow album-grant rules (ruling R19).
    const partnerIds = await getMyPartnerIds({ userId: auth.user.id, repository: this.partnerRepository });
    const lockVisibility = await this.lockRepository.getOwnerLockVisibility({
      viewerId: auth.user.id,
      ownerIds: [auth.user.id, ...partnerIds],
      revealed: auth.revealedLocks ?? NO_REVEALED_LOCKS,
      isElevated: !!auth.session?.hasElevatedPermission,
    });
    const people = await this.personRepository.getByName(
      auth.user.id,
      dto.name,
      { withHidden: dto.withHidden, partnerIds },
      lockVisibility,
    );
    return people.map((person) => mapPerson(person));
  }

  async searchPlaces(dto: SearchPlacesDto): Promise<PlacesResponseDto[]> {
    const places = await this.searchRepository.searchPlaces(dto.name);
    return places.map((place) => mapPlaces(place));
  }

  async getExploreData(auth: AuthDto) {
    const options = { maxFields: 12, minAssetsPerField: 5 };

    const exploreLockVisibility = await this.getLockVisibility(auth, [auth.user.id]);
    const cities = await this.assetRepository.getAssetIdByCity(auth.user.id, options, exploreLockVisibility);
    const cityAssets = await this.assetRepository.getByIdsWithAllRelationsButStacks(
      cities.items.map(({ data }) => data),
      auth.user.id,
    );
    const cityItems = cityAssets.map((asset) => ({ value: asset.exifInfo!.city!, data: mapAsset(asset, { auth }) }));

    const recents = await this.assetRepository.getRecentlyCreatedAssetIds(
      auth.user.id,
      options.maxFields,
      exploreLockVisibility,
    );
    const recentAssets = await this.assetRepository.getByIdsWithAllRelationsButStacks(
      recents.items.map((item) => item.data),
      auth.user.id,
    );
    const recentItems = recentAssets.map((asset) => ({
      value: asset.createdAt.toISOString(),
      data: mapAsset(asset, { auth }),
    }));

    return [
      { fieldName: cities.fieldName, items: cityItems },
      { fieldName: recents.fieldName, items: recentItems },
    ];
  }

  async searchMetadata(auth: AuthDto, dto: MetadataSearchDto): Promise<SearchResponseDto> {
    if (isNewShapeRequest(dto)) {
      return this.searchMetadataV3(auth, dto);
    }

    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }

    let checksum: Buffer | undefined;
    if (dto.checksum) {
      const encoding = dto.checksum.length === 28 ? 'base64' : 'hex';
      checksum = Buffer.from(dto.checksum, encoding);
    }

    let userIds: string[] | undefined;

    if (dto.albumIds && dto.albumIds.length > 0) {
      await this.requireAccess({ auth, ids: dto.albumIds, permission: Permission.AlbumRead });
      // Album-scoped search follows the album-scoped timeline rule: a hidden album is
      // unreachable by known id outside an elevated session.
      const lockService = BaseService.create(LockService, this);
      for (const albumId of dto.albumIds) {
        await lockService.assertAlbumVisibleForViewer(auth, albumId);
      }
    } else if (auth.sharedLink) {
      throw new BadRequestException('Shared link access is only allowed in combination with an albumIds filter');
    } else {
      userIds = await this.getUserIdsToSearch(auth, dto.visibility);
    }

    const page = dto.page ?? 1;
    const size = dto.size;
    const { hasNextPage, items } = await this.searchRepository.searchMetadata(
      { page, size },
      {
        ...dto,
        checksum,
        visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
        userIds,
        viewingUserId: auth.user.id,
        orderDirection: dto.order ?? AssetOrder.Desc,
        lockVisibility: userIds ? await this.getLockVisibility(auth, userIds) : undefined,
      },
    );

    return this.mapResponse(items, { auth }, { nextPage: hasNextPage ? (page + 1).toString() : null });
  }

  async searchStatistics(auth: AuthDto, dto: StatisticsSearchDto): Promise<SearchStatisticsResponseDto> {
    if (isNewShapeRequest(dto)) {
      return this.searchStatisticsV3(auth, dto);
    }

    const userIds = await this.getUserIdsToSearch(auth, dto.visibility);
    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }

    return await this.searchRepository.searchStatistics({
      ...dto,
      visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
      userIds,
      lockVisibility: await this.getLockVisibility(auth, userIds),
      viewingUserId: auth.user.id,
    });
  }

  async searchRandom(auth: AuthDto, dto: RandomSearchDto): Promise<AssetResponseDto[]> {
    if (isNewShapeRequest(dto)) {
      return this.searchRandomV3(auth, dto);
    }

    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }

    const userIds = await this.getUserIdsToSearch(auth, dto.visibility);
    const items = await this.searchRepository.searchRandom(dto.size, {
      ...dto,
      visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
      userIds,
      lockVisibility: await this.getLockVisibility(auth, userIds),
      viewingUserId: auth.user.id,
    });
    return items.map((item) => mapAsset(item, { auth }));
  }

  async searchLargeAssets(auth: AuthDto, dto: LargeAssetSearchDto): Promise<AssetResponseDto[]> {
    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }

    const userIds = await this.getUserIdsToSearch(auth, dto.visibility);
    const items = await this.searchRepository.searchLargeAssets(dto.size, {
      ...dto,
      visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
      userIds,
      lockVisibility: await this.getLockVisibility(auth, userIds),
      viewingUserId: auth.user.id,
    });
    return items.map((item) => mapAsset(item, { auth }));
  }

  async searchSmart(auth: AuthDto, dto: SmartSearchDto): Promise<SearchResponseDto> {
    if (isNewShapeRequest(dto)) {
      return this.searchSmartV3(auth, dto);
    }

    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }

    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isSmartSearchEnabled(machineLearning)) {
      throw new BadRequestException('Smart search is not enabled');
    }

    const userIds = this.getUserIdsToSearch(auth, dto.visibility);
    const embedding = await this.resolveEmbedding(auth, dto, machineLearning);
    const page = dto.page ?? 1;
    const size = dto.size;
    const resolvedUserIds = await userIds;
    const { hasNextPage, items } = await this.searchRepository.searchSmart(
      { page, size },
      {
        ...dto,
        userIds: resolvedUserIds,
        viewingUserId: auth.user.id,
        embedding,
        visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
        lockVisibility: await this.getLockVisibility(auth, resolvedUserIds),
      },
    );

    return this.mapResponse(items, { auth }, { nextPage: hasNextPage ? (page + 1).toString() : null });
  }

  async getAssetsByCity(auth: AuthDto): Promise<AssetResponseDto[]> {
    const userIds = await this.getUserIdsToSearch(auth);
    const assets = await this.searchRepository.getAssetsByCity(userIds, await this.getLockVisibility(auth, userIds));
    return assets.map((asset) => mapAsset(asset));
  }

  async getSearchSuggestions(auth: AuthDto, dto: SearchSuggestionRequestDto) {
    const userIds = await this.getUserIdsToSearch(auth);
    const lockVisibility = await this.getLockVisibility(auth, userIds);
    const suggestions = await this.getSuggestions(userIds, dto, lockVisibility);
    if (dto.includeNull) {
      suggestions.push(null);
    }
    return suggestions;
  }

  private getSuggestions(
    userIds: string[],
    dto: SearchSuggestionRequestDto,
    lockVisibility?: OwnerLockVisibility[],
  ): Promise<Array<string | null>> {
    switch (dto.type) {
      case SearchSuggestionType.COUNTRY: {
        return this.searchRepository.getCountries(userIds, lockVisibility);
      }
      case SearchSuggestionType.STATE: {
        return this.searchRepository.getStates(userIds, dto, lockVisibility);
      }
      case SearchSuggestionType.CITY: {
        return this.searchRepository.getCities(userIds, dto, lockVisibility);
      }
      case SearchSuggestionType.CAMERA_MAKE: {
        return this.searchRepository.getCameraMakes(userIds, dto, lockVisibility);
      }
      case SearchSuggestionType.CAMERA_MODEL: {
        return this.searchRepository.getCameraModels(userIds, dto, lockVisibility);
      }
      case SearchSuggestionType.CAMERA_LENS_MODEL: {
        return this.searchRepository.getCameraLensModels(userIds, dto, lockVisibility);
      }
      default: {
        return Promise.resolve([]);
      }
    }
  }

  // FORK-PORT: lock-audit — new upstream v3 search paths (8b3d6b320): searchMetadataV3/StatisticsV3/RandomV3/SmartV3
  // build AssetSearchScope via resolveSearchScopeV3 with no lockVisibility (fork's getLockVisibility(auth, userIds) is
  // not threaded), lockedOwnerId relies on the retired AssetVisibility.Locked (D4; Task 2 deleted
  // applyLockedVisibilityPolicy and SearchFilterSchema now rejects `locked`), and album ids in the filter are not
  // rejected when smart (D6). Re-apply grant-aware lock enforcement per branch (D5, Task 5).
  private async searchMetadataV3(auth: AuthDto, dto: MetadataSearchDto): Promise<SearchResponseDto> {
    const { filter, scope } = await this.resolveSearchScopeV3(auth, dto);

    const { offset } = decodeSearchCursor(dto.cursor);
    const size = dto.size;
    const { hasNextPage, items } = await this.searchRepository.searchMetadataV3(
      { take: size, skip: offset },
      {
        filter,
        withExif: dto.withExif,
        withPeople: dto.withPeople,
        withStacked: dto.withStacked,
        order: dto.orderBy,
      },
      scope,
    );

    return this.mapResponse(items, { auth }, { nextCursor: hasNextPage ? encodeSearchCursor(offset + size) : null });
  }

  private async searchStatisticsV3(auth: AuthDto, dto: StatisticsSearchDto): Promise<SearchStatisticsResponseDto> {
    const { filter, scope } = await this.resolveSearchScopeV3(auth, dto);
    return this.searchRepository.searchStatisticsV3({ filter }, scope);
  }

  private async searchRandomV3(auth: AuthDto, dto: RandomSearchDto): Promise<AssetResponseDto[]> {
    const { filter, scope } = await this.resolveSearchScopeV3(auth, dto);
    const items = await this.searchRepository.searchRandomV3(
      dto.size,
      {
        filter,
        withExif: dto.withExif,
        withPeople: dto.withPeople,
        withStacked: dto.withStacked,
      },
      scope,
    );
    return items.map((item) => mapAsset(item, { auth }));
  }

  private async searchSmartV3(auth: AuthDto, dto: SmartSearchDto): Promise<SearchResponseDto> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isSmartSearchEnabled(machineLearning)) {
      throw new BadRequestException('Smart search is not enabled');
    }

    const [{ filter, scope }, embedding] = await Promise.all([
      this.resolveSearchScopeV3(auth, dto),
      this.resolveEmbedding(auth, dto, machineLearning),
    ]);

    // no cursor until a rank-aware pagination strategy for smart search is decided
    const { items } = await this.searchRepository.searchSmartV3(
      { take: dto.size },
      { filter, withExif: dto.withExif, embedding },
      scope,
    );

    return this.mapResponse(items, { auth });
  }

  private async resolveSearchScopeV3(
    auth: AuthDto,
    dto: { filter?: SearchFilter },
  ): Promise<{ filter: SearchFilter; scope: AssetSearchScope }> {
    // `locked` visibility is rejected by SearchFilterSchema validation (D4), so no locked-visibility policy applies.
    const filter = dto.filter ?? {};

    const fullyConfined = isFullyAlbumConfined(filter);
    // a shared link visitor does not have a universe, so there every branch must be confined
    if (auth.sharedLink && !fullyConfined) {
      throw new BadRequestException('Shared link access is only allowed in combination with an albumIds filter');
    }

    const albumIds = collectFilterIds(filter, 'albumIds');
    const [userIds] = await Promise.all([
      // a fully confined filter searches albums only, so the unused universe can skip the partner lookup
      fullyConfined ? [auth.user.id] : this.getUserIdsToSearch(auth),
      albumIds.length > 0 ? this.requireAccess({ auth, ids: albumIds, permission: Permission.AlbumRead }) : undefined,
    ]);

    return { filter, scope: { userIds, lockedOwnerId: auth.user.id, viewingUserId: auth.user.id } };
  }

  private async resolveEmbedding(
    auth: AuthDto,
    dto: SmartSearchDto,
    machineLearning: SystemConfig['machineLearning'],
  ): Promise<string> {
    if (dto.query) {
      const key = machineLearning.clip.modelName + dto.query + dto.language;
      let embedding = this.embeddingCache.get(key);
      if (!embedding) {
        embedding = await this.machineLearningRepository.encodeText(dto.query, {
          modelName: machineLearning.clip.modelName,
          language: dto.language,
        });
        this.embeddingCache.set(key, embedding);
      }
      return embedding;
    }

    if (dto.queryAssetId) {
      await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [dto.queryAssetId] });
      const getEmbeddingResponse = await this.searchRepository.getEmbedding(dto.queryAssetId);
      const assetEmbedding = getEmbeddingResponse?.embedding;
      if (!assetEmbedding) {
        throw new BadRequestException(`Asset ${dto.queryAssetId} has no embedding`);
      }
      return assetEmbedding;
    }

    throw new BadRequestException('Either `query` or `queryAssetId` must be set');
  }

  /**
   * Locked-content filter for search results. Each owner in the search scope (viewer and
   * timeline-enabled partners) contributes their OWN lock state; the viewer's reveal set
   * applies only to their own locks and only in an elevated session.
   */
  private async getLockVisibility(auth: AuthDto, ownerIds: string[]): Promise<OwnerLockVisibility[] | undefined> {
    const entries = await this.lockRepository.getOwnerLockVisibility({
      viewerId: auth.user.id,
      ownerIds,
      revealed: auth.revealedLocks ?? NO_REVEALED_LOCKS,
      isElevated: !!auth.session?.hasElevatedPermission,
    });
    return entries.length > 0 ? entries : undefined;
  }

  private async getUserIdsToSearch(auth: AuthDto, visibility?: AssetVisibility): Promise<string[]> {
    // Locked assets are personal. Never include partner IDs, regardless of A's elevated session.
    if (visibility === AssetVisibility.Locked) {
      return [auth.user.id];
    }
    const partnerIds = await getMyPartnerIds({
      userId: auth.user.id,
      repository: this.partnerRepository,
      timelineEnabled: true,
    });
    return [auth.user.id, ...partnerIds];
  }

  private mapResponse(
    assets: MapAsset[],
    options: AssetMapOptions,
    page: { nextPage?: string | null; nextCursor?: string | null } = {},
  ): SearchResponseDto {
    return {
      albums: { total: 0, count: 0, items: [], facets: [] },
      assets: {
        total: assets.length,
        count: assets.length,
        items: assets.map((asset) => mapAsset(asset, options)),
        facets: [],
        nextPage: page.nextPage ?? null,
        nextCursor: page.nextCursor ?? null,
      },
    };
  }
}
