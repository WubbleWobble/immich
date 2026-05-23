<script lang="ts">
  import { Icon } from '@immich/ui';
  import { mdiChevronRight, mdiHomeOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface PathItem {
    id: string;
    name: string;
  }

  interface Props {
    path: PathItem[];
    onNavigate: (id: string | null) => void;
  }

  let { path, onNavigate }: Props = $props();
</script>

<nav class="flex items-center gap-2 text-sm" aria-label={$t('folders')}>
  <button
    type="button"
    class="flex items-center gap-1 rounded-md px-1 py-0.5 hover:text-primary"
    onclick={() => onNavigate(null)}
  >
    <Icon icon={mdiHomeOutline} size="16" />
    <span>{$t('albums')}</span>
  </button>
  {#each path as item (item.id)}
    <Icon icon={mdiChevronRight} size="14" aria-hidden="true" />
    <button type="button" class="rounded-md px-1 py-0.5 hover:text-primary" onclick={() => onNavigate(item.id)}>
      {item.name}
    </button>
  {/each}
</nav>
