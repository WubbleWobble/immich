import { Column, ForeignKeyColumn, Table } from '@immich/sql-tools';
import { AlbumContainerTable } from 'src/schema/tables/album-container.table';

@Table('album_container_closure')
export class AlbumContainerClosureTable {
  @ForeignKeyColumn(() => AlbumContainerTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'NO ACTION', index: true })
  id_ancestor!: string;

  @ForeignKeyColumn(() => AlbumContainerTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'NO ACTION', index: true })
  id_descendant!: string;

  @Column({ type: 'integer' })
  depth!: number;
}
