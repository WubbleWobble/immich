import {
  AlbumKind,
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
});
