import { CreateDateColumn, ForeignKeyColumn, Generated, Table, Timestamp } from '@immich/sql-tools';
import { AlbumContainerTable } from 'src/schema/tables/album-container.table';
import { UserTable } from 'src/schema/tables/user.table';

/**
 * Per-user lock state for album containers (folders). Locking a folder cascades through
 * album_container_closure to every descendant folder and the albums inside them.
 * See ../immich-specs/2026-05-24-locked-albums-and-folders-design.md §5.2.
 */
@Table({ name: 'locked_container' })
export class LockedContainerTable {
  @ForeignKeyColumn(() => UserTable, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: false,
    primary: true,
  })
  userId!: string;

  @ForeignKeyColumn(() => AlbumContainerTable, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: false,
    primary: true,
    index: true,
  })
  containerId!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
