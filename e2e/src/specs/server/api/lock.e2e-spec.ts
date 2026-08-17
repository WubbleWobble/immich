import {
  AlbumKind,
  AlbumUserRole,
  AssetVisibility,
  AlbumResponseDto,
  createAlbumContainer,
  createTag,
  getAllAlbumContainers,
  getAllAlbums,
  getLocks,
  getTimeBuckets,
  lockAlbum,
  login,
  LoginResponseDto,
  setupPinCode,
  tagAssets,
  unlockAuthSession,
} from '@immich/sdk';
import { errorDto } from 'src/responses';
import { app, asBearerAuth, utils } from 'src/utils';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

const PIN = '123456';

const elevate = async (accessToken: string) => {
  await unlockAuthSession({ sessionUnlockDto: { pinCode: PIN } }, { headers: asBearerAuth(accessToken) });
};

const timelineAssetIds = async (accessToken: string, headers: Record<string, string> = {}) => {
  const buckets = await getTimeBuckets({}, { headers: { ...asBearerAuth(accessToken), ...headers } });
  const ids: string[] = [];
  for (const bucket of buckets) {
    const { body } = await request(app)
      .get(`/timeline/bucket?timeBucket=${encodeURIComponent(bucket.timeBucket)}`)
      .set({ ...asBearerAuth(accessToken), ...headers });
    ids.push(...body.id);
  }
  return ids;
};

