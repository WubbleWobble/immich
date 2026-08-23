# Upgrading a 2.x fork instance to integration-3.x

The fork's four migrations were renumbered on `integration-3.x` so they sort
**after** every upstream v3.1.0 migration (kysely refuses out-of-order pending
migrations in production). A database that already ran the fork's 2.x-era
migrations records them under their **old** names, so it must be told about the
rename **before** the first 3.x server start — otherwise kysely will try to run
the renamed migrations a second time (and fail on existing tables).

Run this once against the immich database while the server is stopped:

```sql
UPDATE migrations SET name = '1787500000001-AddAlbumSmartKind'      WHERE name = '1779487447243-AddAlbumSmartKind';
UPDATE migrations SET name = '1787500000002-AddAlbumSmartAlbumCache' WHERE name = '1779549231508-AddAlbumSmartAlbumCache';
UPDATE migrations SET name = '1787500000003-AddAlbumContainers'      WHERE name = '1779574778179-AddAlbumContainers';
UPDATE migrations SET name = '1787500000004-AddLockedContent'        WHERE name = '1786957000000-AddLockedContent';
```

For example:

```bash
docker exec -i immich_postgres psql -U postgres -d immich <<'SQL'
UPDATE migrations SET name = '1787500000001-AddAlbumSmartKind'      WHERE name = '1779487447243-AddAlbumSmartKind';
UPDATE migrations SET name = '1787500000002-AddAlbumSmartAlbumCache' WHERE name = '1779549231508-AddAlbumSmartAlbumCache';
UPDATE migrations SET name = '1787500000003-AddAlbumContainers'      WHERE name = '1779574778179-AddAlbumContainers';
UPDATE migrations SET name = '1787500000004-AddLockedContent'        WHERE name = '1786957000000-AddLockedContent';
SQL
```

Then start the 3.x server normally; the pending upstream v3.1.0 migrations run
in order, and the four renamed rows are treated as already applied.

Fresh installs need nothing: all migrations (upstream then fork) run in
timestamp order.

Versioning: package versions track upstream (v3.1.0) so mobile-client version
checks keep working; fork identity lives in the docker image tag
(e.g. `v3.1.0-wobble.1`).
