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
    const cityAssets = await this.withholdHiddenMotionIds(
      await this.assetRepository.getByIdsWithAllRelationsButStacks(
        cities.items.map(({ data }) => data),
        auth.user.id,
      ),
      exploreLockVisibility,
    );
    const cityItems = cityAssets.map((asset) => ({ value: asset.exifInfo!.city!, data: mapAsset(asset, { auth }) }));

    const recents = await this.assetRepository.getRecentlyCreatedAssetIds(
      auth.user.id,
      options.maxFields,
      exploreLockVisibility,
    );
    const recentAssets = await this.withholdHiddenMotionIds(
      await this.assetRepository.getByIdsWithAllRelationsButStacks(
        recents.items.map((item) => item.data),
        auth.user.id,
      ),
      exploreLockVisibility,
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
      await this.requireSearchableAlbums(auth, dto.albumIds);
    } else if (auth.sharedLink) {
      throw new BadRequestException('Shared link access is only allowed in combination with an albumIds filter');
    } else {
      userIds = await this.getUserIdsToSearch(auth, dto.visibility);
    }

    const page = dto.page ?? 1;
    const size = dto.size;
    const lockVisibility = userIds ? await this.getLockVisibility(auth, userIds) : undefined;
    const { hasNextPage, items } = await this.searchRepository.searchMetadata(
      { page, size },
      {
        ...dto,
        checksum,
        visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
        userIds,
        viewingUserId: auth.user.id,
        orderDirection: dto.order ?? AssetOrder.Desc,
        lockVisibility,
      },
    );

    return this.mapResponse(
      await this.withholdHiddenMotionIds(items, lockVisibility),
      { auth },
      {
        nextPage: hasNextPage ? (page + 1).toString() : null,
      },
    );
  }

  async searchStatistics(auth: AuthDto, dto: StatisticsSearchDto): Promise<SearchStatisticsResponseDto> {
    if (isNewShapeRequest(dto)) {
      return this.searchStatisticsV3(auth, dto);
    }

    await this.requireSearchableAlbums(auth, dto.albumIds ?? []);

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

    await this.requireSearchableAlbums(auth, dto.albumIds ?? []);

    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }

    const userIds = await this.getUserIdsToSearch(auth, dto.visibility);
    const lockVisibility = await this.getLockVisibility(auth, userIds);
    const items = await this.searchRepository.searchRandom(dto.size, {
      ...dto,
      visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
      userIds,
      lockVisibility,
      viewingUserId: auth.user.id,
    });
    const visible = await this.withholdHiddenMotionIds(items, lockVisibility);
    return visible.map((item) => mapAsset(item, { auth }));
  }

  async searchLargeAssets(auth: AuthDto, dto: LargeAssetSearchDto): Promise<AssetResponseDto[]> {
    await this.requireSearchableAlbums(auth, dto.albumIds ?? []);

    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }

    const userIds = await this.getUserIdsToSearch(auth, dto.visibility);
    const lockVisibility = await this.getLockVisibility(auth, userIds);
    const items = await this.searchRepository.searchLargeAssets(dto.size, {
      ...dto,
      visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
      userIds,
      lockVisibility,
      viewingUserId: auth.user.id,
    });
    const visible = await this.withholdHiddenMotionIds(items, lockVisibility);
    return visible.map((item) => mapAsset(item, { auth }));
  }

  async searchSmart(auth: AuthDto, dto: SmartSearchDto): Promise<SearchResponseDto> {
    if (isNewShapeRequest(dto)) {
      return this.searchSmartV3(auth, dto);
    }

    await this.requireSearchableAlbums(auth, dto.albumIds ?? []);

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
    const lockVisibility = await this.getLockVisibility(auth, resolvedUserIds);
    const { hasNextPage, items } = await this.searchRepository.searchSmart(
      { page, size },
      {
        ...dto,
        userIds: resolvedUserIds,
        viewingUserId: auth.user.id,
        embedding,
        visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
        lockVisibility,
      },
    );

    return this.mapResponse(
      await this.withholdHiddenMotionIds(items, lockVisibility),
      { auth },
      {
        nextPage: hasNextPage ? (page + 1).toString() : null,
      },
    );
  }

  async getAssetsByCity(auth: AuthDto): Promise<AssetResponseDto[]> {
    const userIds = await this.getUserIdsToSearch(auth);
    const lockVisibility = await this.getLockVisibility(auth, userIds);
    const assets = await this.searchRepository.getAssetsByCity(userIds, lockVisibility);
    const visible = await this.withholdHiddenMotionIds(assets, lockVisibility);
    return visible.map((asset) => mapAsset(asset));
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

  // Fork: the V3 search paths take their lock-aware universe from resolveSearchScopeV3 (D5) - see AssetSearchScope.
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

    return this.mapResponse(
      await this.withholdHiddenMotionIds(items, scope),
      { auth },
      {
        nextCursor: hasNextPage ? encodeSearchCursor(offset + size) : null,
      },
    );
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
    const visible = await this.withholdHiddenMotionIds(items, scope);
    return visible.map((item) => mapAsset(item, { auth }));
  }

  private async searchSmartV3(auth: AuthDto, dto: SmartSearchDto): Promise<SearchResponseDto> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isSmartSearchEnabled(machineLearning)) {
      throw new BadRequestException('Smart search is not enabled');
    }

    // Fork (S9): the scope (album validation, shared-link confinement) is settled before the embedding is resolved, so
    // a refused request never reaches machine learning or reads a query asset's embedding.
    const { filter, scope } = await this.resolveSearchScopeV3(auth, dto);
    const embedding = await this.resolveEmbedding(auth, dto, machineLearning);

    // no cursor until a rank-aware pagination strategy for smart search is decided
    const { items } = await this.searchRepository.searchSmartV3(
      { take: dto.size },
      { filter, withExif: dto.withExif, embedding },
      scope,
    );

    return this.mapResponse(await this.withholdHiddenMotionIds(items, scope), { auth });
  }

  private async resolveSearchScopeV3(
    auth: AuthDto,
    dto: { filter?: SearchFilter },
  ): Promise<{ filter: SearchFilter; scope: AssetSearchScope }> {
    // `locked` visibility is rejected by SearchFilterSchema validation (D4); locks are album/folder based and applied
    // through the scope below, outside the user's filter tree (D5).
    const filter = dto.filter ?? {};

    const fullyConfined = isFullyAlbumConfined(filter);
    // a shared link visitor does not have a universe, so there every branch must be confined
    if (auth.sharedLink && !fullyConfined) {
      throw new BadRequestException('Shared link access is only allowed in combination with an albumIds filter');
    }

    // every album the filter names (any/all/none, root and `or` branches) is validated before the query runs
    await this.requireSearchableAlbums(auth, collectFilterIds(filter, 'albumIds'));

    // album arm: the positive album conditions are the album grants (album-grant rules, spec §4/§15.1)
    const grantedAlbumIds = collectFilterIds(filter, 'albumIds', ['any', 'all']);
    // timeline/partner arm: a fully confined filter searches its albums only, so it has none
    const userIds = fullyConfined ? [] : await this.getUserIdsToSearch(auth);
    const lockVisibility = userIds.length > 0 ? await this.getLockVisibility(auth, userIds) : undefined;

    return { filter, scope: { userIds, lockVisibility, grantedAlbumIds, viewingUserId: auth.user.id } };
  }

  /**
   * Album ids named by a search (v1 `albumIds`, or any v3 album operator) are validated before the query runs, in
   * this order: album.read access; then that no album is hidden for the viewer (an elevated session bypasses, as for
   * album-scoped timelines - spec §15.3 direct-by-id); then smart albums are refused (D6). Authorization runs first,
   * so an album the caller cannot read never reveals that it is smart.
   */
  private async requireSearchableAlbums(auth: AuthDto, albumIds: string[]): Promise<void> {
    if (albumIds.length === 0) {
      return;
    }

    await this.requireAccess({ auth, ids: albumIds, permission: Permission.AlbumRead });

    const lockService = BaseService.create(LockService, this);
    for (const albumId of albumIds) {
      await lockService.assertAlbumVisibleForViewer(auth, albumId);
    }

    const smartAlbumIds = await this.albumRepository.getSmartAlbumIds(albumIds);
    if (smartAlbumIds.length > 0) {
      throw new BadRequestException('Smart albums cannot be used as a search album filter');
    }
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

  /**
   * Fork (R56): results never enumerate a hidden motion part - judged by the lock entries the search was filtered
   * with, plus the V3 scope's album arm (granted albums reach a motion part through its still).
   */
  private withholdHiddenMotionIds<T extends { livePhotoVideoId: string | null }>(
    assets: T[],
    scope: OwnerLockVisibility[] | Pick<AssetSearchScope, 'lockVisibility' | 'grantedAlbumIds'> | undefined,
  ): Promise<T[]> {
    const lockService = BaseService.create(LockService, this);
    return !scope || Array.isArray(scope)
      ? lockService.withholdHiddenMotionIds(assets, scope)
      : lockService.withholdHiddenMotionIds(assets, scope.lockVisibility, scope.grantedAlbumIds);
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