describe('/albums/:id/lock', () => {
  let admin: LoginResponseDto;
  let owner: LoginResponseDto;
  let partner: LoginResponseDto;
  let ownerAssetA: { id: string };
  let ownerAssetB: { id: string };
  let lockedAlbum: AlbumResponseDto;
  let rescueAlbum: AlbumResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    owner = await utils.userSetup(admin.accessToken, {
      email: 'lock-owner@immich.cloud',
      name: 'Lock Owner',
      password: 'password-lock-owner',
    });
    partner = await utils.userSetup(admin.accessToken, {
      email: 'lock-partner@immich.cloud',
      name: 'Lock Partner',
      password: 'password-lock-partner',
    });

    // Owner shares their timeline with the partner.
    await utils.createPartner(owner.accessToken, partner.userId);

    // Asset A lives only in the (to-be-locked) album; asset B also lives in a second,
    // unlocked album and must stay visible throughout.
    ownerAssetA = await utils.createAsset(owner.accessToken);
    ownerAssetB = await utils.createAsset(owner.accessToken);
    lockedAlbum = await utils.createAlbum(owner.accessToken, {
      albumName: 'To Lock',
      assetIds: [ownerAssetA.id, ownerAssetB.id],
    });
    rescueAlbum = await utils.createAlbum(owner.accessToken, {
      albumName: 'Stays Visible',
      assetIds: [ownerAssetB.id],
    });

    await setupPinCode({ pinCodeSetupDto: { pinCode: PIN } }, { headers: asBearerAuth(owner.accessToken) });
  });

  it('rejects locking without an elevated session', async () => {
    const { status } = await request(app)
      .post(`/albums/${lockedAlbum.id}/lock`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(status).toBe(401);
  });

  it('rejects enumerating locks without an elevated session', async () => {
    const { status } = await request(app).get('/locks').set('Authorization', `Bearer ${owner.accessToken}`);
    expect(status).toBe(401);
  });

  it('locks an album and reports it in /locks, idempotently', async () => {
    await elevate(owner.accessToken);

    for (let i = 0; i < 2; i++) {
      const { status } = await request(app)
        .post(`/albums/${lockedAlbum.id}/lock`)
        .set('Authorization', `Bearer ${owner.accessToken}`);
      expect(status).toBe(204);
    }

    const locks = await getLocks({ headers: asBearerAuth(owner.accessToken) });
    expect(locks).toEqual({ lockedAlbumIds: [lockedAlbum.id], lockedContainerIds: [] });
  });

  it('rejects locking an inaccessible album', async () => {
    const { status, body } = await request(app)
      .post(`/albums/${lockedAlbum.id}/lock`)
      .set('Authorization', `Bearer ${partner.accessToken}`);
    // The partner has no read access to the album (partner sharing is not album sharing) -
    // and no PIN either, so elevation fails first.
    expect([400, 401]).toContain(status);
    expect(body).toBeDefined();
  });

  it('hides the locked album from the album list, but a reveal header restores it', async () => {
    const withoutReveal = await getAllAlbums({}, { headers: asBearerAuth(owner.accessToken) });
    expect(withoutReveal.map(({ id }) => id)).not.toContain(lockedAlbum.id);
    expect(withoutReveal.map(({ id }) => id)).toContain(rescueAlbum.id);

    const withReveal = await getAllAlbums(
      {},
      { headers: { ...asBearerAuth(owner.accessToken), 'x-immich-revealed-albums': lockedAlbum.id } },
    );
    expect(withReveal.map(({ id }) => id)).toContain(lockedAlbum.id);
  });

  it('hides only the assets whose every album is locked from the timeline', async () => {
    const ids = await timelineAssetIds(owner.accessToken);
    expect(ids).not.toContain(ownerAssetA.id);
    // Asset B is rescued by the unlocked second album.
    expect(ids).toContain(ownerAssetB.id);
  });

  it('restores hidden assets when the locked album is revealed', async () => {
    const ids = await timelineAssetIds(owner.accessToken, { 'x-immich-revealed-albums': lockedAlbum.id });
    expect(ids).toContain(ownerAssetA.id);
    expect(ids).toContain(ownerAssetB.id);
  });

  it('ignores reveal headers on a non-elevated session (key security property)', async () => {
    const freshLogin = await login({
      loginCredentialDto: { email: 'lock-owner@immich.cloud', password: 'password-lock-owner' },
    });
    // Fresh session: not elevated. The reveal header must be ignored outright.
    const albums = await getAllAlbums(
      {},
      { headers: { ...asBearerAuth(freshLogin.accessToken), 'x-immich-revealed-albums': lockedAlbum.id } },
    );
    expect(albums.map(({ id }) => id)).not.toContain(lockedAlbum.id);

    const ids = await timelineAssetIds(freshLogin.accessToken, { 'x-immich-revealed-albums': lockedAlbum.id });
    expect(ids).not.toContain(ownerAssetA.id);
  });

  it('hides locked-by-owner assets from the partner, including by direct id', async () => {
    const ids = await timelineAssetIds(partner.accessToken);
    // Partner timeline is partner-owned assets only; check the shared owner timeline.
    const ownerBuckets = await getTimeBuckets(
      { userId: owner.userId, withPartners: true, visibility: AssetVisibility.Timeline },
      { headers: asBearerAuth(partner.accessToken) },
    );
    void ids;
    const shared: string[] = [];
    for (const bucket of ownerBuckets) {
      const { body } = await request(app)
        .get(
          `/timeline/bucket?timeBucket=${encodeURIComponent(bucket.timeBucket)}&userId=${owner.userId}&withPartners=true&visibility=timeline`,
        )
        .set(asBearerAuth(partner.accessToken));
      shared.push(...body.id);
    }
    expect(shared).not.toContain(ownerAssetA.id);
    expect(shared).toContain(ownerAssetB.id);

    // Direct id access is refused too.
    const { status } = await request(app)
      .get(`/assets/${ownerAssetA.id}`)
      .set('Authorization', `Bearer ${partner.accessToken}`);
    expect(status).toBe(400);
    // ... while the rescued asset stays reachable.
    const rescued = await request(app)
      .get(`/assets/${ownerAssetB.id}`)
      .set('Authorization', `Bearer ${partner.accessToken}`);
    expect(rescued.status).toBe(200);
  });

  it('unlocking restores everything', async () => {
    const { status } = await request(app)
      .delete(`/albums/${lockedAlbum.id}/lock`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(status).toBe(204);

    const albums = await getAllAlbums({}, { headers: asBearerAuth(owner.accessToken) });
    expect(albums.map(({ id }) => id)).toContain(lockedAlbum.id);

    const ids = await timelineAssetIds(owner.accessToken);
    expect(ids).toContain(ownerAssetA.id);
  });

  it('folder locks cascade to contained albums and hide the folder itself', async () => {
    // Fresh asset: ownerAssetA is rescued by the (unlocked again) 'To Lock' album.
    const folderAsset = await utils.createAsset(owner.accessToken);
    const folder = await createAlbumContainer(
      { createAlbumContainerDto: { name: 'Secret Folder' } },
      { headers: asBearerAuth(owner.accessToken) },
    );
    const inner = await utils.createAlbum(owner.accessToken, {
      albumName: 'Inside Secret Folder',
      assetIds: [folderAsset.id],
      containerId: folder.id,
    });

    const lockResponse = await request(app)
      .post(`/album-containers/${folder.id}/lock`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(lockResponse.status).toBe(204);

    const folders = await getAllAlbumContainers({ headers: asBearerAuth(owner.accessToken) });
    expect(folders.map(({ id }) => id)).not.toContain(folder.id);

    const albums = await getAllAlbums({}, { headers: asBearerAuth(owner.accessToken) });
    expect(albums.map(({ id }) => id)).not.toContain(inner.id);

    const ids = await timelineAssetIds(owner.accessToken);
    expect(ids).not.toContain(folderAsset.id);

    // Revealing the folder restores the cascade.
    const revealed = await getAllAlbums(
      {},
      { headers: { ...asBearerAuth(owner.accessToken), 'x-immich-revealed-containers': folder.id } },
    );
    expect(revealed.map(({ id }) => id)).toContain(inner.id);

    const unlockResponse = await request(app)
      .delete(`/album-containers/${folder.id}/lock`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(unlockResponse.status).toBe(204);
  });

  it('locked smart albums hide their exclusive matches; unlocked containers rescue', async () => {
    // Tagged asset matched only by the smart album's filter.
    const smartOnlyAsset = await utils.createAsset(owner.accessToken);
    const tag = await createTag({ tagCreateDto: { name: 'lock-smart-tag' } }, { headers: asBearerAuth(owner.accessToken) });
    // Barrier: metadata extraction can transiently wipe the manual tag (sidecar round-trip
    // restores it); re-tag and poll until the tag is actually searchable.
    const deadline = Date.now() + 10_000;
    while (true) {
      await tagAssets(
        { id: tag.id, bulkIdsDto: { ids: [smartOnlyAsset.id] } },
        { headers: asBearerAuth(owner.accessToken) },
      );
      const { body } = await request(app)
        .post('/search/metadata')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ tagIds: [tag.id] });
      if (body.assets.items.some(({ id }: { id: string }) => id === smartOnlyAsset.id)) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error('Tagged asset never became searchable');
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const smartAlbum = await utils.createAlbum(owner.accessToken, {
      albumName: 'Smart To Lock',
      kind: AlbumKind.Smart,
      filter: { tagIds: [tag.id] },
    });

    const lockResponse = await request(app)
      .post(`/albums/${smartAlbum.id}/lock`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(lockResponse.status).toBe(204);

    // The asset's only container is the locked smart album -> hidden.
    let ids = await timelineAssetIds(owner.accessToken);
    expect(ids).not.toContain(smartOnlyAsset.id);

    // An unlocked regular album rescues it.
    await utils.createAlbum(owner.accessToken, {
      albumName: 'Smart Rescue',
      assetIds: [smartOnlyAsset.id],
    });
    ids = await timelineAssetIds(owner.accessToken);
    expect(ids).toContain(smartOnlyAsset.id);

    const unlockResponse = await request(app)
      .delete(`/albums/${smartAlbum.id}/lock`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(unlockResponse.status).toBe(204);
  });

  it('unalbumed assets are never hidden by the lock mechanism', async () => {
    const freeAsset = await utils.createAsset(owner.accessToken);
    const ids = await timelineAssetIds(owner.accessToken);
    expect(ids).toContain(freeAsset.id);
  });

  it('an album belonging to a stranger cannot rescue an asset from its owner locks', async () => {
    // While everything is unlocked, the partner files the owner's shared asset into their
    // OWN album. That membership is invisible to the owner and must not affect their locks.
    await utils.createAlbum(partner.accessToken, {
      albumName: 'Partner Keeps A Copy',
      assetIds: [ownerAssetA.id],
    });

    const lockResponse = await request(app)
      .post(`/albums/${lockedAlbum.id}/lock`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(lockResponse.status).toBe(204);

    const ids = await timelineAssetIds(owner.accessToken);
    expect(ids).not.toContain(ownerAssetA.id);
  });

  it('hidden content is unreachable by known id outside an elevated session', async () => {
    // lockedAlbum is locked again from the previous test. A fresh (non-elevated) session:
    const fresh = await login({
      loginCredentialDto: { email: 'lock-owner@immich.cloud', password: 'password-lock-owner' },
    });

    const assetResponse = await request(app)
      .get(`/assets/${ownerAssetA.id}`)
      .set('Authorization', `Bearer ${fresh.accessToken}`);
    expect(assetResponse.status).toBe(400);

    const albumResponse = await request(app)
      .get(`/albums/${lockedAlbum.id}`)
      .set('Authorization', `Bearer ${fresh.accessToken}`);
    expect(albumResponse.status).toBe(400);

    const bucketsResponse = await request(app)
      .get(`/timeline/buckets?albumId=${lockedAlbum.id}`)
      .set('Authorization', `Bearer ${fresh.accessToken}`);
    expect(bucketsResponse.status).toBe(400);

    // The rescued asset stays reachable even for the fresh session.
    const rescued = await request(app)
      .get(`/assets/${ownerAssetB.id}`)
      .set('Authorization', `Bearer ${fresh.accessToken}`);
    expect(rescued.status).toBe(200);

    // The original, still-elevated session bypasses all three.
    const elevatedAsset = await request(app)
      .get(`/assets/${ownerAssetA.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(elevatedAsset.status).toBe(200);
    const elevatedAlbum = await request(app)
      .get(`/albums/${lockedAlbum.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(elevatedAlbum.status).toBe(200);
  });

  it('rejects the retired visibility=locked write', async () => {
    const single = await request(app)
      .put(`/assets/${ownerAssetB.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ visibility: 'locked' });
    expect(single.status).toBe(400);

    const bulk = await request(app)
      .put('/assets')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ ids: [ownerAssetB.id], visibility: 'locked' });
    expect(bulk.status).toBe(400);

    // The asset remains untouched and in its albums.
    const info = await request(app)
      .get(`/assets/${ownerAssetB.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(info.status).toBe(200);
    expect(info.body.visibility).toBe('timeline');
  });

  it('rejects uploads with the retired visibility=locked value', async () => {
    const { status } = await request(app)
      .post('/assets')
      .attach('assetData', Buffer.from('not-a-real-image'), 'locked-upload.png')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .field('deviceAssetId', 'locked-upload-1')
      .field('deviceId', 'e2e')
      .field('fileCreatedAt', new Date().toISOString())
      .field('fileModifiedAt', new Date().toISOString())
      .field('visibility', 'locked');
    expect(status).toBe(400);
  });

  it('blocks writes to a hidden album outside an elevated session', async () => {
    // lockedAlbum is still locked; a fresh session cannot mutate it even though the
    // underlying permission checks (ownership) would succeed.
    const fresh = await login({
      loginCredentialDto: { email: 'lock-owner@immich.cloud', password: 'password-lock-owner' },
    });
    const headers = { Authorization: `Bearer ${fresh.accessToken}` };

    const update = await request(app).patch(`/albums/${lockedAlbum.id}`).set(headers).send({ albumName: 'renamed' });
    expect(update.status).toBe(400);

    const deletion = await request(app).delete(`/albums/${lockedAlbum.id}`).set(headers);
    expect(deletion.status).toBe(400);

    const add = await request(app)
      .put(`/albums/${lockedAlbum.id}/assets`)
      .set(headers)
      .send({ ids: [ownerAssetB.id] });
    expect(add.status).toBe(400);

    // ... and activity on the hidden album is unreachable too.
    const activityList = await request(app).get(`/activities?albumId=${lockedAlbum.id}`).set(headers);
    expect(activityList.status).toBe(400);
    const activityCreate = await request(app)
      .post('/activities')
      .set(headers)
      .send({ albumId: lockedAlbum.id, type: 'like' });
    expect(activityCreate.status).toBe(400);

    // The elevated session can still rename it.
    const elevatedUpdate = await request(app)
      .patch(`/albums/${lockedAlbum.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ albumName: 'To Lock' });
    expect(elevatedUpdate.status).toBe(200);
  });

  it('excludes hidden assets from whole-user download archives', async () => {
    const fresh = await login({
      loginCredentialDto: { email: 'lock-owner@immich.cloud', password: 'password-lock-owner' },
    });

    const { status, body } = await request(app)
      .post('/download/info')
      .set('Authorization', `Bearer ${fresh.accessToken}`)
      .send({ userId: owner.userId });
    expect(status).toBe(201);
    const ids = body.archives.flatMap(({ assetIds }: { assetIds: string[] }) => assetIds);
    expect(ids).not.toContain(ownerAssetA.id);
    expect(ids).toContain(ownerAssetB.id);

    // Like the timeline, the elevated session sees hidden content only via reveal headers.
    const elevated = await request(app)
      .post('/download/info')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .set('x-immich-revealed-albums', lockedAlbum.id)
      .send({ userId: owner.userId });
    expect(elevated.status).toBe(201);
    const elevatedIds = elevated.body.archives.flatMap(({ assetIds }: { assetIds: string[] }) => assetIds);
    expect(elevatedIds).toContain(ownerAssetA.id);
  });

  it('hides locked-away assets inside memories', async () => {
    // The elevated owner can build a memory containing the hidden asset.
    const create = await request(app)
      .post('/memories')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        type: 'on_this_day',
        data: { year: 2021 },
        memoryAt: new Date('2021-01-01').toISOString(),
        assetIds: [ownerAssetA.id, ownerAssetB.id],
      });
    expect(create.status).toBe(201);
    const memoryId = create.body.id;
    expect(create.body.assets.map(({ id }: { id: string }) => id)).toContain(ownerAssetA.id);

    // A fresh session sees the memory, but the hidden asset is filtered out of it.
    const fresh = await login({
      loginCredentialDto: { email: 'lock-owner@immich.cloud', password: 'password-lock-owner' },
    });
    const get = await request(app).get(`/memories/${memoryId}`).set('Authorization', `Bearer ${fresh.accessToken}`);
    expect(get.status).toBe(200);
    const freshIds = get.body.assets.map(({ id }: { id: string }) => id);
    expect(freshIds).not.toContain(ownerAssetA.id);
    expect(freshIds).toContain(ownerAssetB.id);

    const search = await request(app).get('/memories').set('Authorization', `Bearer ${fresh.accessToken}`);
    expect(search.status).toBe(200);
    const searchIds = search.body.flatMap(({ assets }: { assets: { id: string }[] }) => assets.map(({ id }) => id));
    expect(searchIds).not.toContain(ownerAssetA.id);
  });

  it("a sharee's own lock on a shared album hides the owner's assets from the sharee", async () => {
    // A dedicated sharee (NOT a partner - partner timeline access would legitimately
    // rescue the asset) gets an album share, then locks it for themselves.
    const sharee = await utils.userSetup(admin.accessToken, {
      email: 'lock-sharee@immich.cloud',
      name: 'Lock Sharee',
      password: 'password-lock-sharee',
    });
    const sharedAsset = await utils.createAsset(owner.accessToken);
    const sharedAlbum = await utils.createAlbum(owner.accessToken, {
      albumName: 'Shared With Sharee',
      assetIds: [sharedAsset.id],
      albumUsers: [{ userId: sharee.userId, role: AlbumUserRole.Editor }],
    });

    // The share grants direct-id access.
    const before = await request(app)
      .get(`/assets/${sharedAsset.id}`)
      .set('Authorization', `Bearer ${sharee.accessToken}`);
    expect(before.status).toBe(200);

    await setupPinCode({ pinCodeSetupDto: { pinCode: PIN } }, { headers: asBearerAuth(sharee.accessToken) });
    await elevate(sharee.accessToken);
    const lockResponse = await request(app)
      .post(`/albums/${sharedAlbum.id}/lock`)
      .set('Authorization', `Bearer ${sharee.accessToken}`);
    expect(lockResponse.status).toBe(204);

    // The still-elevated session bypasses the lock.
    const elevated = await request(app)
      .get(`/assets/${sharedAsset.id}`)
      .set('Authorization', `Bearer ${sharee.accessToken}`);
    expect(elevated.status).toBe(200);

    // A fresh sharee session can reach neither the album nor its assets by known id...
    const fresh = await login({
      loginCredentialDto: { email: 'lock-sharee@immich.cloud', password: 'password-lock-sharee' },
    });
    const hiddenAsset = await request(app)
      .get(`/assets/${sharedAsset.id}`)
      .set('Authorization', `Bearer ${fresh.accessToken}`);
    expect(hiddenAsset.status).toBe(400);
    const albums = await getAllAlbums({}, { headers: asBearerAuth(fresh.accessToken) });
    expect(albums.map(({ id }) => id)).not.toContain(sharedAlbum.id);

    // ... nor quietly leave the hidden album (self-removal is a write on hidden content).
    const leave = await request(app)
      .delete(`/albums/${sharedAlbum.id}/user/me`)
      .set('Authorization', `Bearer ${fresh.accessToken}`);
    expect(leave.status).toBe(400);

    // The owner is entirely unaffected by the sharee's lock.
    const ownerView = await request(app)
      .get(`/assets/${sharedAsset.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(ownerView.status).toBe(200);
  });
});
