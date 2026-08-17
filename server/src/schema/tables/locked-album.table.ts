import { CreateDateColumn, ForeignKeyColumn, Generated, Table, Timestamp } from '@immich/sql-tools';
import { AlbumTable } from 'src/schema/tables/album.table';
import { UserTable } from 'src/schema/tables/user.table';

/**
 * Per-user lock state for albums (regular and smart alike - both live in the album table).
 * A row means "this user has hidden this album from their own view". Lock state is never
 * shared: sharees see the album normally and may lock it independently.
 * See ../immich-specs/2026-05-24-locked-albums-and-folders-design.md §5.1.
 */
@Table({ name: 'locked_album' })
export class LockedAlbumTable {
  @ForeignKeyColumn(() => UserTable, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: false,
    primary: true,
  })
  userId!: string;

  @ForeignKeyColumn(() => AlbumTable, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: false,
    primary: true,
    index: true,
  })
  albumId!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
