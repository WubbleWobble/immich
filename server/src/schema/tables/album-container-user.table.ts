import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Generated,
  Index,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { CreateIdColumn, UpdatedAtTrigger, UpdateIdColumn } from 'src/decorators';
import { AlbumUserRole } from 'src/enum';
import { album_user_role_enum } from 'src/schema/enums';
import { AlbumContainerTable } from 'src/schema/tables/album-container.table';
import { UserTable } from 'src/schema/tables/user.table';

@Table({ name: 'album_container_user' })
@Index({
  name: 'album_container_user_unique_owner',
  columns: ['albumContainerId'],
  unique: true,
  where: `role = 'owner'`,
})
@UpdatedAtTrigger('album_container_user_updatedAt')
export class AlbumContainerUserTable {
  @ForeignKeyColumn(() => AlbumContainerTable, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: false,
    primary: true,
  })
  albumContainerId!: string;

  @ForeignKeyColumn(() => UserTable, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: false,
    primary: true,
  })
  userId!: string;

  @Column({ enum: album_user_role_enum, default: AlbumUserRole.Editor })
  role!: Generated<AlbumUserRole>;

  @CreateIdColumn({ index: true })
  createId!: Generated<string>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
