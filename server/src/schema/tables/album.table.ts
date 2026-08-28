import {
  Check,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  ForeignKeyColumn,
  Generated,
  PrimaryGeneratedColumn,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { UpdatedAtTrigger, UpdateIdColumn } from 'src/decorators';
import type { SmartAlbumFilter } from 'src/dtos/smart-album-filter.dto';
import { AlbumKind, AssetOrder } from 'src/enum';
import { album_kind_enum } from 'src/schema/enums';
import { AlbumContainerTable } from 'src/schema/tables/album-container.table';
import { AssetTable } from 'src/schema/tables/asset.table';

@Table({ name: 'album' })
@UpdatedAtTrigger('album_updatedAt')
// Created by 1784910000001-AddAlbumSmartKind; declared here so the schema matches the code.
@Check({
  name: 'album_kind_filter_consistency',
  expression: `("kind" = 'smart' AND "filter" IS NOT NULL) OR ("kind" = 'regular' AND "filter" IS NULL)`,
})
export class AlbumTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column({ default: 'Untitled Album' })
  albumName!: Generated<string>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @ForeignKeyColumn(() => AssetTable, {
    nullable: true,
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    comment: 'Asset ID to be used as thumbnail',
  })
  albumThumbnailAssetId!: string | null;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @Column({ type: 'text', default: '' })
  description!: Generated<string>;

  @DeleteDateColumn()
  deletedAt!: Timestamp | null;

  @Column({ type: 'boolean', default: true })
  isActivityEnabled!: Generated<boolean>;

  @Column({ default: AssetOrder.Desc })
  order!: Generated<AssetOrder>;

  @Column({ enum: album_kind_enum, default: AlbumKind.Regular })
  kind!: Generated<AlbumKind>;

  @Column({ type: 'jsonb', nullable: true })
  filter!: SmartAlbumFilter | null;

  // Smart-album list-view metadata cache. Populated by AlbumService on read when stale.
  // See ../immich-specs/2026-05-22-smart-albums-design.md (cache section).
  @Column({ type: 'integer', nullable: true })
  cachedAssetCount!: number | null;

  @ForeignKeyColumn(() => AssetTable, {
    nullable: true,
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    comment: 'Cached thumbnail asset id for smart albums',
  })
  cachedThumbnailAssetId!: string | null;

  @Column({ type: 'date', nullable: true })
  cachedStartDate!: string | null;

  @Column({ type: 'date', nullable: true })
  cachedEndDate!: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  cacheComputedAt!: Date | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  cacheInvalidatedAt!: Date | null;

  @ForeignKeyColumn(() => AlbumContainerTable, { nullable: true, onUpdate: 'CASCADE', onDelete: 'SET NULL' })
  containerId!: string | null;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;
}
