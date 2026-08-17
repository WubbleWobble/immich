<script lang="ts">
  import { handleError } from '$lib/utils/handle-error';
  import { createAlbumContainer, type AlbumContainerResponseDto } from '@immich/sdk';
  import { Field, FormModal, Input } from '@immich/ui';
  import { mdiFolderPlusOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    parentId: string | null;
    onClose: (folder?: AlbumContainerResponseDto) => void;
  };

  let { parentId, onClose }: Props = $props();

  let name = $state('');

  const onSubmit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    try {
      const folder = await createAlbumContainer({ createAlbumContainerDto: { name: trimmed, parentId } });
      onClose(folder);
    } catch (error) {
      handleError(error, $t('errors.unable_to_update_album_info'));
    }
  };
</script>

<FormModal
  icon={mdiFolderPlusOutline}
  title={$t('new_folder')}
  submitText={$t('create')}
  cancelText={$t('cancel')}
  disabled={!name.trim()}
  size="small"
  {onClose}
  {onSubmit}
>
  <Field label={$t('name')}>
    <Input bind:value={name} placeholder={$t('folder')} />
  </Field>
</FormModal>
