# Fork upgrade: v3.1.0 to v3.3.6

This fork (smart albums, album folders, locked albums and folders) is ported
onto upstream **v3.3.6**. This file covers what changes on upgrade, the
intentional behaviour differences, the limits of the privacy model, and the
deploy and rollback checklist.

## Deployment

| | From | To |
|---|---|---|
| Server image | `ghcr.io/wubblewobble/immich-server:v3.1.0-wobble.2` | `ghcr.io/wubblewobble/immich-server:v3.3.6-wobble.1` |
| `IMMICH_VERSION` | `v3.1.0` | `v3.3.6` |

- Only the **server** image is forked (the web app is embedded in it).
  `immich-machine-learning`, `postgres` and `redis`/`valkey` stay on stock
  images. Pin `IMMICH_VERSION=v3.3.6` so machine-learning matches the server.
- Package versions track upstream so mobile-client version checks keep working;
  fork identity lives in the image tag.
- Optional: upstream v3.3 added `MACHINE_LEARNING_MODEL_REVISION=v2` (newer
  model exports; default `main`). Not required for the upgrade.

## Migrations

The layout is unchanged. Fork migrations keep their names and all sort after
upstream's, so kysely runs them as a plain ordered pass.

Why the ordering matters: production kysely refuses to run a pending migration
that sorts before an already-applied one (`allowUnorderedMigrations` is
dev-only). So every fork migration must be timestamped after upstream's newest
migration, and any new fork migration (for example in the v3.4 merge) must be
timestamped after upstream's newest at that point.

| Migration | Purpose |
|---|---|
| `1784900000000-RetireWorkflowLockSteps` | Disables workflows using the retired per-asset lock steps |
| `1784910000001-AddAlbumSmartKind` | Smart albums: `album.kind` + `filter` |
| `1784910000002-AddAlbumSmartAlbumCache` | Smart albums: list-view cache columns |
| `1784910000003-AddAlbumContainers` | Album folders: container tables + closure |
| `1784910000004-AddLockedContent` | Lock tables; moves any `visibility=locked` assets into per-user "Locked Folder" albums |
| `1784910000005-ForkSchemaDriftFix` | Adds the missing `userId` indexes on `locked_album` and `locked_container`, and the `album.cachedThumbnailAssetId` column comment (found by `schema-check` after the first production upgrade) |
| `1792300000000-AddPersonThumbnailSourceFace` | **New.** Records which face a person thumbnail was cropped from |
| `1792300000001-AddAlbumCacheRevision` | **New.** `cacheRevision` for smart-album list cache freshness |
| `1792300000002-AddAssetVisibilityNotLockedCheck` | **New.** CHECK constraint rejecting `asset.visibility = 'locked'` |

**Expected ledger after upgrading from prod: 110 rows** in `kysely_migrations`
(94 existing + 13 upstream + 3 fork), applied in order. Verified on a restored
copy of prod on 2026-11-09. The ledger also equals the list of files in
`server/src/schema/migrations/`.

### Unsupported: interim-commit databases

The earlier ledger-repair machinery (renaming old rows, inline bridge) has been
**removed**. Databases created from interim `integration-3.x` commits
(`df8a3e579` through `a80dd01a2`) carry migration names this tree no longer
recognises and **cannot boot it**. Such databases exist (development and test
instances) and must be **reset**, not repaired. Production was never on those
commits.

## What happens on first boot

- **Person thumbnails are withheld until regenerated.** The new provenance
  column cannot be filled for existing rows, so no old thumbnail is trusted.
  Startup queues the regeneration. It is stateless and retryable: rows stay
  unverified until done, and any worker restart re-queues the remainder.
- **Expect blank avatars for about 1 minute** (measured; bound 30 s to 3 min)
  for prod's 232 people. Unverified avatars return 404, and the web UI shows an
  image-error glyph instead of initials. Tell users beforehand.
- **107 people have no faces** and stay without avatars. This is harmless.
- **Do not restart during the first-boot geodata import (about 15 s).**
  Interrupting it can produce a transient schema-drift warning on the next
  start (missing `geodata_places` indexes, then re-imported). Harmless but
  confusing.
- Workflows using the retired lock steps are disabled with a logged
  `[fork upgrade]` warning. `assetLock` steps are removed;
  `assetVisibility(visibility=locked)` steps are kept for manual re-pointing.
  Review them and rebuild lock behaviour with add-to-album steps targeting a
  locked album if wanted.

