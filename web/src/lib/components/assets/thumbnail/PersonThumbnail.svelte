<script lang="ts">
  import ImageThumbnail from '$lib/components/assets/thumbnail/ImageThumbnail.svelte';
  import { lockManager } from '$lib/managers/lock-manager.svelte';
  import { PersonThumbnailLoader } from '$lib/utils/person-thumbnail.svelte';
  import { untrack, type ComponentProps } from 'svelte';

  type Props = Omit<ComponentProps<typeof ImageThumbnail>, 'url' | 'failed' | 'placeholder'> & {
    person: { id: string; updatedAt?: string };
    /** Change it to force a refetch (e.g. the feature photo was regenerated). */
    cacheKey?: string;
  };

  let { person, cacheKey, preload = true, ...rest }: Props = $props();

  // Fork (T6): portraits load through the SDK so the request carries the reveal headers; see PersonThumbnailLoader.
  const loader = new PersonThumbnailLoader();

  let placeholder = $state<HTMLElement>();
  let nearViewport = $state(false);
  const ready = $derived(preload || nearViewport);

  // A lazy portrait (preload=false) waits until it approaches the viewport, like the native lazy <img> it replaces.
  $effect(() => {
    if (ready || !placeholder) {
      return;
    }
    if (typeof IntersectionObserver === 'undefined') {
      nearViewport = true;
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some(({ isIntersecting }) => isIntersecting)) {
          nearViewport = true;
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(placeholder);
    return () => observer.disconnect();
  });

  // Refetch when the person, their portrait, elevation, the lock sets or the reveal set change. The cleanup aborts the
  // in-flight request and revokes the object URL, on change and on unmount.
  const visibilityKey = $derived(lockManager.visibilityKey);
  $effect(() => {
    if (!ready) {
      return;
    }
    const id = person.id;
    void person.updatedAt;
    void cacheKey;
    void visibilityKey;
    untrack(() => loader.load(id));
    return () => loader.release();
  });
</script>

<!-- <Image> captures only its first src: remount on every new object URL. -->
{#key loader.url}
  <ImageThumbnail url={loader.url} failed={loader.failed} bind:placeholder {preload} {...rest} />
{/key}
