import {
  addAssetsToAlbum,
  addUsersToAlbum,
  addUserToAlbumContainer,
  AlbumKind,
  AlbumResponseDto,
  AlbumUserRole,
  AssetMediaResponseDto,
  AssetOrder,
  createAlbumContainer,
  createTag,
  deleteUserAdmin,
  getAlbumInfo,
  getAllAlbums,
  getAssetInfo,
  getTimeBuckets,
  LoginResponseDto,
  removeUserFromAlbumContainer,
  searchAssets,
  SharedLinkType,
  tagAssets,
  updateAlbumContainer,
  updateAlbumInfo,
} from '@immich/sdk';
import { createUserDto } from 'src/fixtures';
import { errorDto } from 'src/responses';
import { app, asBearerAuth, utils } from 'src/utils';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const user1SharedEditorUser = 'user1SharedEditorUser';
const user1SharedViewerUser = 'user1SharedViewerUser';
const user1SharedLink = 'user1SharedLink';
const user1NotShared = 'user1NotShared';
const user2SharedUser = 'user2SharedUser';
const user2SharedLink = 'user2SharedLink';
const user2NotShared = 'user2NotShared';
const user4DeletedAsset = 'user4DeletedAsset';
const user4Empty = 'user4Empty';

describe('/albums', () => {
  let admin: LoginResponseDto;
  let user1: LoginResponseDto;
  let user1Asset1: AssetMediaResponseDto;
  let user1Asset2: AssetMediaResponseDto;
  let user4Asset1: AssetMediaResponseDto;
  let user1Albums: AlbumResponseDto[];
  let user2: LoginResponseDto;
  let user2Albums: AlbumResponseDto[];
  let deletedAssetAlbum: AlbumResponseDto;
  let user3: LoginResponseDto; // deleted
  let user4: LoginResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();

    admin = await utils.adminSetup();

    [user1, user2, user3, user4] = await Promise.all([
      utils.userSetup(admin.accessToken, createUserDto.user1),
      utils.userSetup(admin.accessToken, createUserDto.user2),
      utils.userSetup(admin.accessToken, createUserDto.user3),
      utils.userSetup(admin.accessToken, createUserDto.user4),
    ]);

    [user1Asset1, user1Asset2, user4Asset1] = await Promise.all([
      utils.createAsset(user1.accessToken, { isFavorite: true }),
      utils.createAsset(user1.accessToken),
      utils.createAsset(user1.accessToken),
    ]);

    [user1Albums, user2Albums, deletedAssetAlbum] = await Promise.all([
      Promise.all([
        utils.createAlbum(user1.accessToken, {
          albumName: user1SharedEditorUser,
          albumUsers: [
            { userId: admin.userId, role: AlbumUserRole.Editor },
            { userId: user2.userId, role: AlbumUserRole.Editor },
          ],
          assetIds: [user1Asset1.id],
        }),
        utils.createAlbum(user1.accessToken, {
          albumName: user1SharedLink,
          assetIds: [user1Asset1.id],
        }),
        utils.createAlbum(user1.accessToken, {
          albumName: user1NotShared,
          assetIds: [user1Asset1.id, user1Asset2.id],
        }),
        utils.createAlbum(user1.accessToken, {
          albumName: user1SharedViewerUser,
          albumUsers: [{ userId: user2.userId, role: AlbumUserRole.Viewer }],
          assetIds: [user1Asset1.id],
        }),
      ]),
      Promise.all([
        utils.createAlbum(user2.accessToken, {
          albumName: user2SharedUser,
          albumUsers: [
            { userId: user1.userId, role: AlbumUserRole.Editor },
            { userId: user3.userId, role: AlbumUserRole.Editor },
          ],
        }),
        utils.createAlbum(user2.accessToken, { albumName: user2SharedLink }),
        utils.createAlbum(user2.accessToken, { albumName: user2NotShared }),
      ]),
      utils.createAlbum(user4.accessToken, { albumName: user4DeletedAsset }),
      utils.createAlbum(user4.accessToken, { albumName: user4Empty }),
      utils.createAlbum(user3.accessToken, {
        albumName: 'Deleted',
        albumUsers: [{ userId: user1.userId, role: AlbumUserRole.Editor }],
      }),
    ]);

    await Promise.all([
      addAssetsToAlbum(
        { id: user2Albums[0].id, bulkIdsDto: { ids: [user1Asset1.id, user1Asset2.id] } },
        { headers: asBearerAuth(user1.accessToken) },
      ),
      addAssetsToAlbum(
        { id: deletedAssetAlbum.id, bulkIdsDto: { ids: [user4Asset1.id] } },
        { headers: asBearerAuth(user4.accessToken) },
      ),
      // add shared link to user1SharedLink album
      utils.createSharedLink(user1.accessToken, {
        type: SharedLinkType.Album,
        albumId: user1Albums[1].id,
      }),
      // add shared link to user2SharedLink album
      utils.createSharedLink(user2.accessToken, {
        type: SharedLinkType.Album,
        albumId: user2Albums[1].id,
      }),
    ]);

    [user2Albums[0]] = await Promise.all([
      getAlbumInfo({ id: user2Albums[0].id }, { headers: asBearerAuth(user2.accessToken) }),
      deleteUserAdmin({ id: user3.userId, userAdminDeleteDto: {} }, { headers: asBearerAuth(admin.accessToken) }),
      utils.deleteAssets(user1.accessToken, [user4Asset1.id]),
    ]);
  });

  describe('GET /albums', () => {
    it("should not show other users' favorites", async () => {
      const { status, body } = await request(app)
        .get(`/albums/${user1Albums[0].id}`)
        .set('Authorization', `Bearer ${user2.accessToken}`);
      expect(status).toEqual(200);
      expect(body).toEqual({
        ...user1Albums[0],
        contributorCounts: [{ userId: user1.userId, assetCount: 1 }],
        lastModifiedAssetTimestamp: expect.any(String),
        startDate: expect.any(String),
        endDate: expect.any(String),
        shared: true,
        albumUsers: expect.any(Array),
      });
    });

    it('should not return shared albums with a deleted owner', async () => {
      const { status, body } = await request(app)
        .get('/albums?isShared=true')
        .set('Authorization', `Bearer ${user1.accessToken}`);

      expect(status).toBe(200);
      expect(body).toHaveLength(4);
      expect(body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            albumName: user1SharedLink,
            albumUsers: expect.arrayContaining([
              { role: AlbumUserRole.Owner, user: expect.objectContaining({ id: user1.userId }) },
            ]),
            shared: true,
          }),
          expect.objectContaining({
            albumName: user1SharedEditorUser,
            albumUsers: expect.arrayContaining([
              { role: AlbumUserRole.Owner, user: expect.objectContaining({ id: user1.userId }) },
            ]),
            shared: true,
          }),
          expect.objectContaining({
            albumName: user1SharedViewerUser,
            albumUsers: expect.arrayContaining([
              { role: AlbumUserRole.Owner, user: expect.objectContaining({ id: user1.userId }) },
            ]),
            shared: true,
          }),
          expect.objectContaining({
            albumName: user2SharedUser,
            albumUsers: expect.arrayContaining([
              { role: AlbumUserRole.Owner, user: expect.objectContaining({ id: user2.userId }) },
            ]),
            shared: true,
          }),
        ]),
      );
    });

    it('should return the album collection including owned and shared', async () => {
      const { status, body } = await request(app).get('/albums').set('Authorization', `Bearer ${user1.accessToken}`);
      expect(status).toBe(200);
      expect(body).toHaveLength(5);
      expect(body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            albumName: user1SharedEditorUser,
            albumUsers: expect.arrayContaining([
              { role: AlbumUserRole.Owner, user: expect.objectContaining({ id: user1.userId }) },
            ]),
            shared: true,
          }),
          expect.objectContaining({
            albumName: user1SharedViewerUser,
            albumUsers: expect.arrayContaining([
              { role: AlbumUserRole.Owner, user: expect.objectContaining({ id: user1.userId }) },
            ]),
            shared: true,
          }),
          expect.objectContaining({
            albumName: user1SharedLink,
            albumUsers: expect.arrayContaining([
              { role: AlbumUserRole.Owner, user: expect.objectContaining({ id: user1.userId }) },
            ]),
            shared: true,
          }),
          expect.objectContaining({
            albumName: user1NotShared,
            albumUsers: expect.arrayContaining([
              { role: AlbumUserRole.Owner, user: expect.objectContaining({ id: user1.userId }) },
            ]),
            shared: false,
          }),
          expect.objectContaining({
            albumName: user2SharedUser,
            albumUsers: expect.arrayContaining([
              { role: AlbumUserRole.Owner, user: expect.objectContaining({ id: user2.userId }) },
            ]),
            shared: true,
          }),
        ]),
      );
    });

    it('should return the album collection filtered by isShared', async () => {
      const { status, body } = await request(app)
        .get('/albums?isShared=true')
        .set('Authorization', `Bearer ${user1.accessToken}`);
      expect(status).toBe(200);
      expect(body).toHaveLength(4);
      expect(body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            albumName: user1SharedEditorUser,
            albumUsers: expect.arrayContaining([
              { role: AlbumUserRole.Owner, user: expect.objectContaining({ id: user1.userId }) },
            ]),
            shared: true,
          }),
          expect.objectContaining({
            albumName: user1SharedViewerUser,
            albumUsers: expect.arrayContaining([
              { role: AlbumUserRole.Owner, user: expect.objectContaining({ id: user1.userId }) },
            ]),
            shared: true,
          }),
          expect.objectContaining({
            albumName: user1SharedLink,
            albumUsers: expect.arrayContaining([
              { role: AlbumUserRole.Owner, user: expect.objectContaining({ id: user1.userId }) },
            ]),
            shared: true,
          }),
          expect.objectContaining({
            albumName: user2SharedUser,
            albumUsers: expect.arrayContaining([
              { role: AlbumUserRole.Owner, user: expect.objectContaining({ id: user2.userId }) },
            ]),
            shared: true,
          }),
        ]),
      );
    });

    it('should return the album collection filtered by NOT isShared', async () => {
      const { status, body } = await request(app)
        .get('/albums?isShared=false')
        .set('Authorization', `Bearer ${user1.accessToken}`);
      expect(status).toBe(200);
      expect(body).toHaveLength(1);
      expect(body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            albumName: user1NotShared,
            albumUsers: expect.arrayContaining([
              { role: AlbumUserRole.Owner, user: expect.objectContaining({ id: user1.userId }) },
            ]),
            shared: false,
          }),
        ]),
      );
    });

    it('should return only owned albums when filtered by isOwned=true', async () => {
      const { status, body } = await request(app)
        .get('/albums?isOwned=true')
        .set('Authorization', `Bearer ${user1.accessToken}`);
      expect(status).toBe(200);
      expect(body).toHaveLength(4);
      expect(body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ albumName: user1SharedEditorUser }),
          expect.objectContaining({ albumName: user1SharedViewerUser }),
          expect.objectContaining({ albumName: user1SharedLink }),
          expect.objectContaining({ albumName: user1NotShared }),
        ]),
      );
    });

    it('should return only shared-with-me albums when filtered by isOwned=false', async () => {
      const { status, body } = await request(app)
        .get('/albums?isOwned=false')
        .set('Authorization', `Bearer ${user1.accessToken}`);
      expect(status).toBe(200);
      expect(body).toHaveLength(1);
      expect(body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            albumName: user2SharedUser,
            albumUsers: expect.arrayContaining([
              { role: AlbumUserRole.Owner, user: expect.objectContaining({ id: user2.userId }) },
            ]),
          }),
        ]),
      );
    });

    it('should return owned shared-out albums when filtered by isOwned=true&ishared=true', async () => {
      const { status, body } = await request(app)
        .get('/albums?isOwned=true&isShared=true')
        .set('Authorization', `Bearer ${user1.accessToken}`);
      expect(status).toBe(200);
      expect(body).toHaveLength(3);
      expect(body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ albumName: user1SharedEditorUser }),
          expect.objectContaining({ albumName: user1SharedViewerUser }),
          expect.objectContaining({ albumName: user1SharedLink }),
        ]),
      );
    });

    it('should return empty list when filtered by isOwned=false&isShared=false', async () => {
      const { status, body } = await request(app)
        .get('/albums?isOwned=false&isShared=false')
        .set('Authorization', `Bearer ${user1.accessToken}`);
      expect(status).toBe(200);
      expect(body).toHaveLength(0);
    });

    it('should return the album collection filtered by assetId', async () => {
      const { status, body } = await request(app)
        .get(`/albums?assetId=${user1Asset2.id}`)
        .set('Authorization', `Bearer ${user1.accessToken}`);
      expect(status).toBe(200);
      expect(body).toHaveLength(2);
    });

    it('should return the album collection filtered by assetId and ignores isShared=true', async () => {
      const { status, body } = await request(app)
        .get(`/albums?isShared=true&assetId=${user1Asset1.id}`)
        .set('Authorization', `Bearer ${user1.accessToken}`);
      expect(status).toBe(200);
      expect(body).toHaveLength(5);
    });

    it('should return the album collection filtered by assetId and ignores isShared=false', async () => {
      const { status, body } = await request(app)
        .get(`/albums?isShared=false&assetId=${user1Asset1.id}`)
        .set('Authorization', `Bearer ${user1.accessToken}`);
      expect(status).toBe(200);
      expect(body).toHaveLength(5);
    });

    it('should return empty albums and albums where all assets are deleted', async () => {
      const { status, body } = await request(app).get('/albums').set('Authorization', `Bearer ${user4.accessToken}`);
      expect(status).toBe(200);
      expect(body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            albumName: user4DeletedAsset,
            albumUsers: expect.arrayContaining([
              { role: AlbumUserRole.Owner, user: expect.objectContaining({ id: user4.userId }) },
            ]),
            shared: false,
          }),
          expect.objectContaining({
            albumName: user4Empty,
            albumUsers: expect.arrayContaining([
              { role: AlbumUserRole.Owner, user: expect.objectContaining({ id: user4.userId }) },
            ]),
            shared: false,
          }),
        ]),
      );
    });
  });

  describe('GET /albums/:id', () => {
    it('should return album info for own album', async () => {
      const { status, body } = await request(app)
        .get(`/albums/${user1Albums[0].id}`)
        .set('Authorization', `Bearer ${user1.accessToken}`);

      expect(status).toBe(200);
      expect(body).toEqual({
        ...user1Albums[0],
        contributorCounts: [{ userId: user1.userId, assetCount: 1 }],
        lastModifiedAssetTimestamp: expect.any(String),
        startDate: expect.any(String),
        endDate: expect.any(String),
        albumUsers: expect.any(Array),
        shared: true,
      });
    });

    it('should return album info for shared album (editor)', async () => {
      const { status, body } = await request(app)
        .get(`/albums/${user2Albums[0].id}`)
        .set('Authorization', `Bearer ${user1.accessToken}`);

      expect(status).toBe(200);
      expect(body).toMatchObject({ id: user2Albums[0].id });
    });

    it('should return album info for shared album (viewer)', async () => {
      const { status, body } = await request(app)
        .get(`/albums/${user1Albums[3].id}`)
        .set('Authorization', `Bearer ${user2.accessToken}`);

      expect(status).toBe(200);
      expect(body).toMatchObject({ id: user1Albums[3].id });
    });

    it('should return album info', async () => {
      const { status, body } = await request(app)
        .get(`/albums/${user1Albums[0].id}`)
        .set('Authorization', `Bearer ${user1.accessToken}`);

      expect(status).toBe(200);
      expect(body).toEqual({
        ...user1Albums[0],
        contributorCounts: [{ userId: user1.userId, assetCount: 1 }],
        assetCount: 1,
        lastModifiedAssetTimestamp: expect.any(String),
        endDate: expect.any(String),
        startDate: expect.any(String),
        albumUsers: expect.any(Array),
        shared: true,
      });
    });

    it('should not count trashed assets', async () => {
      await utils.deleteAssets(user1.accessToken, [user1Asset2.id]);

      const { status, body } = await request(app)
        .get(`/albums/${user2Albums[0].id}`)
        .set('Authorization', `Bearer ${user1.accessToken}`);

      expect(status).toBe(200);
      expect(body).toEqual(
        expect.objectContaining({
          contributorCounts: [{ userId: user1.userId, assetCount: 1 }],
          assetCount: 1,
          lastModifiedAssetTimestamp: expect.any(String),
          endDate: expect.any(String),
          startDate: expect.any(String),
          albumUsers: expect.any(Array),
          shared: true,
        }),
      );
    });
  });

  describe('GET /albums/statistics', () => {
    it('should return total count of albums the user has access to', async () => {
      const { status, body } = await request(app)
        .get('/albums/statistics')
        .set('Authorization', `Bearer ${user1.accessToken}`);

      expect(status).toBe(200);
      expect(body).toEqual({ owned: 4, shared: 4, notShared: 1 });
    });
  });

  describe('POST /albums', () => {
    it('should create an album', async () => {
      const { status, body } = await request(app)
        .post('/albums')
        .send({ albumName: 'New album' })
        .set('Authorization', `Bearer ${user1.accessToken}`);
      expect(status).toBe(201);
      expect(body).toEqual({
        id: expect.any(String),
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        albumName: 'New album',
        description: '',
        albumThumbnailAssetId: null,
        shared: false,
        albumUsers: [{ role: AlbumUserRole.Owner, user: expect.objectContaining({ id: user1.userId }) }],
        hasSharedLink: false,
        assetCount: 0,
        isActivityEnabled: true,
        order: AssetOrder.Desc,
        kind: AlbumKind.Regular,
        filter: null,
        containerId: null,
      });
    });

    it('should reject a smart album with an empty filter', async () => {
      // An empty filter matches the owner's whole timeline - dangerous once shared.
      const { status, body } = await request(app)
        .post('/albums')
        .send({ albumName: 'Empty smart album', kind: AlbumKind.Smart, filter: {} })
        .set('Authorization', `Bearer ${user1.accessToken}`);
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Smart album filter must contain at least one criterion'));
    });

    it('should not be able to share album with owner', async () => {
      const { status, body } = await request(app)
        .post('/albums')
        .send({ albumName: 'New album', albumUsers: [{ role: AlbumUserRole.Editor, userId: user1.userId }] })
        .set('Authorization', `Bearer ${user1.accessToken}`);
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Cannot share album with owner'));
    });
  });

  describe('PUT /albums/:id/assets', () => {
    it('should be able to add own asset to own album', async () => {
      const asset = await utils.createAsset(user1.accessToken);
      const { status, body } = await request(app)
        .put(`/albums/${user1Albums[0].id}/assets`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ ids: [asset.id] });

      expect(status).toBe(200);
      expect(body).toEqual([expect.objectContaining({ id: asset.id, success: true })]);
    });

    it('should be able to add own asset to shared album', async () => {
      const asset = await utils.createAsset(user1.accessToken);
      const { status, body } = await request(app)
        .put(`/albums/${user2Albums[0].id}/assets`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ ids: [asset.id] });

      expect(status).toBe(200);
      expect(body).toEqual([expect.objectContaining({ id: asset.id, success: true })]);
    });

    it('should not be able to add assets to album as a viewer', async () => {
      const asset = await utils.createAsset(user2.accessToken);
      const { status, body } = await request(app)
        .put(`/albums/${user1Albums[3].id}/assets`)
        .set('Authorization', `Bearer ${user2.accessToken}`)
        .send({ ids: [asset.id] });

      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Not found or no albumAsset.create access'));
    });

    it('should add duplicate assets only once', async () => {
      const asset = await utils.createAsset(user1.accessToken);
      const { status, body } = await request(app)
        .put(`/albums/${user1Albums[0].id}/assets`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ ids: [asset.id, asset.id] });

      expect(status).toBe(200);
      expect(body).toEqual([
        expect.objectContaining({ id: asset.id, success: true }),
        expect.objectContaining({ id: asset.id, success: false, error: 'duplicate' }),
      ]);
    });
  });

  describe('PATCH /albums/:id', () => {
    it('should update an album', async () => {
      const album = await utils.createAlbum(user1.accessToken, {
        albumName: 'New album',
      });
      const { status, body } = await request(app)
        .patch(`/albums/${album.id}`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({
          albumName: 'New album name',
          description: 'An album description',
        });
      expect(status).toBe(200);
      expect(body).toEqual({
        ...album,
        updatedAt: expect.any(String),
        albumName: 'New album name',
        description: 'An album description',
      });
    });

    it('should not be able to update as a viewer', async () => {
      const { status, body } = await request(app)
        .patch(`/albums/${user1Albums[3].id}`)
        .set('Authorization', `Bearer ${user2.accessToken}`)
        .send({ albumName: 'New album name' });

      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Not found or no album.update access'));
    });

    it('should be able to update as an editor', async () => {
      const { status, body } = await request(app)
        .patch(`/albums/${user1Albums[0].id}`)
        .set('Authorization', `Bearer ${user2.accessToken}`)
        .send({ albumName: 'New album name' });

      expect(status).toBe(200);
      expect(body).toEqual(
        expect.objectContaining({
          id: user1Albums[0].id,
          albumName: 'New album name',
        }),
      );
    });
  });

  describe('DELETE /albums/:id/assets', () => {
    it('should require authorization', async () => {
      const { status, body } = await request(app)
        .delete(`/albums/${user1Albums[1].id}/assets`)
        .set('Authorization', `Bearer ${user2.accessToken}`)
        .send({ ids: [user1Asset1.id] });

      expect(status).toBe(400);
      expect(body).toEqual(errorDto.noPermission);
    });

    it('should be able to remove foreign asset from owned album', async () => {
      const { status, body } = await request(app)
        .delete(`/albums/${user2Albums[0].id}/assets`)
        .set('Authorization', `Bearer ${user2.accessToken}`)
        .send({ ids: [user1Asset1.id] });

      expect(status).toBe(200);
      expect(body).toEqual([
        expect.objectContaining({
          id: user1Asset1.id,
          success: true,
        }),
      ]);
    });

    it('should not be able to remove foreign asset from foreign album', async () => {
      const { status, body } = await request(app)
        .delete(`/albums/${user1Albums[0].id}/assets`)
        .set('Authorization', `Bearer ${user2.accessToken}`)
        .send({ ids: [user1Asset1.id] });

      expect(status).toBe(200);
      expect(body).toEqual([
        expect.objectContaining({
          id: user1Asset1.id,
          success: false,
          error: 'no_permission',
        }),
      ]);
    });

    it('should be able to remove own asset from own album', async () => {
      const { status, body } = await request(app)
        .delete(`/albums/${user1Albums[0].id}/assets`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ ids: [user1Asset1.id] });

      expect(status).toBe(200);
      expect(body).toEqual([expect.objectContaining({ id: user1Asset1.id, success: true })]);
    });

    it('should be able to remove own asset from shared album', async () => {
      const { status, body } = await request(app)
        .delete(`/albums/${user2Albums[0].id}/assets`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ ids: [user1Asset2.id] });

      expect(status).toBe(200);
      expect(body).toEqual([expect.objectContaining({ id: user1Asset2.id, success: true })]);
    });

    it('should not be able to remove assets from album as a viewer', async () => {
      const { status, body } = await request(app)
        .delete(`/albums/${user1Albums[3].id}/assets`)
        .set('Authorization', `Bearer ${user2.accessToken}`)
        .send({ ids: [user1Asset1.id] });

      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Not found or no albumAsset.delete access'));
    });

    it('should remove duplicate assets only once', async () => {
      const { status, body } = await request(app)
        .delete(`/albums/${user1Albums[1].id}/assets`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ ids: [user1Asset1.id, user1Asset1.id] });

      expect(status).toBe(200);
      expect(body).toEqual([
        expect.objectContaining({ id: user1Asset1.id, success: true }),
        expect.objectContaining({ id: user1Asset1.id, success: false, error: 'not_found' }),
      ]);
    });
  });

  describe('PUT :id/users', () => {
    let album: AlbumResponseDto;

    beforeEach(async () => {
      album = await utils.createAlbum(user1.accessToken, {
        albumName: 'testAlbum',
      });
    });

    it('should be able to add user to own album', async () => {
      const { status, body } = await request(app)
        .put(`/albums/${album.id}/users`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ albumUsers: [{ userId: user2.userId, role: AlbumUserRole.Editor }] });

      expect(status).toBe(200);
      expect(body).toEqual(
        expect.objectContaining({
          albumUsers: expect.arrayContaining([
            expect.objectContaining({
              user: expect.objectContaining({ id: user2.userId }),
            }),
          ]),
        }),
      );
    });

    it('should not be able to share album with owner', async () => {
      const { status, body } = await request(app)
        .put(`/albums/${album.id}/users`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ albumUsers: [{ userId: user1.userId, role: AlbumUserRole.Editor }] });

      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('User already added'));
    });

    it('should not be able to add existing user to shared album', async () => {
      await request(app)
        .put(`/albums/${album.id}/users`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ albumUsers: [{ userId: user2.userId, role: AlbumUserRole.Editor }] });

      const { status, body } = await request(app)
        .put(`/albums/${album.id}/users`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ albumUsers: [{ userId: user2.userId, role: AlbumUserRole.Editor }] });

      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('User already added'));
    });
  });

  describe('PUT :id/user/:userId', () => {
    it('should allow the album owner to change the role of a shared user', async () => {
      const album = await utils.createAlbum(user1.accessToken, {
        albumName: 'testAlbum',
        albumUsers: [{ userId: user2.userId, role: AlbumUserRole.Viewer }],
      });

      expect(album.albumUsers[1].role).toEqual(AlbumUserRole.Viewer);

      const { status } = await request(app)
        .put(`/albums/${album.id}/user/${user2.userId}`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ role: AlbumUserRole.Editor });

      expect(status).toBe(204);

      // Get album to verify the role change
      const { body } = await request(app)
        .get(`/albums/${album.id}`)
        .set('Authorization', `Bearer ${user1.accessToken}`);
      expect(body).toEqual(
        expect.objectContaining({
          albumUsers: [
            expect.objectContaining({ role: AlbumUserRole.Owner }),
            expect.objectContaining({ role: AlbumUserRole.Editor }),
          ],
        }),
      );
    });

    it('should not allow a shared user to change the role of another shared user', async () => {
      const album = await utils.createAlbum(user1.accessToken, {
        albumName: 'testAlbum',
        albumUsers: [{ userId: user2.userId, role: AlbumUserRole.Viewer }],
      });

      expect(album.albumUsers[1].role).toEqual(AlbumUserRole.Viewer);

      const { status, body } = await request(app)
        .put(`/albums/${album.id}/user/${user2.userId}`)
        .set('Authorization', `Bearer ${user2.accessToken}`)
        .send({ role: AlbumUserRole.Editor });

      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Not found or no album.share access'));
    });
  });

  describe('smart album lifecycle with share', () => {
    it('shares a smart album with a viewer, then promotes them to editor', async () => {
      // Two dedicated users so we don't disturb the rest of this suite's shared state.
      const owner = await utils.userSetup(admin.accessToken, {
        email: 'smart-owner@immich.cloud',
        name: 'Smart Owner',
        password: 'password-smart-owner',
      });
      const recipient = await utils.userSetup(admin.accessToken, {
        email: 'smart-recipient@immich.cloud',
        name: 'Smart Recipient',
        password: 'password-smart-recipient',
      });

      // Owner uploads one asset and tags it; the tag becomes the smart-album filter.
      // Metadata extraction REPLACES an asset's tags from EXIF/sidecar data
      // (MetadataService.applyTagList), so a manual tag applied while extraction is still
      // pending gets wiped. Wait for upload processing to finish before tagging - queue
      // polling races the event handler that enqueues the job, so use the websocket signal.
      const ownerWebsocket = await utils.connectWebsocket(owner.accessToken);
      const ownerAsset = await utils.createAsset(owner.accessToken);
      await utils.waitForWebsocketEvent({ event: 'assetUpload', id: ownerAsset.id });
      utils.disconnectWebsocket(ownerWebsocket);
      const tag = await createTag(
        { tagCreateDto: { name: 'smart-album-tag' } },
        { headers: asBearerAuth(owner.accessToken) },
      );
      const tagResults = await tagAssets(
        { id: tag.id, bulkIdsDto: { ids: [ownerAsset.id] } },
        { headers: asBearerAuth(owner.accessToken) },
      );
      expect(tagResults).toEqual([{ id: ownerAsset.id, success: true }]);

      // Barrier: metadata extraction can transiently wipe the manual tag (applyTagList
      // replaces tags from EXIF/sidecar; the sidecar round-trip restores it). Wait until the
      // tag is actually searchable - the same visibility the smart album evaluates.
      const deadline = Date.now() + 10_000;
      while (true) {
        const { assets: searchHits } = await searchAssets(
          { metadataSearchDto: { tagIds: [tag.id] } },
          { headers: asBearerAuth(owner.accessToken) },
        );
        if (searchHits.items.some(({ id }) => id === ownerAsset.id)) {
          break;
        }
        if (Date.now() > deadline) {
          throw new Error('Tagged asset never became searchable');
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      // Owner creates a smart album whose filter matches the tagged asset.
      const smartAlbum = await utils.createAlbum(owner.accessToken, {
        albumName: 'Smart Album Lifecycle',
        kind: AlbumKind.Smart,
        filter: { tagIds: [tag.id] },
      });

      expect(smartAlbum).toEqual(
        expect.objectContaining({
          kind: AlbumKind.Smart,
          filter: expect.objectContaining({ tagIds: [tag.id] }),
        }),
      );

      // Owner-side fetch by id should warm the smart-album cache and report the matching asset.
      const ownerAlbumInfo = await getAlbumInfo({ id: smartAlbum.id }, { headers: asBearerAuth(owner.accessToken) });
      expect(ownerAlbumInfo.kind).toBe(AlbumKind.Smart);
      expect(ownerAlbumInfo.filter).toEqual(expect.objectContaining({ tagIds: [tag.id] }));
      expect(ownerAlbumInfo.assetCount).toBeGreaterThanOrEqual(1);
      expect(ownerAlbumInfo.albumThumbnailAssetId).toBe(ownerAsset.id);

      // Share with the recipient as a Viewer.
      await addUsersToAlbum(
        {
          id: smartAlbum.id,
          addUsersDto: { albumUsers: [{ userId: recipient.userId, role: AlbumUserRole.Viewer }] },
        },
        { headers: asBearerAuth(owner.accessToken) },
      );

      // Recipient (Viewer) sees the smart album in its album list with the smart-album metadata.
      const recipientAlbums = await getAllAlbums({}, { headers: asBearerAuth(recipient.accessToken) });
      const sharedSmartAlbum = recipientAlbums.find((a) => a.id === smartAlbum.id);
      expect(sharedSmartAlbum).toBeDefined();
      expect(sharedSmartAlbum).toEqual(
        expect.objectContaining({
          kind: AlbumKind.Smart,
          assetCount: ownerAlbumInfo.assetCount,
          albumThumbnailAssetId: ownerAsset.id,
        }),
      );

      // Recipient fetching by id sees the filter (smart-album filter is exposed to shared users).
      const recipientAlbumInfo = await getAlbumInfo(
        { id: smartAlbum.id },
        { headers: asBearerAuth(recipient.accessToken) },
      );
      expect(recipientAlbumInfo.filter).toEqual(expect.objectContaining({ tagIds: [tag.id] }));

      // Recipient can pull timeline buckets scoped to the smart album.
      const recipientBuckets = await getTimeBuckets(
        { albumId: smartAlbum.id },
        { headers: asBearerAuth(recipient.accessToken) },
      );
      expect(recipientBuckets.length).toBeGreaterThan(0);
      expect(recipientBuckets.reduce((sum, b) => sum + b.count, 0)).toBeGreaterThanOrEqual(1);

      // Smart-album membership feeds the asset access checks: the recipient can read the
      // owner's matched asset (thumbnails/detail/download all route through this permission).
      const recipientAssetInfo = await getAssetInfo(
        { id: ownerAsset.id },
        { headers: asBearerAuth(recipient.accessToken) },
      );
      expect(recipientAssetInfo.id).toBe(ownerAsset.id);

      // Recipient is still a Viewer: PUT /albums/:id/assets is rejected by access control
      // before the smart-album kind check has a chance to run.
      const recipientAsset = await utils.createAsset(recipient.accessToken);
      const viewerAttempt = await request(app)
        .put(`/albums/${smartAlbum.id}/assets`)
        .set('Authorization', `Bearer ${recipient.accessToken}`)
        .send({ ids: [recipientAsset.id] });
      expect(viewerAttempt.status).toBe(400);
      expect(viewerAttempt.body).toEqual(errorDto.badRequest('Not found or no albumAsset.create access'));

      // Viewer is the only sharable smart-album role: promoting the recipient to Editor
      // (filter mutation) or Owner (breaks the single-owner evaluation assumption) is rejected.
      for (const role of [AlbumUserRole.Editor, AlbumUserRole.Owner]) {
        const promoteAttempt = await request(app)
          .put(`/albums/${smartAlbum.id}/user/${recipient.userId}`)
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send({ role });
        expect(promoteAttempt.status).toBe(400);
        expect(promoteAttempt.body).toEqual(errorDto.badRequest('Smart albums only support the viewer role'));
      }

      // A public shared link on the smart album grants asset access through the same
      // filter-membership check as logged-in sharees.
      const sharedLink = await utils.createSharedLink(owner.accessToken, {
        type: SharedLinkType.Album,
        albumId: smartAlbum.id,
      });
      const linkAssetInfo = await request(app).get(`/assets/${ownerAsset.id}`).query({ key: sharedLink.key });
      expect(linkAssetInfo.status).toBe(200);
      expect(linkAssetInfo.body.id).toBe(ownerAsset.id);

      // Even the owner cannot add assets directly - smart albums are read-only.
      const ownerAttempt = await request(app)
        .put(`/albums/${smartAlbum.id}/assets`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ ids: [ownerAsset.id] });
      expect(ownerAttempt.status).toBe(400);
      expect(ownerAttempt.body).toEqual(errorDto.badRequest('Cannot add assets to a smart album'));
    });
  });

  describe('album folder lifecycle with cascade share', () => {
    it('shares an inner album via a parent folder and revokes access cleanly', async () => {
      // Owner creates folder Family (root) then Andi inside Family.
      const family = await createAlbumContainer(
        { createAlbumContainerDto: { name: 'Family' } },
        { headers: asBearerAuth(user1.accessToken) },
      );
      expect(family).toMatchObject({ name: 'Family', parentId: null, ownerId: user1.userId });

      const andi = await createAlbumContainer(
        { createAlbumContainerDto: { name: 'Andi', parentId: family.id } },
        { headers: asBearerAuth(user1.accessToken) },
      );
      expect(andi).toMatchObject({ name: 'Andi', parentId: family.id });

      // Owner creates an album, moves it into the Andi folder, and adds an asset.
      const album = await utils.createAlbum(user1.accessToken, { albumName: 'Andi-2025-visit' });
      const movedAlbum = await updateAlbumInfo(
        { id: album.id, updateAlbumDto: { containerId: andi.id } },
        { headers: asBearerAuth(user1.accessToken) },
      );
      expect(movedAlbum.containerId).toEqual(andi.id);

      const asset1 = await utils.createAsset(user1.accessToken);
      await addAssetsToAlbum(
        { id: album.id, bulkIdsDto: { ids: [asset1.id] } },
        { headers: asBearerAuth(user1.accessToken) },
      );

      // Recipient (user2) has no access yet.
      {
        const { status, body } = await request(app)
          .get(`/albums/${album.id}`)
          .set('Authorization', `Bearer ${user2.accessToken}`);
        expect(status).toBe(400);
        expect(body).toEqual(errorDto.badRequest('Not found or no album.read access'));
      }

      // Owner shares the top-level folder (Family) with user2 as Editor.
      await addUserToAlbumContainer(
        {
          id: family.id,
          albumContainerUserCreateDto: { userId: user2.userId, role: AlbumUserRole.Editor },
        },
        { headers: asBearerAuth(user1.accessToken) },
      );

      // Cascade share: recipient now sees the inner album in getAllAlbums.
      const recipientAlbums = await getAllAlbums({}, { headers: asBearerAuth(user2.accessToken) });
      expect(recipientAlbums.map((a) => a.id)).toContain(album.id);

      // Recipient can read the album via per-album access cascade.
      const recipientView = await getAlbumInfo(
        { id: album.id },
        { headers: asBearerAuth(user2.accessToken) },
      );
      expect(recipientView).toMatchObject({ id: album.id });

      // Asset cascade (H3 regression): recipient can fetch metadata for assets in the cascaded album.
      const recipientAssetView = await getAssetInfo(
        { id: asset1.id },
        { headers: asBearerAuth(user2.accessToken) },
      );
      expect(recipientAssetView).toMatchObject({ id: asset1.id });

      // Asset cascade also reachable via HTTP (covers 403 path that was broken before H3 fix).
      {
        const { status } = await request(app)
          .get(`/assets/${asset1.id}`)
          .set('Authorization', `Bearer ${user2.accessToken}`);
        expect(status).toBe(200);
      }

      // Editor cascade: recipient can add assets to the inner album.
      const asset2 = await utils.createAsset(user2.accessToken);
      const addResult = await addAssetsToAlbum(
        { id: album.id, bulkIdsDto: { ids: [asset2.id] } },
        { headers: asBearerAuth(user2.accessToken) },
      );
      expect(addResult).toEqual([expect.objectContaining({ id: asset2.id, success: true })]);

      // Owner revokes the folder share.
      await removeUserFromAlbumContainer(
        { id: family.id, userId: user2.userId },
        { headers: asBearerAuth(user1.accessToken) },
      );

      // Recipient can no longer access the album.
      {
        const { status, body } = await request(app)
          .get(`/albums/${album.id}`)
          .set('Authorization', `Bearer ${user2.accessToken}`);
        expect(status).toBe(400);
        expect(body).toEqual(errorDto.badRequest('Not found or no album.read access'));
      }

      // Asset cascade is also revoked: recipient can no longer fetch the asset.
      {
        const { status } = await request(app)
          .get(`/assets/${asset1.id}`)
          .set('Authorization', `Bearer ${user2.accessToken}`);
        expect(status).toBe(400);
      }
    });

    it('rejects folder cycles', async () => {
      const outer = await createAlbumContainer(
        { createAlbumContainerDto: { name: 'cycle-outer' } },
        { headers: asBearerAuth(user1.accessToken) },
      );
      const inner = await createAlbumContainer(
        { createAlbumContainerDto: { name: 'cycle-inner', parentId: outer.id } },
        { headers: asBearerAuth(user1.accessToken) },
      );

      // Reparenting outer under its own descendant inner must be rejected with HTTP 400.
      const { status, body } = await request(app)
        .put(`/album-containers/${outer.id}`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ parentId: inner.id });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Cannot move a folder into its own descendant'));

      // Sanity-check via the SDK: same call surfaces as a thrown error.
      await expect(
        updateAlbumContainer(
          { id: outer.id, updateAlbumContainerDto: { parentId: inner.id } },
          { headers: asBearerAuth(user1.accessToken) },
        ),
      ).rejects.toBeDefined();
    });

    it('enforces the folder depth limit', async () => {
      // MAX_DEPTH = 16, enforced as `parentDepth + 1 > 16`, so the chain can
      // legally reach depth 16 (17 nodes from root). The next creation fails.
      let parentId: string | null = null;
      const chain: string[] = [];
      for (let i = 0; i <= 16; i++) {
        const folder = await createAlbumContainer(
          { createAlbumContainerDto: { name: `depth-${i}`, parentId } },
          { headers: asBearerAuth(user1.accessToken) },
        );
        chain.push(folder.id);
        parentId = folder.id;
      }
      expect(chain).toHaveLength(17);

      // One past the limit: parentDepth=16, so parentDepth + 1 = 17 > 16 — rejected.
      const { status, body } = await request(app)
        .post('/album-containers')
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ name: 'depth-overflow', parentId });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Folder depth exceeds limit of 16'));
    });
  });
});