## Intentional API differences (D6 and related)

| Area | Behaviour |
|---|---|
| Search album filter (v1 `albumIds` and v3) naming a smart album | 400 `Smart albums cannot be used as a search album filter` |
| Search album filter naming an album with no access, or a hidden album (non-elevated) | 400 `Not found or no album.read access` |
| v1 statistics, random, large-asset and smart search with `albumIds` | Now require album access and reject hidden albums |
| Shared-link metadata search naming a smart album | 400 |
| Album shared link to a smart album | `allowUpload` defaults to `false`; explicit `true` returns 400 `Smart albums do not accept uploads` |
| Stack create (mobile auto-stack) | May return 400 `Asset stack not found` when the target stack holds a hidden member |
| Per-asset `visibility=locked` | Retired and rejected; enforced by a DB CHECK constraint |

## Privacy model limits

State these plainly to users.

- **Locks are web-only on your own phone.** The owner's own sync streams are
  unfiltered, so the mobile app shows the owner's hidden content. Mobile is
  deferred (spec section 13).
- **Partner sync streams are lock-filtered**, with two residuals:
  - rows already synced to a partner's phone before a lock stay there until
    that device re-syncs;
  - assets withheld while locked are not re-sent after an unlock until a
    re-sync. Cause: lock toggles do not bump `updateId`, so the sync cursor
    does not move.
- **Locking does not revoke shared links already handed out.** To revoke a
  link to your own locked content, elevate your session (PIN) first, then
  delete it. While you are not elevated, such a link is neither listed nor
  deletable, and it keeps working for visitors. Links hidden only by a
  partner's lock can be revoked in any session.
- **Residual lock-state oracle (R37):** an uploader on an upload-enabled shared
  link who already holds the exact file bytes can infer that the owner's matching photo is hidden.

## Deploy checklist

Deploy only inside a window the user has confirmed.

1. Take a **fresh** `pg_dump -Fc` during the window (not the rehearsal
   snapshot). Record `kysely_migrations` and `asset` counts at dump time.
2. **Restore-test it for real** into a disposable database:
   `pg_restore --no-owner --exit-on-error`. Require exit 0 and equal counts.
   `pg_restore --list` only lists the archive and is not a restore test. Drop
   the disposable database afterwards.
3. Back up `/media/immich-media/thumbs` (at least the person-thumbnail
   directory). Regeneration deletes old crops, and a rollback needs them.
4. Tell users in advance (about 1 minute of blank avatars on prod-sized data).
5. In `/home/wobble/web/home-network/immich/compose.env` (prod runs on host
   `docker-lxc`): `IMMICH_VERSION=v3.3.6` and
   `IMMICH_SERVER_IMAGE=ghcr.io/wubblewobble/immich-server:v3.3.6-wobble.1`.
6. `docker compose pull && docker compose up -d`. Leave it alone for the
   geodata import and thumbnail regeneration (see above).
7. Repeat the rehearsal checks:
   - `kysely_migrations` = 110 rows with exact names and order (94 old rows
     unchanged, then 13 upstream, then 3 fork);
   - asset count and person count unchanged;
   - the `asset.visibility` CHECK constraint is present, and 0 assets have
     `visibility = 'locked'`;
   - person thumbnails are regenerating.

## Rollback

**Warning: rolling back loses everything uploaded or changed since the
deploy.** Upstream v3.2 and v3.3 migrations are not reversible in practice, so
the only path is restoring the pre-deploy dump. In order:

1. Stop the stack.
2. Drop and recreate the `immich` database, or restore into a fresh volume.
3. `pg_restore --no-owner --exit-on-error` the deployment dump. Verify
   `kysely_migrations` = 94 and the asset count.
4. Restore the thumbs backup **before** starting v3.1.
5. Set `compose.env` back to `IMMICH_VERSION=v3.1.0` and
   `IMMICH_SERVER_IMAGE=ghcr.io/wubblewobble/immich-server:v3.1.0-wobble.2`.
6. Start the stack.

## Follow-ups (not done)

- The v3.4 merge.
- Owner's-device sync filtering.
- Partner re-stream on unlock.
- Smart-album expansion in search.
- A v3 filter shape for smart albums.
