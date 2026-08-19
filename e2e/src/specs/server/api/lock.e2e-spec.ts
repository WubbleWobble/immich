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

  it('hides a person whose only face is on a locked-away asset from the people list and search', async () => {
    const faceAsset = await utils.createAsset(owner.accessToken);
    const faceAlbum = await utils.createAlbum(owner.accessToken, {
      albumName: 'Face Lock Album',
      assetIds: [faceAsset.id],
    });
    const person = await utils.createPerson(owner.accessToken, { name: 'Locked Face Person' });
    await utils.createFace({ assetId: faceAsset.id, personId: person.id });

    // Visible while the album is unlocked.
    const before = await request(app).get('/people').set('Authorization', `Bearer ${owner.accessToken}`);
    expect(before.body.people.map(({ id }: { id: string }) => id)).toContain(person.id);

    const lockResponse = await request(app)
      .post(`/albums/${faceAlbum.id}/lock`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(lockResponse.status).toBe(204);

    // Gone from the people list and from person name search for a fresh session.
    const fresh = await login({
      loginCredentialDto: { email: 'lock-owner@immich.cloud', password: 'password-lock-owner' },
    });
    const list = await request(app).get('/people').set('Authorization', `Bearer ${fresh.accessToken}`);
    expect(list.body.people.map(({ id }: { id: string }) => id)).not.toContain(person.id);

    const search = await request(app)
      .get('/search/person?name=Locked Face')
      .set('Authorization', `Bearer ${fresh.accessToken}`);
    expect(search.status).toBe(200);
    expect(search.body.map(({ id }: { id: string }) => id)).not.toContain(person.id);

    // The elevated session with a reveal header sees the person again.
    const revealed = await request(app)
      .get('/people')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .set('x-immich-revealed-albums', faceAlbum.id);
    expect(revealed.body.people.map(({ id }: { id: string }) => id)).toContain(person.id);

    const unlockResponse = await request(app)
      .delete(`/albums/${faceAlbum.id}/lock`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(unlockResponse.status).toBe(204);
  });

  it('hides a tag used only on locked-away assets from the tag list; unused tags stay', async () => {
    const tagAsset = await utils.createAsset(owner.accessToken);
    const tagAlbum = await utils.createAlbum(owner.accessToken, {
      albumName: 'Tag Lock Album',
      assetIds: [tagAsset.id],
    });
    const lockedOnlyTag = await createTag(
      { tagCreateDto: { name: 'locked-only-tag' } },
      { headers: asBearerAuth(owner.accessToken) },
    );
    const unusedTag = await createTag(
      { tagCreateDto: { name: 'unused-tag' } },
      { headers: asBearerAuth(owner.accessToken) },
    );
    // Barrier: metadata extraction can transiently wipe the manual tag; re-tag and poll
    // until the tag is actually searchable (same mechanism as the smart-album test).
    const deadline = Date.now() + 10_000;
    while (true) {
      await tagAssets(
        { id: lockedOnlyTag.id, bulkIdsDto: { ids: [tagAsset.id] } },
        { headers: asBearerAuth(owner.accessToken) },
      );
      const { body } = await request(app)
        .post('/search/metadata')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ tagIds: [lockedOnlyTag.id] });
      if (body.assets.items.some(({ id }: { id: string }) => id === tagAsset.id)) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error('Tagged asset never became searchable');
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const lockResponse = await request(app)
      .post(`/albums/${tagAlbum.id}/lock`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(lockResponse.status).toBe(204);

    // The hidden-only tag vanishes for a fresh session; the unused tag stays.
    const fresh = await login({
      loginCredentialDto: { email: 'lock-owner@immich.cloud', password: 'password-lock-owner' },
    });
    const tags = await request(app).get('/tags').set('Authorization', `Bearer ${fresh.accessToken}`);
    expect(tags.status).toBe(200);
    const tagIds = tags.body.map(({ id }: { id: string }) => id);
    expect(tagIds).not.toContain(lockedOnlyTag.id);
    expect(tagIds).toContain(unusedTag.id);

    // The elevated session with a reveal header sees it again.
    const revealed = await request(app)
      .get('/tags')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .set('x-immich-revealed-albums', tagAlbum.id);
    expect(revealed.body.map(({ id }: { id: string }) => id)).toContain(lockedOnlyTag.id);

    const unlockResponse = await request(app)
      .delete(`/albums/${tagAlbum.id}/lock`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(unlockResponse.status).toBe(204);
  });

  it("locking a cascade-shared folder hides the sharee's own asset filed in its album", async () => {
    // Owner shares a FOLDER (not the album) with the sharee as editor; the sharee's only
    // path to the album is the folder cascade. The sharee files their own asset there and
    // locks the folder - the asset's sole sharee-visible container is then hidden, so the
    // asset must hide too (it must NOT read as zero-container).
    const folder = await createAlbumContainer(
      { createAlbumContainerDto: { name: 'Cascade Lock Folder' } },
      { headers: asBearerAuth(owner.accessToken) },
    );
    const cascadeAlbum = await utils.createAlbum(owner.accessToken, {
      albumName: 'Cascade Lock Album',
      containerId: folder.id,
    });
    const sharee = await login({
      loginCredentialDto: { email: 'lock-sharee@immich.cloud', password: 'password-lock-sharee' },
    });
    const shareResponse = await request(app)
      .post(`/album-containers/${folder.id}/users`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ userId: sharee.userId, role: 'editor' });
    expect([200, 201, 204]).toContain(shareResponse.status);

    const shareeAsset = await utils.createAsset(sharee.accessToken);
    const add = await request(app)
      .put(`/albums/${cascadeAlbum.id}/assets`)
      .set('Authorization', `Bearer ${sharee.accessToken}`)
      .send({ ids: [shareeAsset.id] });
    expect(add.status).toBe(200);

    // Visible while the folder is unlocked.
    let ids = await timelineAssetIds(sharee.accessToken);
    expect(ids).toContain(shareeAsset.id);

    await elevate(sharee.accessToken);
    const lockResponse = await request(app)
      .post(`/album-containers/${folder.id}/lock`)
      .set('Authorization', `Bearer ${sharee.accessToken}`);
    expect(lockResponse.status).toBe(204);

    // A fresh sharee session: the asset is hidden from the timeline and by direct id.
    const fresh = await login({
      loginCredentialDto: { email: 'lock-sharee@immich.cloud', password: 'password-lock-sharee' },
    });
    ids = await timelineAssetIds(fresh.accessToken);
    expect(ids).not.toContain(shareeAsset.id);
    const direct = await request(app)
      .get(`/assets/${shareeAsset.id}`)
      .set('Authorization', `Bearer ${fresh.accessToken}`);
    expect(direct.status).toBe(400);

    const unlockResponse = await request(app)
      .delete(`/album-containers/${folder.id}/lock`)
      .set('Authorization', `Bearer ${sharee.accessToken}`);
    expect(unlockResponse.status).toBe(204);

    ids = await timelineAssetIds(fresh.accessToken);
    expect(ids).toContain(shareeAsset.id);
  });

  it('a smart album in a cascade-shared folder grants asset access and feeds the folder mosaic', async () => {
    // Tag barrier as elsewhere: re-tag and poll until searchable.
    const smartAsset = await utils.createAsset(owner.accessToken);
    const tag = await createTag(
      { tagCreateDto: { name: 'cascade-smart-tag' } },
      { headers: asBearerAuth(owner.accessToken) },
    );
    const deadline = Date.now() + 10_000;
    while (true) {
      await tagAssets({ id: tag.id, bulkIdsDto: { ids: [smartAsset.id] } }, { headers: asBearerAuth(owner.accessToken) });
      const { body } = await request(app)
        .post('/search/metadata')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ tagIds: [tag.id] });
      if (body.assets.items.some(({ id }: { id: string }) => id === smartAsset.id)) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error('Tagged asset never became searchable');
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const folder = await createAlbumContainer(
      { createAlbumContainerDto: { name: 'Smart Cascade Folder' } },
      { headers: asBearerAuth(owner.accessToken) },
    );
    const smartAlbum = await utils.createAlbum(owner.accessToken, {
      albumName: 'Cascade Smart Album',
      kind: AlbumKind.Smart,
      filter: { tagIds: [tag.id] },
      containerId: folder.id,
    });

    const sharee = await login({
      loginCredentialDto: { email: 'lock-sharee@immich.cloud', password: 'password-lock-sharee' },
    });
    const shareResponse = await request(app)
      .post(`/album-containers/${folder.id}/users`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ userId: sharee.userId, role: 'viewer' });
    expect([200, 201, 204]).toContain(shareResponse.status);

    // The sharee's only route to the matched asset is the smart album inside the folder.
    const direct = await request(app)
      .get(`/assets/${smartAsset.id}`)
      .set('Authorization', `Bearer ${sharee.accessToken}`);
    expect(direct.status).toBe(200);

    // Folder mosaic on a COLD cache: no album-list read primes it - the folder endpoint
    // itself must refresh the stale smart-album cache before building the mosaic.
    const folders = await getAllAlbumContainers({ headers: asBearerAuth(owner.accessToken) });
    const mosaic = folders.find(({ id }) => id === folder.id);
    expect(mosaic?.thumbnailAssetIds).toContain(smartAsset.id);
    void smartAlbum;
  });
});
