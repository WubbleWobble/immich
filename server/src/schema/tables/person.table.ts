import {
  AfterDeleteTrigger,
  Check,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  type Generated,
  Index,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { person_delete_audit, person_delete_shares } from 'src/schema/functions.js';
import { AssetFaceTable } from 'src/schema/tables/asset-face.table.js';
import { PersonGroupTable } from 'src/schema/tables/person-group.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

@Table('person')
@Index({
  name: 'idx_person_name_trigram',
  using: 'gin',
  expression: 'f_unaccent("name") gin_trgm_ops',
})
@UpdatedAtTrigger('person_updatedAt')
@AfterDeleteTrigger({
  scope: 'statement',
  function: person_delete_audit,
  referencingOldTableAs: 'old',
  when: 'pg_trigger_depth() <= 1',
})
@AfterDeleteTrigger({
  name: 'person_delete_shares',
  scope: 'statement',
  function: person_delete_shares,
  referencingOldTableAs: 'deleted_rows',
})
@Check({ name: 'person_birthDate_chk', expression: `"birthDate" <= CURRENT_DATE` })
// Fork: rows whose published thumbnail has no verifiable source (pre-upgrade crops, or the source face was deleted).
// Startup regeneration counts these on every boot, so the check must stay an index-only probe.
@Index({
  name: 'person_thumbnail_unverified_idx',
  columns: ['ownerId'],
  where: `"thumbnailPath" <> '' AND "thumbnailSourceFaceId" IS NULL`,
})
export class PersonTable {
  @ForeignKeyColumn(() => UserTable, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    primary: true,
    // [ownerId, personGroupId] is the PK constraint
    index: false,
  })
  ownerId!: string;

  @ForeignKeyColumn(() => PersonGroupTable, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    primary: true,
  })
  personGroupId!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @Column({ default: '' })
  name!: Generated<string>;

  @Column({ default: '' })
  thumbnailPath!: Generated<string>;

  @Column({ type: 'boolean', default: false })
  isHidden!: Generated<boolean>;

  @Column({ type: 'date', nullable: true })
  birthDate!: Timestamp | null;

  @ForeignKeyColumn(() => AssetFaceTable, { onDelete: 'SET NULL', nullable: true })
  faceAssetId!: string | null;

  /**
   * Fork: the face whose crop is the file at `thumbnailPath`. Provenance is the pair (thumbnailPath,
   * thumbnailSourceFaceId), always written together in one UPDATE; `faceAssetId` is only the requested feature face
   * and can run ahead of the file. NULL means unverifiable: the thumbnail is never served.
   */
  @ForeignKeyColumn(() => AssetFaceTable, { onDelete: 'SET NULL', nullable: true })
  thumbnailSourceFaceId!: string | null;

  @Column({ type: 'boolean', default: false })
  isFavorite!: Generated<boolean>;

  @Column({ type: 'character varying', nullable: true, default: null })
  color!: string | null;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;
}
