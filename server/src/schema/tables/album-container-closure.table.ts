import { Check, Column, ForeignKeyColumn, Table } from '@immich/sql-tools';
import { AlbumContainerTable } from 'src/schema/tables/album-container.table';

@Table('album_container_closure')
// Created by 1784910000003-AddAlbumContainers; declared here so the schema matches the code.
// Mirrors MAX_DEPTH in album-container.service.ts.
@Check({ name: 'album_container_closure_depth_max', expression: `"depth" <= 16` })
export class AlbumContainerClosureTable {
  @ForeignKeyColumn(() => AlbumContainerTable, {
    primary: true,
    onDelete: 'CASCADE',
    onUpdate: 'NO ACTION',
    index: true,
  })
  id_ancestor!: string;

  @ForeignKeyColumn(() => AlbumContainerTable, {
    primary: true,
    onDelete: 'CASCADE',
    onUpdate: 'NO ACTION',
    index: true,
  })
  id_descendant!: string;

  @Column({ type: 'integer' })
  depth!: number;
}
