# Upgrading a 2.x fork instance to integration-3.x

## Why anything is needed at all

Immich records applied migrations in the **`kysely_migrations`** table (see
`server/src/repositories/database.repository.ts`, `migrationTableName`), and in
production kysely **refuses to run a pending migration that sorts before an
already-applied one** (`allowUnorderedMigrations` is dev-only).

A 2.x fork database has applied, in order: upstream migrations up to
`1778614946174-UpdateWorkflowTables`, then the fork's
`1779487447243-AddAlbumSmartKind`, `1779549231508-AddAlbumSmartAlbumCache`,
`1779574778179-AddAlbumContainers`, and `1786957000000-AddLockedContent`.
Upstream v3.1.0 adds migrations numbered `1779806699547`…`1784836013770` — all
of which sort **before** the applied `1786957000000-AddLockedContent` row, so an
unmodified upgrade refuses to migrate.

The fix on `integration-3.x`: the first three fork migrations already sit in the
gap between 2.x-upstream-max (`17786…`) and 3.x-upstream-min (`17798…`) and are
untouched. Only `AddLockedContent` was renumbered, to `1779580000000` — inside
the same gap. With that, every applied row sorts before every pending upstream
migration and the ordered production migrator is satisfied.

## The one-time step for an existing 2.x fork database

The live database still records the old name, so rename its ledger row **before
the first 3.x server start** (server stopped):

```sql
UPDATE kysely_migrations
SET name = '1779580000000-AddLockedContent'
WHERE name = '1786957000000-AddLockedContent';
```

For example:

```bash
docker exec -i immich_postgres psql -U postgres -d immich <<'SQL'
UPDATE kysely_migrations
SET name = '1779580000000-AddLockedContent'
WHERE name = '1786957000000-AddLockedContent';
SQL
```

Then start the 3.x server normally: the pending migrations - the fork's
`1779580000001-RetireWorkflowLockSteps` bridge first, then upstream v3.1.0's
`1779806699547`…`1784836013770` - all sort after every applied row and run in
order.

Fresh installations need nothing: all migrations (upstream and fork,
interleaved by timestamp) run in one ordered pass — `AddLockedContent` only
touches tables that exist from the 2.x era, so running it before the 3.x
upstream migrations is safe.

## Versioning

Package versions track upstream (v3.1.0) so mobile-client version checks keep
working; fork identity lives in the docker image tag (e.g. `v3.1.0-wobble.1`).

## Workflow lock automation

The upstream core plugin offered two ways to set the retired per-asset
`visibility: locked`, which this fork rejects (locked albums replaced it, and
filing into a locked album requires an elevated session that a background
workflow cannot hold): the `assetLock` action (whose `inverse` config was the
unlock), and the `assetVisibility` action's `locked` option. The fork removes
`assetLock` entirely and drops `locked` from `assetVisibility`.

Existing workflows are bridged by the `1779580000001-RetireWorkflowLockSteps`
migration on first 3.x start, BEFORE plugin sync can cascade-delete anything
silently: workflows containing either step form are **disabled**, `assetLock`
steps are removed (deliberately and logged - the plugin method they reference is
about to disappear), and `assetVisibility(visibility=locked)` steps are kept for
manual re-pointing. A `[fork upgrade]` warning in the server log reports the
counts. Review the disabled workflows and rebuild the lock behaviour manually if
wanted (e.g. add-to-album steps targeting an album you lock).
