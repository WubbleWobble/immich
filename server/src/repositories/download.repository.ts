import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AssetVisibility } from 'src/enum';
import { AssetSearchOptions } from 'src/repositories/search.repository';
import { DB } from 'src/schema';
import { anyUuid, searchAssetBuilder } from 'src/utils/database';

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

  // Smart albums have no album_asset rows; stream whatever the filter matches instead of
  // materializing the full id list first.
  downloadSearchResults(options: AssetSearchOptions) {
    return searchAssetBuilder(this.db, options)
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select(['asset.id', 'asset.livePhotoVideoId', 'asset_exif.fileSizeInByte as size'])
      .stream();
  }

  downloadUserId(userId: string) {
    return builder(this.db)
      .where('asset.ownerId', '=', userId)
      .where('asset.visibility', '!=', AssetVisibility.Hidden)
      .stream();
  }
}
