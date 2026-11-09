import { AlbumKind, AlbumUserRole, removeUserFromAlbum, type AlbumResponseDto } from '@immich/sdk';
import { modalManager } from '@immich/ui';
import type { Mock } from 'vitest';
import { vitest } from 'vitest';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { lockManager } from '$lib/managers/lock-manager.svelte';
import {
  getAlbumActions,
  getAlbumAssetsActions,
  getAlbumFolderActions,
  handleLeaveAlbum,
} from '$lib/services/album.service';
import { getAssetBulkActions } from '$lib/services/asset.service';
import { handleError } from '$lib/utils/handle-error';
import { albumFactory } from '@test-data/factories/album-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

vitest.mock('@immich/sdk', async (importOriginal) => {
  const original = await importOriginal<typeof import('@immich/sdk')>();
  return { ...original, removeUserFromAlbum: vitest.fn() };
});

vitest.mock('@immich/ui', async (importOriginal) => {
  const original = await importOriginal<typeof import('@immich/ui')>();
  return {
    ...original,
    modalManager: { show: vitest.fn(), showDialog: vitest.fn() },
    toastManager: { primary: vitest.fn(), danger: vitest.fn(), warning: vitest.fn(), info: vitest.fn() },
  };
});

vitest.mock('$lib/utils/handle-error', () => ({ handleError: vitest.fn() }));

vitest.mock('$lib/utils/i18n', () => ({
  getFormatter: vitest.fn().mockResolvedValue((key: string) => key),
  getPreferredLocale: vitest.fn(),
}));

vi.mock(import('$lib/managers/feature-flags-manager.svelte'), function () {
  return {
    featureFlagsManager: { init: vi.fn(), loadFeatureFlags: vi.fn(), value: {} } as never,
  };
});

const $t = ((key: string) => key) as never;

const owner = userAdminFactory.build({ id: 'owner' });
const viewer = userAdminFactory.build({ id: 'viewer' });
const editor = userAdminFactory.build({ id: 'editor' });

const buildAlbum = (overrides: Partial<AlbumResponseDto> = {}) =>
  albumFactory.build({
    id: 'album-1',
    assetCount: 3,
    shared: true,
    albumUsers: [
      { user: owner, role: AlbumUserRole.Owner },
      { user: editor, role: AlbumUserRole.Editor },
      { user: viewer, role: AlbumUserRole.Viewer },
    ],
    ...overrides,
  });

const smartAlbum = () => buildAlbum({ kind: AlbumKind.Smart, filter: { isFavorite: true } });

const visible = (action: { $if?: () => boolean }) => action.$if?.() ?? true;

