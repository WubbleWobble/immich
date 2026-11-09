import {
  AlbumResponseDto,
  AlbumUserRole,
  AssetMediaResponseDto,
  LoginResponseDto,
  SharedLinkResponseDto,
  SharedLinkType,
  addUsersToAlbum,
  createAlbum,
  deleteUserAdmin,
  login,
  setupPinCode,
  unlockAuthSession,
} from '@immich/sdk';
import { createUserDto, uuidDto } from 'src/fixtures.js';
import { errorDto } from 'src/responses.js';
import { app, asBearerAuth, baseUrl, shareUrl, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

describe('/shared-links', () => {
  let admin: LoginResponseDto;
  let asset1: AssetMediaResponseDto;
  let asset2: AssetMediaResponseDto;
  let user1: LoginResponseDto;
  let user2: LoginResponseDto;
  let album: AlbumResponseDto;
  let deletedAlbum: AlbumResponseDto;
  let linkWithDeletedAlbum: SharedLinkResponseDto;
  let linkWithPassword: SharedLinkResponseDto;
  let linkWithAlbum: SharedLinkResponseDto;
  let linkWithAssets: SharedLinkResponseDto;
  let linkWithMetadata: SharedLinkResponseDto;
  let linkWithoutMetadata: SharedLinkResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();

    admin = await utils.adminSetup();

    [user1, user2] = await Promise.all([
      utils.userSetup(admin.accessToken, createUserDto.user1),
      utils.userSetup(admin.accessToken, createUserDto.user2),
    ]);

    [asset1, asset2] = await Promise.all([utils.createAsset(user1.accessToken), utils.createAsset(user1.accessToken)]);

    [album, deletedAlbum] = await Promise.all([
      createAlbum({ createAlbumDto: { albumName: 'album' } }, { headers: asBearerAuth(user1.accessToken) }),
      createAlbum({ createAlbumDto: { albumName: 'deleted album' } }, { headers: asBearerAuth(user2.accessToken) }),
    ]);

    [linkWithDeletedAlbum, linkWithAlbum, linkWithAssets, linkWithPassword, linkWithMetadata, linkWithoutMetadata] =
      await Promise.all([
        utils.createSharedLink(user2.accessToken, {
          type: SharedLinkType.Album,
          albumId: deletedAlbum.id,
        }),
        utils.createSharedLink(user1.accessToken, {
          type: SharedLinkType.Album,
          albumId: album.id,
        }),
        utils.createSharedLink(user1.accessToken, {
          type: SharedLinkType.Individual,
          assetIds: [asset1.id],
        }),
        utils.createSharedLink(user1.accessToken, {
          type: SharedLinkType.Album,
          albumId: album.id,
          password: 'foo',
        }),
        utils.createSharedLink(user1.accessToken, {
          type: SharedLinkType.Individual,
          assetIds: [asset1.id],
          showMetadata: true,
          slug: 'metadata-slug',
        }),
        utils.createSharedLink(user1.accessToken, {
          type: SharedLinkType.Individual,
          assetIds: [asset1.id],
          showMetadata: false,
        }),
      ]);

    await deleteUserAdmin({ id: user2.userId, userAdminDeleteDto: {} }, { headers: asBearerAuth(admin.accessToken) });
  });

  describe('GET /share/:key', () => {
    it('should have correct asset count in meta tag for non-empty album', async () => {
      const resp = await request(shareUrl).get(`/${linkWithMetadata.key}`);
      expect(resp.status).toBe(200);
      expect(resp.header['content-type']).toContain('text/html');
      expect(resp.text).toContain(`<meta name="description" content="1 shared photos &amp; videos" />`);
    });

    it('should have correct asset count in meta tag for empty album', async () => {
      const resp = await request(shareUrl).get(`/${linkWithAlbum.key}`);
      expect(resp.status).toBe(200);
      expect(resp.header['content-type']).toContain('text/html');
      expect(resp.text).toContain(`<meta name="description" content="0 shared photos &amp; videos" />`);
    });

    it('should have correct asset count in meta tag for shared asset', async () => {
      const resp = await request(shareUrl).get(`/${linkWithAssets.key}`);
      expect(resp.status).toBe(200);
      expect(resp.header['content-type']).toContain('text/html');
      expect(resp.text).toContain(`<meta name="description" content="1 shared photos &amp; videos" />`);
    });

    it('should have fqdn og:image meta tag for shared asset', async () => {
      const resp = await request(shareUrl).get(`/${linkWithAssets.key}`);
      expect(resp.status).toBe(200);
      expect(resp.header['content-type']).toContain('text/html');
      expect(resp.text).toContain(`<meta property="og:image" content="http://127.0.0.1:2285`);
    });

    it('should fall back to my.immich.app og:image meta tag for shared asset if Host header is not present', async () => {
      const resp = await request(shareUrl).get(`/${linkWithAssets.key}`).set('Host', '');
      expect(resp.status).toBe(200);
      expect(resp.header['content-type']).toContain('text/html');
      expect(resp.text).toContain(`<meta property="og:image" content="https://my.immich.app`);
    });

    it('should return 404 for an invalid shared link', async () => {
      const resp = await request(shareUrl).get(`/invalid-key`);
      expect(resp.status).toBe(404);
      expect(resp.header['content-type']).toContain('text/html');
      expect(resp.text).not.toContain(`og:type`);
      expect(resp.text).not.toContain(`og:title`);
      expect(resp.text).not.toContain(`og:description`);
      expect(resp.text).not.toContain(`og:image`);
    });
  });

  describe('GET /s/:slug', () => {
    it('should work for slug auth', async () => {
      const resp = await request(baseUrl).get(`/s/${linkWithMetadata.slug}`);
      expect(resp.status).toBe(200);
      expect(resp.header['content-type']).toContain('text/html');
      expect(resp.text).toContain(`<meta name="description" content="1 shared photos &amp; videos" />`);
    });
  });

  describe('GET /shared-links', () => {
    it('should get all shared links created by user', async () => {
      const { status, body } = await request(app)
        .get('/shared-links')
        .set('Authorization', `Bearer ${user1.accessToken}`);

      expect(status).toBe(200);
      expect(body).toHaveLength(5);
      expect(body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: linkWithAlbum.id }),
          expect.objectContaining({
            id: linkWithAssets.id,
            assets: expect.arrayContaining([expect.objectContaining({ id: asset1.id })]),
          }),
          expect.objectContaining({ id: linkWithPassword.id }),
          expect.objectContaining({ id: linkWithMetadata.id }),
          expect.objectContaining({ id: linkWithoutMetadata.id }),
        ]),
      );
    });

    it('should filter on albumId', async () => {
      const { status, body } = await request(app)
        .get(`/shared-links?albumId=${album.id}`)
        .set('Authorization', `Bearer ${user1.accessToken}`);

      expect(status).toBe(200);
      expect(body).toHaveLength(2);
      expect(body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: linkWithAlbum.id }),
          expect.objectContaining({ id: linkWithPassword.id }),
        ]),
      );
    });

    it('should find 0 albums', async () => {
      const { status, body } = await request(app)
        .get(`/shared-links?albumId=${uuidDto.notFound}`)
        .set('Authorization', `Bearer ${user1.accessToken}`);

      expect(status).toBe(200);
      expect(body).toHaveLength(0);
    });

    it('should not get shared links created by other users', async () => {
      const { status, body } = await request(app)
        .get('/shared-links')
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body).toEqual([]);
    });
  });

  describe('GET /shared-links/me', () => {
    it('should get data for correct shared link', async () => {
      const { status, body } = await request(app).get('/shared-links/me').query({ key: linkWithAlbum.key });

      expect(status).toBe(200);
      expect(body).toEqual(
        expect.objectContaining({
          album: expect.objectContaining({ id: album.id }),
          userId: user1.userId,
          type: SharedLinkType.Album,
        }),
      );
    });

    it('should return unauthorized for incorrect shared link', async () => {
      const { status, body } = await request(app)
        .get('/shared-links/me')
        .query({ key: linkWithAlbum.key + 'foo' });

      expect(status).toBe(401);
      expect(body).toEqual({ message: 'Invalid share key' });
    });

    it('should return unauthorized if target has been soft deleted', async () => {
      const { status, body } = await request(app).get('/shared-links/me').query({ key: linkWithDeletedAlbum.key });

      expect(status).toBe(401);
      expect(body).toEqual({ message: 'Invalid share key' });
    });

    it('should return unauthorized for password protected link', async () => {
      const { status, body } = await request(app).get('/shared-links/me').query({ key: linkWithPassword.key });

      expect(status).toBe(401);
      expect(body).toEqual({ message: 'Password required' });
    });

    it('should get data for correct password protected link', async () => {
      const response = await request(app)
        .post('/shared-links/login')
        .send({ password: 'foo' })
        .query({ key: linkWithPassword.key });

      expect(response.status).toBe(201);

      const cookies = response.get('Set-Cookie') ?? [];
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toContain('immich_shared_link_token');

      const { status, body } = await request(app)
        .get('/shared-links/me')
        .query({ key: linkWithPassword.key })
        .set('Cookie', cookies);

      expect(status).toBe(200);
      expect(body).toEqual(
        expect.objectContaining({
          album: expect.objectContaining({ id: album.id }),
          userId: user1.userId,
          type: SharedLinkType.Album,
        }),
      );
    });

    it('should return metadata for individual shared link', async () => {
      const { status, body } = await request(app).get('/shared-links/me').query({ key: linkWithMetadata.key });

      expect(status).toBe(200);
      expect(body.assets).toHaveLength(1);
      expect(body.album).not.toBeDefined();
    });

    it('should not return metadata for album shared link without metadata', async () => {
      const { status, body } = await request(app).get('/shared-links/me').query({ key: linkWithoutMetadata.key });

      expect(status).toBe(200);
      expect(body.assets).toHaveLength(1);
      expect(body.album).not.toBeDefined();

      const asset = body.assets[0];
      expect(asset).not.toHaveProperty('exifInfo');
      expect(asset).not.toHaveProperty('fileCreatedAt');
      expect(asset).not.toHaveProperty('originalFilename');
      expect(asset).not.toHaveProperty('originalPath');
    });
  });

  describe('GET /shared-links/:id', () => {
    it('should get shared link by id', async () => {
      const { status, body } = await request(app)
        .get(`/shared-links/${linkWithAlbum.id}`)
        .set('Authorization', `Bearer ${user1.accessToken}`);

      expect(status).toBe(200);
      expect(body).toEqual(
        expect.objectContaining({
          album: expect.objectContaining({ id: album.id }),
          userId: user1.userId,
          type: SharedLinkType.Album,
        }),
      );
    });

    it('should not get shared link by id if user has not created the link or it does not exist', async () => {
      const { status, body } = await request(app)
        .get(`/shared-links/${linkWithAlbum.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(400);
      expect(body).toEqual(expect.objectContaining({ message: 'Shared link not found' }));
    });
  });

  describe('POST /shared-links', () => {
    it('should require a valid asset id', async () => {
      const { status, body } = await request(app)
        .post('/shared-links')
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ type: SharedLinkType.Individual, assetIds: [uuidDto.notFound] });

      expect(status).toBe(400);
      expect(body).toEqual(expect.objectContaining({ message: 'Not found or no asset.share access' }));
    });

    it('should create a shared link', async () => {
      const { status, body } = await request(app)
        .post('/shared-links')
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ type: SharedLinkType.Album, albumId: album.id });

      expect(status).toBe(201);
      expect(body).toEqual(
        expect.objectContaining({
          type: SharedLinkType.Album,
          userId: user1.userId,
        }),
      );
    });

    it('should create an album shared link when the client sends an empty assetIds array', async () => {
      const { status, body } = await request(app)
        .post('/shared-links')
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ type: SharedLinkType.Album, albumId: album.id, assetIds: [] });

      expect(status).toBe(201);
      expect(body).toEqual(expect.objectContaining({ type: SharedLinkType.Album, userId: user1.userId }));
    });
  });

  describe('PATCH /shared-links/:id', () => {
    it('should fail if invalid link', async () => {
      const { status, body } = await request(app)
        .patch(`/shared-links/${uuidDto.notFound}`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ description: 'foo' });

      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest());
    });

    it('should update shared link', async () => {
      const { status, body } = await request(app)
        .patch(`/shared-links/${linkWithAlbum.id}`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ description: 'foo' });

      expect(status).toBe(200);
      expect(body).toEqual(
        expect.objectContaining({
          type: SharedLinkType.Album,
          userId: user1.userId,
          description: 'foo',
        }),
      );
    });
  });

  describe('PUT /shared-links/:id/assets', () => {
    it('should not add assets to shared link (album)', async () => {
      const { status, body } = await request(app)
        .put(`/shared-links/${linkWithAlbum.id}/assets`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ assetIds: [asset2.id] });

      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Invalid shared link type'));
    });

    it('should add an assets to a shared link (individual)', async () => {
      const { status, body } = await request(app)
        .put(`/shared-links/${linkWithAssets.id}/assets`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ assetIds: [asset2.id] });

      expect(body).toEqual([{ assetId: asset2.id, success: true }]);
      expect(status).toBe(200);
    });
  });

  describe('DELETE /shared-links/:id/assets', () => {
    it('should not remove assets from a shared link (album)', async () => {
      const { status, body } = await request(app)
        .delete(`/shared-links/${linkWithAlbum.id}/assets`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ assetIds: [asset2.id] });

      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Invalid shared link type'));
    });

    it('should remove assets from a shared link (individual)', async () => {
      const { status, body } = await request(app)
        .delete(`/shared-links/${linkWithAssets.id}/assets`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ assetIds: [asset2.id] });

      expect(body).toEqual([{ assetId: asset2.id, success: true }]);
      expect(status).toBe(200);
    });
  });

  describe('DELETE /shared-links/:id', () => {
    it('should fail if invalid link', async () => {
      const { status, body } = await request(app)
        .delete(`/shared-links/${uuidDto.notFound}`)
        .set('Authorization', `Bearer ${user1.accessToken}`);

      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest());
    });

    it('should delete a shared link', async () => {
      const { status } = await request(app)
        .delete(`/shared-links/${linkWithAlbum.id}`)
        .set('Authorization', `Bearer ${user1.accessToken}`);

      expect(status).toBe(204);
    });
  });
});

// Fork (Task 7A.1, audit finding 1): authenticated link management respects the manager's locks, judged per item by
// its source owner; public visitor access through a key is a separate, deliberate grant and stays unchanged.
describe('/shared-links and locks', () => {
  const PIN = '123456';
  const ALBUM_READ_ERROR = 'Not found or no album.read access';
  // Ruling R32: hidden content fails exactly like missing content on every link-management path
  const LINK_NOT_FOUND = 'Shared link not found';
  const ASSET_SHARE_ERROR = 'Not found or no asset.share access';

  let admin: LoginResponseDto;
  // B, the manager: `plain` is a non-elevated session, `elevated` a PIN-unlocked one
  let plain: LoginResponseDto;
  let elevated: LoginResponseDto;
  // A, a partner sharing their library with B
  let partnerA: LoginResponseDto;
  let visibleAsset: AssetMediaResponseDto;
  let hiddenA: AssetMediaResponseDto;
  let hiddenB: AssetMediaResponseDto;
  let photoX: AssetMediaResponseDto;
  let photoY: AssetMediaResponseDto;
  let albums: Record<'visible' | 'regular' | 'smart' | 'inFolder' | 'underAncestor', AlbumResponseDto>;
  let folderIds: { folder: string; ancestor: string };
  let partnerAlbumX: AlbumResponseDto;
  let links: Record<
    | 'visibleAlbum'
    | 'visibleIndividual'
    | 'regular'
    | 'smart'
    | 'inFolder'
    | 'underAncestor'
    | 'allHidden'
    | 'mixed'
    | 'partnerX'
    | 'partnerXRevoke'
    | 'partnerY',
    SharedLinkResponseDto
  >;
  let hiddenLinks: SharedLinkResponseDto[];

  const as = (session: LoginResponseDto, headers: Record<string, string> = {}) => ({
    Authorization: `Bearer ${session.accessToken}`,
    ...headers,
  });
  const elevate = (session: LoginResponseDto) =>
    unlockAuthSession({ sessionUnlockDto: { pinCode: PIN } }, { headers: asBearerAuth(session.accessToken) });
  const lock = async (session: LoginResponseDto, path: string) => {
    const { status } = await request(app).post(`${path}/lock`).set(as(session));
    expect(status).toBe(204);
  };
  // Fork endpoints/fields (folders, smart albums) are not in the generated SDK yet: raw requests keep this type-safe
  const newFolder = async (session: LoginResponseDto, dto: { name: string; parentId?: string }) => {
    const { status, body } = await request(app).post('/album-containers').set(as(session)).send(dto);
    expect(status).toBe(201);
    return body as { id: string };
  };
  const newAlbum = async (session: LoginResponseDto, dto: Record<string, unknown>) => {
    const { status, body } = await request(app).post('/albums').set(as(session)).send(dto);
    expect(status).toBe(201);
    return body as AlbumResponseDto;
  };
  const listIds = async (session: LoginResponseDto, headers: Record<string, string> = {}) => {
    const { status, body } = await request(app).get('/shared-links').set(as(session, headers));
    expect(status).toBe(200);
    return { ids: (body as SharedLinkResponseDto[]).map(({ id }) => id), raw: JSON.stringify(body) };
  };

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    const managerDto = createUserDto.create('lock-link-manager');
    const partnerDto = createUserDto.create('lock-link-partner');
    plain = await utils.userSetup(admin.accessToken, managerDto);
    partnerA = await utils.userSetup(admin.accessToken, partnerDto);
    elevated = await login({ loginCredentialDto: { email: managerDto.email, password: managerDto.password } });
    for (const session of [elevated, partnerA]) {
      await setupPinCode({ pinCodeSetupDto: { pinCode: PIN } }, { headers: asBearerAuth(session.accessToken) });
      await elevate(session);
    }
    await utils.createPartner(partnerA.accessToken, plain.userId);

    [visibleAsset, hiddenA, hiddenB, photoX, photoY] = await Promise.all([
      utils.createAsset(plain.accessToken),
      utils.createAsset(plain.accessToken),
      utils.createAsset(plain.accessToken, { isFavorite: true }),
      utils.createAsset(partnerA.accessToken),
      utils.createAsset(partnerA.accessToken),
    ]);

    const folder = await newFolder(plain, { name: 'Locked folder' });
    const ancestor = await newFolder(plain, { name: 'Locked ancestor' });
    const child = await newFolder(plain, { name: 'Child', parentId: ancestor.id });
    folderIds = { folder: folder.id, ancestor: ancestor.id };
    albums = {
      visible: await utils.createAlbum(plain.accessToken, { albumName: 'Visible', assetIds: [visibleAsset.id] }),
      regular: await utils.createAlbum(plain.accessToken, { albumName: 'Regular', assetIds: [hiddenA.id] }),
      smart: await newAlbum(plain, { albumName: 'Smart', kind: 'smart', filter: { isFavorite: true } }),
      inFolder: await newAlbum(plain, { albumName: 'In folder', containerId: folder.id }),
      underAncestor: await newAlbum(plain, { albumName: 'Under ancestor', containerId: child.id }),
    };
    partnerAlbumX = await utils.createAlbum(partnerA.accessToken, { albumName: 'A private', assetIds: [photoX.id] });
    // Y is also in an album A shares with B: B's legitimate grant to Y survives A's lock on it (spec §4)
    const partnerAlbumY = await utils.createAlbum(partnerA.accessToken, {
      albumName: 'A shared',
      assetIds: [photoY.id],
    });
    await addUsersToAlbum(
      { id: partnerAlbumY.id, addUsersDto: { albumUsers: [{ userId: plain.userId, role: AlbumUserRole.Viewer }] } },
      { headers: asBearerAuth(partnerA.accessToken) },
    );

    // every link is minted while its content is still visible
    const individual = (assetIds: string[]) =>
      utils.createSharedLink(plain.accessToken, { type: SharedLinkType.Individual, assetIds, allowDownload: false });
    const album = (albumId: string) =>
      utils.createSharedLink(plain.accessToken, { type: SharedLinkType.Album, albumId, allowDownload: false });
    links = {
      visibleAlbum: await album(albums.visible.id),
      visibleIndividual: await individual([visibleAsset.id]),
      regular: await album(albums.regular.id),
      smart: await album(albums.smart.id),
      inFolder: await album(albums.inFolder.id),
      underAncestor: await album(albums.underAncestor.id),
      allHidden: await individual([hiddenA.id, hiddenB.id]),
      mixed: await individual([visibleAsset.id, hiddenA.id]),
      partnerX: await individual([photoX.id]),
      partnerXRevoke: await individual([photoX.id]),
      partnerY: await individual([photoY.id]),
    };
    hiddenLinks = [links.regular, links.smart, links.inFolder, links.underAncestor, links.allHidden, links.mixed];

    await lock(elevated, `/albums/${albums.regular.id}`);
    await lock(elevated, `/albums/${albums.smart.id}`);
    await lock(elevated, `/album-containers/${folder.id}`);
    await lock(elevated, `/album-containers/${ancestor.id}`);
    await lock(partnerA, `/albums/${partnerAlbumX.id}`);
    await lock(partnerA, `/albums/${partnerAlbumY.id}`);
  });

  it('non-elevated getAll omits hidden links and never returns their keys', async () => {
    const { ids, raw } = await listIds(plain);
    expect(new Set(ids)).toEqual(new Set([links.visibleAlbum.id, links.visibleIndividual.id, links.partnerY.id]));
    for (const link of [...hiddenLinks, links.partnerX]) {
      expect(raw).not.toContain(link.key);
    }
    const { body } = await request(app).get(`/shared-links?albumId=${albums.regular.id}`).set(as(plain));
    expect(body).toEqual([]);
  });

  it('non-elevated cannot get, edit (password/expiry/allowDownload/showExif) or delete a hidden link', async () => {
    for (const link of hiddenLinks) {
      const get = await request(app).get(`/shared-links/${link.id}`).set(as(plain));
      expect(get.status).toBe(400);
      expect(get.body).toEqual(errorDto.badRequest(LINK_NOT_FOUND));
      for (const edit of [
        { password: 'secret' },
        { expiresAt: '2099-01-01T00:00:00.000Z' },
        { allowDownload: true },
        { showMetadata: false },
      ]) {
        const patch = await request(app).patch(`/shared-links/${link.id}`).set(as(plain)).send(edit);
        expect(patch.status).toBe(400);
        expect(patch.body).toEqual(errorDto.badRequest(LINK_NOT_FOUND));
      }
      const del = await request(app).delete(`/shared-links/${link.id}`).set(as(plain));
      expect(del.status).toBe(400);
      expect(del.body).toEqual(errorDto.badRequest(LINK_NOT_FOUND));
    }
  });

  it('non-elevated cannot mint an album or individual link to hidden content, or addAssets hidden assets', async () => {
    for (const album of [albums.regular, albums.smart, albums.inFolder, albums.underAncestor]) {
      const { status, body } = await request(app)
        .post('/shared-links')
        .set(as(plain))
        .send({ type: SharedLinkType.Album, albumId: album.id });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest(ALBUM_READ_ERROR));
    }
    for (const assetIds of [[hiddenA.id, hiddenB.id], [visibleAsset.id, hiddenA.id], [photoX.id]]) {
      const { status, body } = await request(app)
        .post('/shared-links')
        .set(as(plain))
        .send({ type: SharedLinkType.Individual, assetIds });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest(ASSET_SHARE_ERROR));
    }
    // a hidden asset is reported exactly like a missing one, and not added
    const { status, body } = await request(app)
      .put(`/shared-links/${links.visibleIndividual.id}/assets`)
      .set(as(plain))
      .send({ assetIds: [hiddenA.id] });
    expect(status).toBe(200);
    expect(body).toEqual([{ assetId: hiddenA.id, success: false, error: 'no_permission' }]);
  });

  it("elevated direct-by-id management is allowed when only the manager's own locks hide the content", async () => {
    for (const link of hiddenLinks) {
      const get = await request(app).get(`/shared-links/${link.id}`).set(as(elevated));
      expect(get.status).toBe(200);
      expect(get.body).toEqual(expect.objectContaining({ id: link.id, key: link.key }));
      const patch = await request(app)
        .patch(`/shared-links/${link.id}`)
        .set(as(elevated))
        .send({ expiresAt: '2099-01-01T00:00:00.000Z' });
      expect(patch.status).toBe(200);
    }
    const add = await request(app)
      .put(`/shared-links/${links.mixed.id}/assets`)
      .set(as(elevated))
      .send({ assetIds: [hiddenB.id] });
    expect(add.status).toBe(200);
    expect(add.body).toEqual([{ assetId: hiddenB.id, success: true }]);
    const mint = await request(app)
      .post('/shared-links')
      .set(as(elevated))
      .send({ type: SharedLinkType.Album, albumId: albums.regular.id });
    expect(mint.status).toBe(201);
    const remove = await request(app).delete(`/shared-links/${mint.body.id}`).set(as(elevated));
    expect(remove.status).toBe(204);
  });

  it("elevated manager cannot retrieve or reactivate a link exposing a partner's later-locked photo", async () => {
    const revealing = { 'x-immich-revealed-albums': partnerAlbumX.id };
    const { ids, raw } = await listIds(elevated, revealing);
    expect(ids).not.toContain(links.partnerX.id);
    expect(raw).not.toContain(links.partnerX.key);

    const get = await request(app).get(`/shared-links/${links.partnerX.id}`).set(as(elevated));
    expect(get.status).toBe(400);
    expect(get.body).toEqual(errorDto.badRequest(LINK_NOT_FOUND));
    for (const edit of [{ expiresAt: '2099-01-01T00:00:00.000Z' }, { password: 'secret' }, { allowDownload: true }]) {
      const patch = await request(app).patch(`/shared-links/${links.partnerX.id}`).set(as(elevated)).send(edit);
      expect(patch.status).toBe(400);
      expect(patch.body).toEqual(errorDto.badRequest(LINK_NOT_FOUND));
    }
    for (const assetIds of [[visibleAsset.id], [photoX.id]]) {
      const add = await request(app)
        .put(`/shared-links/${links.partnerX.id}/assets`)
        .set(as(elevated))
        .send({ assetIds });
      expect(add.status).toBe(400);
      expect(add.body).toEqual(errorDto.badRequest(LINK_NOT_FOUND));
    }
  });

  it('the same link is manageable when B has another legitimate grant to X', async () => {
    for (const session of [plain, elevated]) {
      const { ids } = await listIds(session);
      expect(ids).toContain(links.partnerY.id);
      const get = await request(app).get(`/shared-links/${links.partnerY.id}`).set(as(session));
      expect(get.status).toBe(200);
      expect(get.body).toEqual(expect.objectContaining({ id: links.partnerY.id, key: links.partnerY.key }));
      const patch = await request(app)
        .patch(`/shared-links/${links.partnerY.id}`)
        .set(as(session))
        .send({ allowDownload: true });
      expect(patch.status).toBe(200);
    }
  });

  it('elevated getAll lists a hidden link only when revealed', async () => {
    const unrevealed = await listIds(elevated);
    for (const link of hiddenLinks) {
      expect(unrevealed.ids).not.toContain(link.id);
    }

    const revealAll = {
      'x-immich-revealed-albums': `${albums.regular.id},${albums.smart.id}`,
      'x-immich-revealed-containers': `${folderIds.folder},${folderIds.ancestor}`,
    };
    const revealed = await listIds(elevated, revealAll);
    for (const link of hiddenLinks) {
      expect(revealed.ids).toContain(link.id);
    }
    expect(revealed.ids).not.toContain(links.partnerX.id);

    // the same headers on a non-elevated session reveal nothing
    const ignored = await listIds(plain, revealAll);
    for (const link of hiddenLinks) {
      expect(ignored.ids).not.toContain(link.id);
    }
  });

  it('public visitor access through an existing key is unchanged', async () => {
    for (const link of [links.allHidden, links.partnerX]) {
      const { status, body } = await request(app).get('/shared-links/me').query({ key: link.key });
      expect(status).toBe(200);
      expect(body).toEqual(expect.objectContaining({ id: link.id }));
      expect(body.assets.length).toBeGreaterThan(0);
    }
    const { status } = await request(app).get('/shared-links/me').query({ key: links.regular.key });
    expect(status).toBe(200);
    const asset = await request(app).get(`/assets/${hiddenA.id}`).query({ key: links.allHidden.key });
    expect(asset.status).toBe(200);
  });

  it('a hidden id and a non-existent id produce identical errors on each path', async () => {
    const missing = uuidDto.notFound;
    const pairs: [string, string][] = [
      [links.regular.id, missing],
      [links.partnerX.id, missing],
    ];
    for (const [hiddenId, missingId] of pairs) {
      for (const session of hiddenId === links.regular.id ? [plain] : [plain, elevated]) {
        for (const send of [
          (id: string) => request(app).get(`/shared-links/${id}`).set(as(session)),
          (id: string) => request(app).patch(`/shared-links/${id}`).set(as(session)).send({ allowDownload: true }),
          (id: string) =>
            request(app)
              .put(`/shared-links/${id}/assets`)
              .set(as(session))
              .send({ assetIds: [visibleAsset.id] }),
          (id: string) =>
            request(app)
              .delete(`/shared-links/${id}/assets`)
              .set(as(session))
              .send({ assetIds: [hiddenA.id] }),
        ]) {
          const hidden = await send(hiddenId);
          const absent = await send(missingId);
          expect(hidden.status).toBe(400);
          expect({ status: hidden.status, body: hidden.body }).toEqual({ status: absent.status, body: absent.body });
        }
      }
    }
    const hiddenMint = await request(app)
      .post('/shared-links')
      .set(as(plain))
      .send({ type: SharedLinkType.Individual, assetIds: [hiddenA.id] });
    const absentMint = await request(app)
      .post('/shared-links')
      .set(as(plain))
      .send({ type: SharedLinkType.Individual, assetIds: [missing] });
    expect(hiddenMint.status).toBe(400);
    expect({ status: hiddenMint.status, body: hiddenMint.body }).toEqual({
      status: absentMint.status,
      body: absentMint.body,
    });
  });

  it("revoking a link hidden by the manager's own lock requires elevation", async () => {
    const plainDelete = await request(app).delete(`/shared-links/${links.regular.id}`).set(as(plain));
    expect(plainDelete.status).toBe(400);
    expect(plainDelete.body).toEqual(errorDto.badRequest(LINK_NOT_FOUND));
    const elevatedDelete = await request(app).delete(`/shared-links/${links.regular.id}`).set(as(elevated));
    expect(elevatedDelete.status).toBe(204);
  });

  it("link owner can revoke a link hidden only by a partner's lock, elevated or not", async () => {
    const get = await request(app).get(`/shared-links/${links.partnerX.id}`).set(as(plain));
    expect(get.status).toBe(400);
    const plainDelete = await request(app).delete(`/shared-links/${links.partnerX.id}`).set(as(plain));
    expect(plainDelete.status).toBe(204);
    const gone = await request(app).get('/shared-links/me').query({ key: links.partnerX.key });
    expect(gone.status).toBe(401);
  });

  it("link owner can revoke a link hidden by a former partner's lock", async () => {
    const unpartner = await request(app).delete(`/partners/${plain.userId}`).set(as(partnerA));
    expect(unpartner.status).toBe(204);
    const { ids } = await listIds(plain);
    expect(ids).not.toContain(links.partnerXRevoke.id);
    const plainDelete = await request(app).delete(`/shared-links/${links.partnerXRevoke.id}`).set(as(plain));
    expect(plainDelete.status).toBe(204);
  });
});
