<script lang="ts">
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { normalizeSearchString } from '$lib/utils/string-utils';
  import {
    addUserToAlbumContainer,
    AlbumUserRole,
    getAllAlbumContainers,
    getAllAlbums,
    searchUsers,
    type AlbumContainerResponseDto,
    type UserResponseDto,
  } from '@immich/sdk';
  import {
    Alert,
    Field,
    FormModal,
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
    onClose: (added?: boolean) => void;
  };

  let { folder, onClose }: Props = $props();

  let users: UserResponseDto[] = $state([]);
  let containers: AlbumContainerResponseDto[] = $state([]);
  let albumCount = $state(0);
  let folderCount = $state(0);
  let loading = $state(true);
  let search = $state('');
  let selectedUser: UserResponseDto | undefined = $state();
  let role: AlbumUserRole = $state(AlbumUserRole.Editor);

  onMount(async () => {
    try {
      const [allUsers, allContainers, ownedAlbums] = await Promise.all([
        searchUsers(),
        getAllAlbumContainers(),
        getAllAlbums({ isOwned: true }),
      ]);
      users = allUsers;
      containers = allContainers;

      // Compute descendant folder set (excluding the root folder itself).
      // eslint-disable-next-line svelte/prefer-svelte-reactivity
      const descendants = new Set<string>([folder.id]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const c of containers) {
          if (c.parentId && descendants.has(c.parentId) && !descendants.has(c.id)) {
            descendants.add(c.id);
            changed = true;
          }
        }
      }
      // Count subfolders (everything in descendants minus the root itself).
      folderCount = descendants.size - 1;
      // Count albums whose containerId is in the descendant set.
      albumCount = ownedAlbums.filter((a) => a.containerId && descendants.has(a.containerId)).length;
    } catch (error) {
      handleError(error, $t('errors.unable_to_update_album_info'));
    } finally {
      loading = false;
    }
  });

  const filteredUsers = $derived(
    sortBy(
      users.filter((u) => normalizeSearchString(u.name).includes(normalizeSearchString(search))),
      ['name'],
    ),
  );

  const roleOptions: SelectOption<AlbumUserRole>[] = [
    { label: $t('role_editor'), value: AlbumUserRole.Editor },
    { label: $t('role_viewer'), value: AlbumUserRole.Viewer },
  ];

  const onSubmit = async () => {
    if (!selectedUser) {
      return;
    }
    try {
      await addUserToAlbumContainer({
        id: folder.id,
        albumContainerUserCreateDto: { userId: selectedUser.id, role },
      });
      onClose(true);
    } catch (error) {
      handleError(error, $t('errors.unable_to_update_album_info'));
    }
  };
</script>

<FormModal
  icon={mdiShareVariantOutline}
  title={$t('share_folder')}
  submitText={$t('share')}
  cancelText={$t('cancel')}
  disabled={!selectedUser}
  size="small"
  {onClose}
  {onSubmit}
>
  {#if loading}
    <div class="flex w-full place-content-center place-items-center py-6">
      <LoadingSpinner />
    </div>
  {:else}
    <Stack gap={4}>
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
