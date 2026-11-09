import { Column, CreateDateColumn, type Generated, Table, Timestamp } from '@immich/sql-tools';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators.js';

@Table('asset_audit')
export class AssetAuditTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @Column({ type: 'uuid', index: true })
  assetId!: string;

  @Column({ type: 'uuid', index: true })
  ownerId!: string;

  @CreateDateColumn({ default: () => 'clock_timestamp()', index: true })
  deletedAt!: Generated<Timestamp>;

  /**
   * Fork (ruling R66): the owner's lock verdict judged before the delete - true when the row was hidden by the owner's
   * own locks outside elevation (for a stack: any member was). Partner delete streams skip true rows; NULL (legacy or
   * judged visible) streams. Set by the deleting repository call in the delete's transaction.
   */
  @Column({ type: 'boolean', nullable: true })
  ownerHidden!: boolean | null;
}
