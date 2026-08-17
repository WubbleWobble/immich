<script lang="ts">
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { collectDescendantFolderIds } from '$lib/utils/album-folder-utils';
  import { handleError } from '$lib/utils/handle-error';
  import { normalizeSearchString } from '$lib/utils/string-utils';
  import {
    addUserToAlbumContainer,
    AlbumUserRole,
    getAlbumContainer,
    getAllAlbumContainers,
    getAllAlbums,
    removeUserFromAlbumContainer,
    searchUsers,
    updateAlbumContainerUser,
    type AlbumContainerResponseDto,
    type AlbumContainerUserResponseDto,
    type UserResponseDto,
  } from '@immich/sdk';
  import {
    Alert,
    Field,
    FormModal,
    HStack,
    ListButton,
    LoadingSpinner,
    Select,
    Stack,
    Text,
    type SelectOption,
  } from '@immich/ui';
  import { mdiShareVariantOutline } from '@mdi/js';
  import { sortBy } from 'lodash-es';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    folder: AlbumContainerResponseDto;
    onClose: (changed?: boolean) => void;
  };

  let { folder, onClose }: Props = $props();

  let users: UserResponseDto[] = $state([]);
  let containers: AlbumContainerResponseDto[] = $state([]);
  let existingShares: AlbumContainerUserResponseDto[] = $state([]);
  let albumCount = $state(0);
  let folderCount = $state(0);
  let loading = $state(true);
  let mutating = $state(false);
  let search = $state('');
  let selectedUser: UserResponseDto | undefined = $state();
  let role: AlbumUserRole = $state(AlbumUserRole.Editor);
  let madeChanges = $state(false);

  const refreshShares = async () => {
    const fresh = await getAlbumContainer({ id: folder.id });
    existingShares = fresh.albumContainerUsers ?? [];
  };

  onMount(async () => {
    try {
      const [allUsers, allContainers, ownedAlbums, fresh] = await Promise.all([
        searchUsers(),
        getAllAlbumContainers(),
        getAllAlbums({ isOwned: true }),
        getAlbumContainer({ id: folder.id }),
      ]);
      users = allUsers;
      containers = allContainers;
      existingShares = fresh.albumContainerUsers ?? [];

      // Compute descendant folder set (excluding the root folder itself).
      const descendants = collectDescendantFolderIds(containers, folder.id);
      folderCount = descendants.size - 1;
      albumCount = ownedAlbums.filter((a) => a.containerId && descendants.has(a.containerId)).length;
    } catch (error) {
      handleError(error, $t('errors.unable_to_update_album_info'));
    } finally {
      loading = false;
    }
  });

  const sharedUserIds = $derived(new Set(existingShares.map((s) => s.userId)));

  const filteredUsers = $derived(
    sortBy(
      users.filter(
        (u) => !sharedUserIds.has(u.id) && normalizeSearchString(u.name).includes(normalizeSearchString(search)),
      ),
      ['name'],
    ),
  );

  const roleOptions: SelectOption<AlbumUserRole>[] = [
    { label: $t('role_editor'), value: AlbumUserRole.Editor },
    { label: $t('role_viewer'), value: AlbumUserRole.Viewer },
  ];

  const handleRoleSelect = async (share: AlbumContainerUserResponseDto, value: AlbumUserRole | 'none') => {
    if (value !== 'none' && value === share.role) {
      return;
    }
    mutating = true;
    try {
      await (value === 'none'
        ? removeUserFromAlbumContainer({ id: folder.id, userId: share.userId })
        : updateAlbumContainerUser({
            id: folder.id,
            userId: share.userId,
            albumContainerUserUpdateDto: { role: value },
          }));
      madeChanges = true;
      await refreshShares();
    } catch (error) {
      handleError(error, $t('errors.unable_to_update_album_info'));
    } finally {
      mutating = false;
    }
  };

  const onSubmit = async () => {
    if (!selectedUser) {
      return;
    }
    mutating = true;
    try {
      await addUserToAlbumContainer({
        id: folder.id,
        albumContainerUserCreateDto: { userId: selectedUser.id, role },
      });
      madeChanges = true;
      selectedUser = undefined;
      search = '';
      await refreshShares();
    } catch (error) {
      handleError(error, $t('errors.unable_to_update_album_info'));
    } finally {
      mutating = false;
    }
  };

  const onCloseModal = () => onClose(madeChanges);
</script>

<FormModal
  icon={mdiShareVariantOutline}
  title={$t('share_folder')}
  submitText={$t('share')}
  cancelText={$t('cancel')}
  disabled={!selectedUser || mutating}
  size="small"
  onClose={onCloseModal}
  {onSubmit}
>
  {#if loading}
    <div class="flex w-full place-content-center place-items-center py-6">
      <LoadingSpinner />
    </div>
  {:else}
    <Stack gap={4}>
      {#if existingShares.length > 0}
        <div>
          <Text size="medium" fontWeight="semi-bold" class="mb-2">{$t('people')}</Text>
          <Stack gap={2}>
            {#each existingShares as share (share.userId)}
              <HStack fullWidth class="items-center justify-between gap-3">
                <HStack class="min-w-0 items-center gap-2">
                  <UserAvatar user={share.user} size="md" />
                  <div class="min-w-0 grow text-start">
                    <Text fontWeight="medium" class="truncate">{share.user.name}</Text>
                    <Text size="tiny" color="muted" class="truncate">{share.user.email}</Text>
                  </div>
                </HStack>
                <Field class="w-36" disabled={mutating}>
                  <Select
                    value={share.role}
                    options={[
                      { label: $t('role_editor'), value: AlbumUserRole.Editor },
                      { label: $t('role_viewer'), value: AlbumUserRole.Viewer },
                      { label: $t('remove_user'), value: 'none' },
                    ] as SelectOption<AlbumUserRole | 'none'>[]}
                    onChange={(value) => handleRoleSelect(share, value)}
                  />
                </Field>
              </HStack>
            {/each}
          </Stack>
        </div>
      {/if}

      <Field label={$t('role')}>
        <Select value={role} options={roleOptions} onChange={(value) => (role = value)} />
      </Field>

      <Field label={$t('users')}>
        <input
          class="w-full border-b-2 border-immich-bg px-2 py-1 focus:border-immich-primary dark:border-immich-dark-gray dark:focus:border-immich-dark-primary"
          placeholder={$t('search')}
          bind:value={search}
        />
      </Field>

      <div class="flex max-h-60 immich-scrollbar flex-col gap-1 overflow-y-auto">
        {#each filteredUsers as user (user.id)}
          <ListButton selected={selectedUser?.id === user.id} onclick={() => (selectedUser = user)}>
            <UserAvatar {user} size="md" />
            <div class="grow text-start">
              <Text fontWeight="medium">{user.name}</Text>
              <Text size="tiny" color="muted">{user.email}</Text>
            </div>
          </ListButton>
        {:else}
          <Text class="py-4" color="muted">{$t('album_share_no_users')}</Text>
        {/each}
      </div>

      <Alert>
        <Text size="small">
          {$t('folder_share_scope', {
            values: {
              folderCount: folderCount + 1,
              albumCount,
              user: selectedUser?.name ?? '…',
              role: role === AlbumUserRole.Editor ? $t('role_editor') : $t('role_viewer'),
            },
          })}
        </Text>
      </Alert>
    </Stack>
  {/if}
</FormModal>
