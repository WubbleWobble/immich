import { schemaDiff, schemaFromCode, schemaFromDatabase } from '@immich/sql-tools';
import { Injectable } from '@nestjs/common';
import AsyncLock from 'async-lock';
import { FileMigrationProvider, Kysely, Migrator, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import semver from 'semver';
import {
  EXTENSION_NAMES,
  POSTGRES_VERSION_RANGE,
  VECTOR_EXTENSIONS,
  VECTOR_INDEX_TABLES,
  VECTOR_VERSION_RANGE,
  VECTORCHORD_LIST_SLACK_FACTOR,
  VECTORCHORD_VERSION_RANGE,
} from 'src/constants';
import { GenerateSql } from 'src/decorators';
import { DatabaseExtension, DatabaseLock, VectorIndex } from 'src/enum';
import { ConfigRepository } from 'src/repositories/config.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import 'src/schema'; // make sure all schema definitions are imported for schemaFromCode
import { DB } from 'src/schema';
import { immich_uuid_v7 } from 'src/schema/functions';
import { ExtensionVersion, VectorExtension } from 'src/types';
import { vectorIndexQuery } from 'src/utils/database';
import z from 'zod';

export let cachedVectorExtension: VectorExtension | undefined;
export async function getVectorExtension(runner: Kysely<DB>): Promise<VectorExtension> {
  if (cachedVectorExtension) {
    return cachedVectorExtension;
  }

  cachedVectorExtension = new ConfigRepository().getEnv().database.vectorExtension;
  if (cachedVectorExtension) {
    return cachedVectorExtension;
  }

  const query = `SELECT name FROM pg_available_extensions WHERE name IN (${VECTOR_EXTENSIONS.map((ext) => `'${ext}'`).join(', ')})`;
  const { rows: availableExtensions } = await sql.raw<{ name: VectorExtension }>(query).execute(runner);
  const extensionNames = new Set(availableExtensions.map((row) => row.name));
  cachedVectorExtension = VECTOR_EXTENSIONS.find((ext) => extensionNames.has(ext));
  if (!cachedVectorExtension) {
    throw new Error(`No vector extension found. Available extensions: ${VECTOR_EXTENSIONS.join(', ')}`);
  }
  return cachedVectorExtension;
}

export const probes: Record<VectorIndex, number> = {
  [VectorIndex.Clip]: 1,
  [VectorIndex.Face]: 1,
};

@Injectable()
export class DatabaseRepository {
  private readonly asyncLock = new AsyncLock();

  constructor(
    @InjectKysely() private db: Kysely<DB>,
    private logger: LoggingRepository,
    private configRepository: ConfigRepository,
  ) {
    this.logger.setContext(DatabaseRepository.name);
  }

  async shutdown() {
    await this.db.destroy();
  }

  getVectorExtension(): Promise<VectorExtension> {
    return getVectorExtension(this.db);
  }

  @GenerateSql({ params: [[DatabaseExtension.Vector]] })
  async getExtensionVersions(extensions: readonly DatabaseExtension[]): Promise<ExtensionVersion[]> {
    const { rows } = await sql<ExtensionVersion>`
      SELECT name, default_version as "availableVersion", installed_version as "installedVersion"
      FROM pg_available_extensions
      WHERE name in (${sql.join(extensions)})
    `.execute(this.db);
    return rows;
  }

  getExtensionVersionRange(extension: VectorExtension): string {
    switch (extension) {
      case DatabaseExtension.VectorChord: {
        return VECTORCHORD_VERSION_RANGE;
      }
      case DatabaseExtension.Vector: {
        return VECTOR_VERSION_RANGE;
      }
      default: {
        throw new Error(`Unsupported vector extension: '${extension}'`);
      }
    }
  }

  @GenerateSql()
  async getPostgresVersion(): Promise<string> {
    const { rows } = await sql<{ server_version: string }>`SHOW server_version`.execute(this.db);
    return rows[0].server_version;
  }

  getPostgresVersionRange(): string {
    return POSTGRES_VERSION_RANGE;
  }

  async createExtension(extension: DatabaseExtension): Promise<void> {
    this.logger.log(`Creating ${EXTENSION_NAMES[extension]} extension`);
    await sql`CREATE EXTENSION IF NOT EXISTS ${sql.raw(extension)} CASCADE`.execute(this.db);
    if (extension === DatabaseExtension.VectorChord) {
      const dbName = sql.id(await this.getDatabaseName());
      await sql`ALTER DATABASE ${dbName} SET vchordrq.probes = 1`.execute(this.db);
      await sql`SET vchordrq.probes = 1`.execute(this.db);
    }
  }

  async dropExtension(extension: DatabaseExtension): Promise<void> {
    this.logger.log(`Dropping ${EXTENSION_NAMES[extension]} extension`);
    await sql`DROP EXTENSION IF EXISTS ${sql.raw(extension)}`.execute(this.db);
  }

  async updateVectorExtension(extension: VectorExtension, targetVersion?: string): Promise<void> {
    const [{ availableVersion, installedVersion }] = await this.getExtensionVersions([extension]);
    if (!installedVersion) {
      throw new Error(`${EXTENSION_NAMES[extension]} extension is not installed`);
    }

    if (!availableVersion) {
      throw new Error(`No available version for ${EXTENSION_NAMES[extension]} extension`);
    }
    targetVersion ??= availableVersion;

    if (!semver.diff(installedVersion, targetVersion)) {
      return;
    }

    await Promise.all([
      this.db.schema.dropIndex(VectorIndex.Clip).ifExists().execute(),
      this.db.schema.dropIndex(VectorIndex.Face).ifExists().execute(),
    ]);

    await sql`ALTER EXTENSION ${sql.raw(extension)} UPDATE TO ${sql.lit(targetVersion)}`.execute(this.db);
    await Promise.all([this.reindexVectors(VectorIndex.Clip), this.reindexVectors(VectorIndex.Face)]);
  }

  async prewarm(index: VectorIndex): Promise<void> {
    const vectorExtension = await getVectorExtension(this.db);
    if (vectorExtension !== DatabaseExtension.VectorChord) {
      return;
    }
    this.logger.debug(`Prewarming ${index}`);
    await sql`SELECT vchordrq_prewarm(${index})`.execute(this.db);
  }

  async reindexVectorsIfNeeded(names: VectorIndex[]): Promise<void> {
    const { rows } = await sql<{
      indexdef: string;
      indexname: string;
    }>`SELECT indexdef, indexname FROM pg_indexes WHERE indexname = ANY(ARRAY[${sql.join(names)}])`.execute(this.db);

    const vectorExtension = await getVectorExtension(this.db);

    const promises = [];
    for (const indexName of names) {
      const row = rows.find((index) => index.indexname === indexName);
      const table = VECTOR_INDEX_TABLES[indexName];
      if (!row) {
        promises.push(this.reindexVectors(indexName));
        continue;
      }

      switch (vectorExtension) {
        case DatabaseExtension.Vector: {
          if (!row.indexdef.toLowerCase().includes('using hnsw')) {
            promises.push(this.reindexVectors(indexName));
          }
          break;
        }
        case DatabaseExtension.VectorChord: {
          const matches = row.indexdef.match(/(?<=lists = \[)\d+/g);
          const lists = matches && matches.length > 0 ? Number(matches[0]) : 1;
          promises.push(
            this.getRowCount(table).then((count) => {
              const targetLists = this.targetListCount(count);
              this.logger.log(`targetLists=${targetLists}, current=${lists} for ${indexName} of ${count} rows`);
              if (
                !row.indexdef.toLowerCase().includes('using vchordrq') ||
                // slack factor is to avoid frequent reindexing if the count is borderline
                (lists !== targetLists && lists !== this.targetListCount(count * VECTORCHORD_LIST_SLACK_FACTOR))
              ) {
                probes[indexName] = this.targetProbeCount(targetLists);
                return this.reindexVectors(indexName, { lists: targetLists });
              }
              probes[indexName] = this.targetProbeCount(lists);
            }),
          );
          break;
        }
      }
    }

    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }

  private async reindexVectors(indexName: VectorIndex, { lists }: { lists?: number } = {}): Promise<void> {
    this.logger.log(`Reindexing ${indexName} (This may take a while, do not restart)`);
    const table = VECTOR_INDEX_TABLES[indexName];
    const vectorExtension = await getVectorExtension(this.db);

    const { rows } = await sql<{
      columnName: string;
    }>`SELECT column_name as "columnName" FROM information_schema.columns WHERE table_name = ${table}`.execute(this.db);
    if (rows.length === 0) {
      this.logger.warn(
        `Table ${table} does not exist, skipping reindexing. This is only normal if this is a new Immich instance.`,
      );
      return;
    }
    const dimSize = await this.getDimensionSize(table);
    lists ||= this.targetListCount(await this.getRowCount(table));
    await this.db.transaction().execute(async (tx) => {
      await sql`DROP INDEX IF EXISTS ${sql.raw(indexName)}`.execute(tx);
      if (table === 'smart_search') {
        await sql`ALTER TABLE ${sql.raw(table)} DROP CONSTRAINT IF EXISTS dim_size_constraint`.execute(tx);
      }
      if (rows.every((row) => row.columnName !== 'embedding')) {
        this.logger.warn(`Column 'embedding' does not exist in table '${table}', truncating and adding column.`);
        await sql`TRUNCATE TABLE ${sql.raw(table)}`.execute(tx);
        await sql`ALTER TABLE ${sql.raw(table)} ADD COLUMN embedding real[] NOT NULL`.execute(tx);
      }
      await sql`ALTER TABLE ${sql.raw(table)} ALTER COLUMN embedding SET DATA TYPE real[]`.execute(tx);
      await sql`
        ALTER TABLE ${sql.raw(table)}
        ALTER COLUMN embedding
        SET DATA TYPE vector(${sql.raw(String(dimSize))})`.execute(tx);
      await sql.raw(vectorIndexQuery({ vectorExtension, table, indexName, lists })).execute(tx);
    });
    try {
      await sql`VACUUM ANALYZE ${sql.raw(table)}`.execute(this.db);
    } catch (error: any) {
      this.logger.warn(`Failed to vacuum table '${table}'. The DB will temporarily use more disk space: ${error}`);
    }
    this.logger.log(`Reindexed ${indexName}`);
  }

  private async getDatabaseName(): Promise<string> {
    const { rows } = await sql<{ db: string }>`SELECT current_database() as db`.execute(this.db);
    return rows[0].db;
  }

  getMigrations() {
    return this.db.selectFrom('kysely_migrations').select(['name', 'timestamp']).orderBy('name', 'asc').execute();
  }

  async getSchemaDrift() {
    const source = schemaFromCode({
      overrides: true,
      namingStrategy: 'default',
      uuidFunction: (version) => (version === 7 ? `${immich_uuid_v7.name}()` : 'uuid_generate_v4()'),
    });
    const { database } = this.configRepository.getEnv();
    const target = await schemaFromDatabase({ connection: database.config });

    const drift = schemaDiff(source, target, {
      tables: { ignoreExtra: true },
      constraints: { ignoreExtra: false },
      indexes: { ignoreExtra: true },
      triggers: { ignoreExtra: true },
      columns: { ignoreExtra: true },
      functions: { ignoreExtra: false },
      parameters: { ignoreExtra: true },
      extensions: { ignoreExtra: true },
    });

    return drift;
  }

  async getDimensionSize(table: string, column = 'embedding'): Promise<number> {
    const { rows } = await sql<{ dimsize: number }>`
      SELECT atttypmod as dimsize
      FROM pg_attribute f
        JOIN pg_class c ON c.oid = f.attrelid
      WHERE c.relkind = 'r'::char
        AND f.attnum > 0
        AND c.relname = ${table}::text
        AND f.attname = ${column}::text
    `.execute(this.db);

    const dimSize = rows[0]?.dimsize;
    if (
      !z
        .int()
        .min(1)
        .max(2 ** 16)
        .safeParse(dimSize).success
    ) {
      this.logger.warn(`Could not retrieve dimension size of column '${column}' in table '${table}', assuming 512`);
      return 512;
    }
    return dimSize;
  }

  async setDimensionSize(dimSize: number): Promise<void> {
    if (
      !z
        .int()
        .min(1)
        .max(2 ** 16)
        .safeParse(dimSize).success
    ) {
      throw new Error(`Invalid CLIP dimension size: ${dimSize}`);
    }

    // this is done in two transactions to handle concurrent writes
    await this.db.transaction().execute(async (trx) => {
      await sql`delete from ${sql.table('smart_search')}`.execute(trx);
      await trx.schema.alterTable('smart_search').dropConstraint('dim_size_constraint').ifExists().execute();
      await sql`alter table ${sql.table('smart_search')} add constraint dim_size_constraint check (array_length(embedding::real[], 1) = ${sql.lit(dimSize)})`.execute(
        trx,
      );
    });

    const vectorExtension = await this.getVectorExtension();
    await this.db.transaction().execute(async (trx) => {
      await sql`drop index if exists clip_index`.execute(trx);
      await trx.schema
        .alterTable('smart_search')
        .alterColumn('embedding', (col) => col.setDataType(sql.raw(`vector(${dimSize})`)))
        .execute();
      await sql
        .raw(vectorIndexQuery({ vectorExtension, table: 'smart_search', indexName: VectorIndex.Clip }))
        .execute(trx);
      await trx.schema.alterTable('smart_search').dropConstraint('dim_size_constraint').ifExists().execute();
    });
    probes[VectorIndex.Clip] = 1;

    await sql`vacuum analyze ${sql.table('smart_search')}`.execute(this.db);
  }

  async deleteAllSearchEmbeddings(): Promise<void> {
    await sql`truncate ${sql.table('smart_search')}`.execute(this.db);
  }

  private targetListCount(count: number) {
    if (count < 128_000) {
      return 1;
    }
    // eslint-disable-next-line unicorn/prefer-minimal-ternary
    return count < 2_048_000 ? 1 << (32 - Math.clz32(count / 1000)) : 1 << (33 - Math.clz32(Math.sqrt(count)));
  }

  private targetProbeCount(lists: number) {
    return Math.ceil(lists / 8);
  }

  private async getRowCount(table: keyof DB): Promise<number> {
    const { count } = await this.db
      .selectFrom(this.db.dynamic.table(table).as('t'))
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow();
    return count;
  }

  async runMigrations(): Promise<void> {
    this.logger.log('Running migrations');

    await this.normalizeForkLedger();

    let { error, results } = await this.createMigrator().migrateToLatest();

    // Rolling-upgrade race: an old (1061114a0) instance can commit the backdated bridge
    // row AFTER our normalization ran but before our migrator acquired its lock, making
    // the migrator fail on a row that is missing from the current manifest. The ledger
    // state itself is repairable, so re-normalize and retry once.
    if (error instanceof Error && error.message.includes('1779580000001-RetireWorkflowLockSteps')) {
      this.logger.warn(
        '[fork upgrade] Migration failed on the backdated bridge row (racing older instance?); re-normalizing the ledger and retrying.',
      );
      await this.normalizeForkLedger();
      ({ error, results } = await this.createMigrator().migrateToLatest());
    }

    for (const result of results ?? []) {
      if (result.status === 'Success') {
        this.logger.log(`Migration "${result.migrationName}" succeeded`);
      } else if (result.status === 'Error') {
        this.logger.warn(`Migration "${result.migrationName}" failed`);
      }
    }

    if (error) {
      this.logger.error(`Migrations failed: ${error}`);
      throw error;
    }

    this.logger.log('Finished running migrations');
  }

  async migrateFilePaths(sourceFolder: string, targetFolder: string): Promise<void> {
    // remove trailing slashes
    if (sourceFolder.endsWith('/')) {
      sourceFolder = sourceFolder.slice(0, -1);
    }

    if (targetFolder.endsWith('/')) {
      targetFolder = targetFolder.slice(0, -1);
    }

    // escaping regex special characters with a backslash
    const sourceRegex = '^' + sourceFolder.replaceAll(/[-[\]{}()*+?.,\\^$|#\s]/g, String.raw`\$&`);
    const source = sql.raw(`'${sourceRegex}'`);
    const target = sql.lit(targetFolder);

    await this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable('asset')
        .set((eb) => ({
          originalPath: eb.fn('REGEXP_REPLACE', ['originalPath', source, target]),
        }))
        .execute();

      await tx
        .updateTable('asset_file')
        .set((eb) => ({ path: eb.fn('REGEXP_REPLACE', ['path', source, target]) }))
        .execute();

      await tx
        .updateTable('person')
        .set((eb) => ({ thumbnailPath: eb.fn('REGEXP_REPLACE', ['thumbnailPath', source, target]) }))
        .execute();

      await tx
        .updateTable('user')
        .set((eb) => ({ profileImagePath: eb.fn('REGEXP_REPLACE', ['profileImagePath', source, target]) }))
        .execute();
    });
  }

  async withLock<R>(lock: DatabaseLock, callback: () => Promise<R>): Promise<R> {
    let res;
    await this.asyncLock.acquire(DatabaseLock[lock], async () => {
      await this.db.connection().execute(async (connection) => {
        try {
          await this.acquireLock(lock, connection);
          res = await callback();
        } finally {
          await this.releaseLock(lock, connection);
        }
      });
    });

    return res as R;
  }

  tryLock(lock: DatabaseLock): Promise<boolean> {
    return this.db.connection().execute(async (connection) => this.acquireTryLock(lock, connection));
  }

  isBusy(lock: DatabaseLock): boolean {
    return this.asyncLock.isBusy(DatabaseLock[lock]);
  }

  async wait(lock: DatabaseLock): Promise<void> {
    await this.asyncLock.acquire(DatabaseLock[lock], () => {});
  }

  private async acquireLock(lock: DatabaseLock, connection: Kysely<DB>): Promise<void> {
    await sql`SELECT pg_advisory_lock(${lock})`.execute(connection);
  }

  private async acquireTryLock(lock: DatabaseLock, connection: Kysely<DB>): Promise<boolean> {
    const { rows } = await sql<{
      pg_try_advisory_lock: boolean;
    }>`SELECT pg_try_advisory_lock(${lock})`.execute(connection);
    return rows[0].pg_try_advisory_lock;
  }

  private async releaseLock(lock: DatabaseLock, connection: Kysely<DB>): Promise<void> {
    await sql`SELECT pg_advisory_unlock(${lock})`.execute(connection);
  }

  async revertLastMigration(): Promise<string | undefined> {
    this.logger.debug('Reverting last migration');

    const migrator = this.createMigrator();
    const { error, results } = await migrator.migrateDown();

    for (const result of results ?? []) {
      if (result.status === 'Success') {
        this.logger.log(`Reverted migration "${result.migrationName}"`);
      } else if (result.status === 'Error') {
        this.logger.warn(`Failed to revert migration "${result.migrationName}"`);
      }
    }

    if (error) {
      this.logger.error(`Failed to revert migrations: ${error}`);
      throw error;
    }

    const reverted = results?.find((result) => result.direction === 'Down' && result.status === 'Success');
    if (!reverted) {
      this.logger.debug('No migrations to revert');
      return undefined;
    }

    this.logger.debug('Finished reverting migration');
    return reverted.migrationName;
  }

  /**
   * Fork ledger repair: interim integration-3.x commit 1061114a0 shipped the workflow
   * bridge migration under the backdated name 1779580000001-RetireWorkflowLockSteps; it
   * was later renamed to 1784900000000 (it must only precede plugin sync, and sorting
   * early broke already-migrated databases). A ledger that executed the old name would
   * otherwise fail startup with "previously executed migration ... is missing". Renaming
   * the row alone is not enough - kysely also validates execution order - so the row
   * adopts its filename-order predecessor's timestamp VERBATIM: no timestamp arithmetic
   * or formatting (to_char renders in the session timezone, which mislabels the instant
   * outside UTC), and no max()+interval (which would leapfrog migrations added later).
   * Kysely breaks equal timestamps by migration name, which places the bridge exactly
   * where its filename sorts. No-op unless the old row exists (fresh databases have no
   * ledger yet).
   */
  private async normalizeForkLedger(): Promise<void> {
    const tableExists = await sql<{ exists: boolean }>`
      SELECT to_regclass('kysely_migrations') IS NOT NULL AS exists
    `.execute(this.db);
    if (!tableExists.rows[0]?.exists) {
      return;
    }

    // Interim integration-3.x ledgers executed the fork migrations under names that were
    // later renumbered (the feature migrations moved after upstream v3.1.0's max so that
    // STOCK v3.x databases can adopt the fork in ordered mode; the workflow bridge was
    // additionally shipped once under a backdated name). Executed rows are renamed to the
    // current names in filename order, each adopting its immediate filename-order
    // predecessor's timestamp VERBATIM - no arithmetic or formatting (timezone-safe) - so
    // kysely's name tiebreak reproduces filename order exactly. Each rename requires its
    // anchor to be executed (possibly by an earlier iteration of this chain) and its
    // target name to be free.
    const renames: Array<{ oldName: string; newName: string; anchor: string }> = [
      {
        oldName: '1779580000001-RetireWorkflowLockSteps',
        newName: '1784900000000-RetireWorkflowLockSteps',
        anchor: '1784836013770-MinFacePreferenceMigration',
      },
      {
        oldName: '1779487447243-AddAlbumSmartKind',
        newName: '1784910000001-AddAlbumSmartKind',
        anchor: '1784900000000-RetireWorkflowLockSteps',
      },
      {
        oldName: '1779549231508-AddAlbumSmartAlbumCache',
        newName: '1784910000002-AddAlbumSmartAlbumCache',
        anchor: '1784910000001-AddAlbumSmartKind',
      },
      {
        oldName: '1779574778179-AddAlbumContainers',
        newName: '1784910000003-AddAlbumContainers',
        anchor: '1784910000002-AddAlbumSmartAlbumCache',
      },
      {
        oldName: '1779580000000-AddLockedContent',
        newName: '1784910000004-AddLockedContent',
        anchor: '1784910000003-AddAlbumContainers',
      },
    ];

    for (const { oldName, newName, anchor } of renames) {
      const renamed = await sql`
        UPDATE kysely_migrations
        SET name = ${newName},
            timestamp = (SELECT timestamp FROM kysely_migrations WHERE name = ${anchor})
        WHERE name = ${oldName}
          AND EXISTS (SELECT 1 FROM kysely_migrations WHERE name = ${anchor})
          AND NOT EXISTS (SELECT 1 FROM kysely_migrations WHERE name = ${newName})
      `.execute(this.db);
      if (renamed.numAffectedRows && renamed.numAffectedRows > 0n) {
        this.logger.warn(
          `[fork upgrade] Normalized migration ledger: renamed ${oldName} to ${newName} and reordered it after ${anchor}.`,
        );
      }
    }

    // Abnormal case (reverted/partial ledger, anchor predecessor pending): a renamed row
    // would sort after pending migrations and kysely would reject the ledger. The bridge
    // is idempotent, so its old entry is dropped and it reruns in filename order. The
    // feature migrations are NOT rerunnable (CREATE TABLE) - if their old rows remain
    // here, the ledger is a crashed-mid-upgrade artifact that needs a backup restore, and
    // the migrator's own "missing migration" error will say which row is the problem.
    const dropped = await sql`
      DELETE FROM kysely_migrations
      WHERE name = '1779580000001-RetireWorkflowLockSteps'
    `.execute(this.db);
    if (dropped.numAffectedRows && dropped.numAffectedRows > 0n) {
      this.logger.warn(
        '[fork upgrade] Normalized migration ledger: dropped the backdated 1779580000001-RetireWorkflowLockSteps entry (its predecessor is pending); the bridge will rerun in order.',
      );
    }
  }

  private createMigrator(): Migrator {
    return new Migrator({
      db: this.db,
      migrationLockTableName: 'kysely_migrations_lock',
      allowUnorderedMigrations: this.configRepository.isDev(),
      migrationTableName: 'kysely_migrations',
      provider: new FileMigrationProvider({
        fs: { readdir },
        path: { join },
        // eslint-disable-next-line unicorn/prefer-module
        migrationFolder: join(__dirname, '..', 'schema/migrations'),
      }),
    });
  }
}
