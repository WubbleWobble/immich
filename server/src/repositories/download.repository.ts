import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AssetVisibility } from 'src/enum';
import { AssetSearchOptions } from 'src/repositories/search.repository';
import { DB } from 'src/schema';
import {
  anyUuid,
  joinDeduplicationPlugin,
  OwnerLockVisibility,
  searchAssetIdSubquery,
  withLockVisibility,
} from 'src/utils/database';

const builder = (db: Kysely<DB>) =>
  db
    .selectFrom('asset')
    .innerJoin('asset_exif', 'assetId', 'id')
    .select(['asset.id', 'asset.livePhotoVideoId', 'asset_exif.fileSizeInByte as size'])
    .where('asset.deletedAt', 'is', null);

@Injectable()
export class DownloadRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  downloadAssetIds(ids: string[]) {
    return builder(this.db).where('asset.id', '=', anyUuid(ids)).stream();
  }

  downloadMotionAssetIds(ids: string[]) {
    return builder(this.db).select(['asset.originalPath']).where('asset.id', '=', anyUuid(ids)).stream();
  }

  downloadAlbumId(albumId: string) {
    return builder(this.db)
      .innerJoin('album_asset', 'asset.id', 'album_asset.assetId')
      .where('album_asset.albumId', '=', albumId)
      .stream();
  }

  // Smart albums have no album_asset rows; membership is applied as an id subquery so the
  // download query keeps its own asset_exif join regardless of which EXIF fields the filter
  // uses, and rows stream without materializing the full id list first.
  downloadSearchResults(options: AssetSearchOptions) {
    return (
      builder(this.db)
        .where('asset.id', 'in', searchAssetIdSubquery(this.db, options))
        // The embedded subquery relies on the root query to deduplicate its joins.
        .withPlugin(joinDeduplicationPlugin)
        .stream()
    );
  }

  downloadUserId(userId: string, lockVisibility?: OwnerLockVisibility[]) {
    return builder(this.db)
      .where('asset.ownerId', '=', userId)
      .where('asset.visibility', '!=', AssetVisibility.Hidden)
      .$if(!!lockVisibility?.length, (qb) =>
        // Embedded lock-visibility subqueries rely on the root query for join deduplication.
        withLockVisibility(qb, this.db, lockVisibility!).withPlugin(joinDeduplicationPlugin),
      )
      .stream();
  }
}
