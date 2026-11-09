<script lang="ts">
  import type { DanglingSmartAlbumReferences } from '$lib/utils/smart-album-references';
  import { Button, Icon, modalManager } from '@immich/ui';
  import { mdiAlertOutline, mdiClose } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    references: DanglingSmartAlbumReferences;
    /** Removes the dangling ids of one kind; omit to show the warning without the repair (non-owners). */
    onRemove?: (references: DanglingSmartAlbumReferences) => unknown;
  };

  const { references, onRemove }: Props = $props();

  // Rewriting the album's filter is not undoable from here, so it is confirmed first (as the locks page does).
  const confirmRemove = async (chipReferences: DanglingSmartAlbumReferences) => {
    const confirmed = await modalManager.showDialog({
      title: $t('smart_album_dangling_remove_title'),
      prompt: $t('smart_album_dangling_remove_prompt'),
      confirmText: $t('remove'),
    });
    if (confirmed) {
      await onRemove?.(chipReferences);
    }
  };

  const chips = $derived(
    [
      {
        kind: 'person',
        text: $t('smart_album_dangling_person'),
        references: { personIds: references.personIds, tagIds: [] },
        count: references.personIds.length,
      },
      {
        kind: 'tag',
        text: $t('smart_album_dangling_tag'),
        references: { personIds: [], tagIds: references.tagIds },
        count: references.tagIds.length,
      },
    ].filter(({ count }) => count > 0),
  );
</script>

{#if chips.length > 0}
  <div class="flex flex-wrap gap-2" data-testid="smart-album-dangling-references">
    {#each chips as chip (chip.kind)}
      <div
        class="inline-flex items-center gap-2 rounded-full bg-warning/15 py-1 ps-3 pe-1 text-sm text-warning ring-1 ring-warning/30"
        role="status"
      >
        <Icon icon={mdiAlertOutline} size="16" />
        <span>{chip.text}</span>
        {#if onRemove}
          <Button
            size="tiny"
            shape="round"
            variant="ghost"
            color="warning"
            trailingIcon={mdiClose}
            onclick={() => confirmRemove(chip.references)}
          >
            {$t('remove')}
          </Button>
        {/if}
      </div>
    {/each}
  </div>
{/if}
