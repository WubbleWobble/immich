# Adopting integration-3.x

## Migration layout

Immich records applied migrations in the **`kysely_migrations`** table (see
`server/src/repositories/database.repository.ts`, `migrationTableName`), and in
production kysely **refuses to run a pending migration that sorts before an
already-applied one** (`allowUnorderedMigrations` is dev-only).

The fork's migrations therefore all sort **after** upstream v3.1.0's last
migration (`1784836013770-MinFacePreferenceMigration`):

| Migration | Purpose |
|---|---|
| `1784900000000-RetireWorkflowLockSteps` | Disables/retires workflow steps that set the removed per-asset `visibility: locked` (see below) |
| `1784910000001-AddAlbumSmartKind` | Smart albums: `album.kind` + `filter` |
| `1784910000002-AddAlbumSmartAlbumCache` | Smart albums: list-view cache columns |
| `1784910000003-AddAlbumContainers` | Album folders: container tables + closure |
| `1784910000004-AddLockedContent` | Locked albums/folders: lock tables + data migration of any `visibility=locked` assets into per-user "Locked Folder" albums |

## Upgrade paths — nothing manual in any of them

- **Stock Immich v3.1.0** (e.g. a standard docker-compose deployment on the
  `release` tag): the fork migrations are pending and sort after everything
  applied. Start the fork image; they run in order. Any existing
  `visibility=locked` assets are migrated into per-user locked albums, and any
  workflows using the retired lock actions are disabled with a logged
  `[fork upgrade]` warning (see below).
- **Stock Immich 2.x**: upstream v3.1.0's migrations run first, then the
  fork's. Same ordered pass, nothing manual.
- **Fresh install**: everything runs in one ordered pass.
- **Databases created from earlier `integration-3.x` commits** (fork
  development/testing only): those executed the fork migrations under
  since-renumbered names. Startup normalizes the ledger automatically before
  the migrator runs — executed rows are chain-renamed to the current names,
  each anchored at its immediate filename-order predecessor's timestamp
  verbatim (kysely breaks timestamp ties by name, reproducing filename order;
  copying the stored string avoids any timezone dependency). Pre-bridge
  ledgers (commits `df8a3e579`…`c31655d9b`, which had the old feature rows but
  no bridge migration at all) additionally get the idempotent bridge executed
  inline and recorded, since a pending bridge would otherwise sort before the
  renamed rows. Each repair logs a `[fork upgrade]` line. A rolling-upgrade
  race against an older instance is retried once when the failure names any
  obsolete migration. **Caveat**: startups on those pre-bridge commits ran
  plugin sync with the scrubbed manifest, silently cascade-deleting any legacy
  `assetLock` workflow steps — ledger repair cannot recover those; only a
  database backup can.
- **Hypothetical 2.x-era fork databases**: none were ever deployed. Such a
  ledger (fork rows applied before upstream 3.x's) is not auto-repaired;
  restore from backup or upgrade by hand.
- **Reverted/partial ledgers**: if the anchor predecessor is pending, the
  bridge's old entry is dropped (it is idempotent and reruns in order); old
  feature-migration rows in that state indicate a crashed-mid-upgrade artifact
  — restore from backup.

## Deployment notes

- Package versions track upstream (v3.1.0) so mobile-client version checks
  keep working; fork identity lives in the docker image tag
  (e.g. `immich-server:v3.1.0-wobble.1`).
- Only the **server** image is forked (the web app is embedded in it).
  `immich-machine-learning`, `postgres`, and `redis`/`valkey` stay on their
  stock images — pin `IMMICH_VERSION=v3.1.0` so machine-learning matches the
  server instead of rolling ahead.

## Workflow lock automation

The upstream core plugin offered two ways to set the retired per-asset
`visibility: locked`, which this fork rejects (locked albums replaced it, and
filing into a locked album requires an elevated session that a background
workflow cannot hold): the `assetLock` action (whose `inverse` config was the
unlock), and the `assetVisibility` action's `locked` option. The fork removes
`assetLock` entirely and drops `locked` from `assetVisibility`.

Existing workflows are bridged by `1784900000000-RetireWorkflowLockSteps` on
first fork start, BEFORE plugin sync can cascade-delete anything silently:
workflows containing either step form are **disabled**, `assetLock` steps are
removed (deliberately and logged — the plugin method they reference is about to
disappear), and `assetVisibility(visibility=locked)` steps are kept for manual
re-pointing. A `[fork upgrade]` warning in the server log reports the counts.
Review the disabled workflows and rebuild the lock behaviour manually if wanted
(e.g. add-to-album steps targeting an album you lock).