describe('album actions', () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    lockManager.isElevated = false;
    lockManager.lockedAlbumIds.clear();
    lockManager.lockedContainerIds.clear();
  });

  describe('Delete / Leave', () => {
    it('offers Delete only to the owner, and Leave only to the other members', () => {
      authManager.setUser(owner);
      let actions = getAlbumActions($t, buildAlbum());
      expect(visible(actions.Delete)).toBe(true);
      expect(visible(actions.Leave)).toBe(false);

      for (const member of [editor, viewer]) {
        authManager.setUser(member);
        actions = getAlbumActions($t, buildAlbum());
        expect(visible(actions.Delete)).toBe(false);
        expect(visible(actions.Leave)).toBe(true);
      }
    });

    it('shows the server error when leaving fails and does not treat the album as left', async () => {
      authManager.setUser(viewer);
      (modalManager.showDialog as Mock).mockResolvedValue(true);
      const error = new Error('Not found or no album.read access');
      (removeUserFromAlbum as Mock).mockRejectedValue(error);
      const emit = vitest.spyOn(eventManager, 'emit');

      await expect(handleLeaveAlbum(buildAlbum())).resolves.toBeUndefined();

      expect(handleError).toHaveBeenCalledWith(error, 'errors.unable_to_remove_album_users');
      expect(emit).not.toHaveBeenCalledWith('AlbumDelete', expect.anything());
    });
  });

  describe('EditSmartFilter', () => {
    it('is offered to the owner of a smart album only', () => {
      authManager.setUser(owner);
      expect(visible(getAlbumActions($t, smartAlbum()).EditSmartFilter)).toBe(true);
      expect(visible(getAlbumActions($t, buildAlbum()).EditSmartFilter)).toBe(false);

      authManager.setUser(viewer);
      expect(visible(getAlbumActions($t, smartAlbum()).EditSmartFilter)).toBe(false);
    });
  });

  describe('MoveToFolder', () => {
    it('is offered to the owner only', () => {
      authManager.setUser(owner);
      expect(visible(getAlbumActions($t, buildAlbum()).MoveToFolder)).toBe(true);
      authManager.setUser(editor);
      expect(visible(getAlbumActions($t, buildAlbum()).MoveToFolder)).toBe(false);
    });
  });

  describe('Lock / Unlock', () => {
    it('is hidden outside an elevated session, even for the owner', () => {
      authManager.setUser(owner);
      const { Lock, Unlock } = getAlbumActions($t, buildAlbum());
      expect(visible(Lock)).toBe(false);
      expect(visible(Unlock)).toBe(false);
    });

    it('is offered to any reader while elevated, matching the per-user lock state', () => {
      lockManager.isElevated = true;
      for (const member of [owner, editor, viewer]) {
        authManager.setUser(member);
        const { Lock, Unlock } = getAlbumActions($t, buildAlbum());
        expect(visible(Lock)).toBe(true);
        expect(visible(Unlock)).toBe(false);
      }

      lockManager.lockedAlbumIds.add('album-1');
      const { Lock, Unlock } = getAlbumActions($t, buildAlbum());
      expect(visible(Lock)).toBe(false);
      expect(visible(Unlock)).toBe(true);
    });
  });

  describe('smart albums are read-only', () => {
    it('hides AddAssets, Upload and RemoveFromAlbum', () => {
      authManager.setUser(owner);
      const assets = [{ id: 'asset-1' }] as never;

      const regular = getAlbumAssetsActions($t, buildAlbum(), assets);
      expect(visible(regular.AddAssets)).toBe(true);
      expect(visible(regular.Upload)).toBe(true);
      expect(visible(getAssetBulkActions($t, buildAlbum()).RemoveFromAlbum)).toBe(true);

      const smart = getAlbumAssetsActions($t, smartAlbum(), assets);
      expect(visible(smart.AddAssets)).toBe(false);
      expect(visible(smart.Upload)).toBe(false);
      expect(visible(getAssetBulkActions($t, smartAlbum()).RemoveFromAlbum)).toBe(false);
    });
  });

  describe('folder actions', () => {
    const folder = { id: 'folder-1', name: 'Trips', ownerId: 'owner', parentId: null } as never;

    it('offers move/share/delete to the owner only, lock/unlock to any reader while elevated', () => {
      authManager.setUser(viewer);
      let actions = getAlbumFolderActions($t, folder);
      expect(Object.values(actions).some((action) => visible(action))).toBe(false);

      lockManager.isElevated = true;
      actions = getAlbumFolderActions($t, folder);
      expect(visible(actions.Lock)).toBe(true);
      expect(visible(actions.Move)).toBe(false);
      expect(visible(actions.Share)).toBe(false);
      expect(visible(actions.Delete)).toBe(false);

      authManager.setUser(owner);
      lockManager.lockedContainerIds.add('folder-1');
      actions = getAlbumFolderActions($t, folder);
      expect(visible(actions.Move)).toBe(true);
      expect(visible(actions.Share)).toBe(true);
      expect(visible(actions.Delete)).toBe(true);
      expect(visible(actions.Lock)).toBe(false);
      expect(visible(actions.Unlock)).toBe(true);
    });
  });
});
