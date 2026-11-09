import {
  Check,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  ForeignKeyColumn,
  type Generated,
  PrimaryGeneratedColumn,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';
import type { SmartAlbumFilter } from 'src/dtos/smart-album-filter.dto.js';
import { UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { AlbumKind, AssetOrder } from 'src/enum.js';
import { album_kind_enum } from 'src/schema/enums.js';
import { AlbumContainerTable } from 'src/schema/tables/album-container.table.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';

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

  @Column({ type: 'text', nullable: true })
  description!: string | null;

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

  // Display/debugging only: freshness is the revision pair below, never these timestamps.
  @Column({ type: 'timestamp with time zone', nullable: true })
  cacheComputedAt!: Date | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  cacheInvalidatedAt!: Date | null;

  // Smart-album cache freshness: every invalidation (asset write, filter edit, ...) increments cacheRevision in SQL;
  // a recompute publishes only if cacheRevision still equals the revision it read with the filter, recording it in
  // cachedRevision. Fresh <=> cachedRevision = cacheRevision; NULL (never published) is stale.
  @Column({ type: 'integer', default: 0 })
  cacheRevision!: Generated<number>;

  @Column({ type: 'integer', nullable: true })
  cachedRevision!: number | null;

  @ForeignKeyColumn(() => AlbumContainerTable, { nullable: true, onUpdate: 'CASCADE', onDelete: 'SET NULL' })
  containerId!: string | null;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;
}
