import type { AssetResponseDto, SharedLinkResponseDto } from '@immich/sdk';
import { loadImage } from '$lib/actions/image-loader.svelte';
import { getAssetUrls } from '$lib/utils';
import { AdaptiveImageLoader, type QualityList } from '$lib/utils/adaptive-image-loader.svelte';

type AssetCursor = {
  current: AssetResponseDto;
  nextAsset?: AssetResponseDto;
  previousAsset?: AssetResponseDto;
};

export class PreloadManager {
  private nextPreloader: AdaptiveImageLoader | undefined;
  private previousPreloader: AdaptiveImageLoader | undefined;
  /**
   * Fork: the preloader of the asset the viewer navigated onto. It is kept alive while that asset is shown (the
   * viewer's <Image> adopts its in-flight requests) and destroyed once the viewer moves on. An orphaned preloader's
   * unsettled requests would otherwise count as live consumers forever and block the cancel of every passed-over
   * asset's download (see ImageRequestLedger). Destroying it cancels only its own tokens: an <Image> still showing
   * the URL keeps its own.
   */
  private adoptedPreloader: AdaptiveImageLoader | undefined;

  private startPreloader(
    asset: AssetResponseDto | undefined,
    sharedlink: SharedLinkResponseDto | undefined,
  ): AdaptiveImageLoader | undefined {
    if (!asset) {
      return;
    }
    const urls = getAssetUrls(asset, sharedlink);
    const afterThumbnail = (loader: AdaptiveImageLoader) => loader.trigger('preview');
    const qualityList: QualityList = [
      {
        quality: 'thumbnail',
        url: urls.thumbnail,
        onAfterLoad: afterThumbnail,
        onAfterError: afterThumbnail,
      },
      {
        quality: 'preview',
        url: urls.preview,
        onAfterError: (loader) => loader.trigger('original'),
      },
      { quality: 'original', url: urls.original },
    ];
    const loader = new AdaptiveImageLoader(qualityList, undefined, loadImage);
    loader.start();
    return loader;
  }

  private destroyPreviousPreloader() {
    this.previousPreloader?.destroy();
    this.previousPreloader = undefined;
  }

  private destroyNextPreloader() {
    this.nextPreloader?.destroy();
    this.nextPreloader = undefined;
  }

  cancelBeforeNavigation(direction: 'previous' | 'next') {
    switch (direction) {
      case 'next': {
        this.destroyPreviousPreloader();
        break;
      }
      case 'previous': {
        this.destroyNextPreloader();
        break;
      }
    }
  }

  updateAfterNavigation(oldCursor: AssetCursor, newCursor: AssetCursor, sharedlink: SharedLinkResponseDto | undefined) {
    const movedForward = newCursor.current.id === oldCursor.nextAsset?.id;
    const movedBackward = newCursor.current.id === oldCursor.previousAsset?.id;

    // the viewer left the asset whose preloader it had adopted
    this.adoptedPreloader?.destroy();
    this.adoptedPreloader = undefined;

    if (!movedBackward) {
      this.destroyPreviousPreloader();
    }

    if (!movedForward) {
      this.destroyNextPreloader();
    }

    if (movedForward) {
      this.adoptedPreloader = this.nextPreloader;
      this.nextPreloader = this.startPreloader(newCursor.nextAsset, sharedlink);
    } else if (movedBackward) {
      this.adoptedPreloader = this.previousPreloader;
      this.previousPreloader = this.startPreloader(newCursor.previousAsset, sharedlink);
    } else {
      this.previousPreloader = this.startPreloader(newCursor.previousAsset, sharedlink);
      this.nextPreloader = this.startPreloader(newCursor.nextAsset, sharedlink);
    }
  }

  initializePreloads(cursor: AssetCursor, sharedlink: SharedLinkResponseDto | undefined) {
    if (cursor.nextAsset) {
      this.nextPreloader = this.startPreloader(cursor.nextAsset, sharedlink);
    }
    if (cursor.previousAsset) {
      this.previousPreloader = this.startPreloader(cursor.previousAsset, sharedlink);
    }
  }

  destroy() {
    this.destroyNextPreloader();
    this.destroyPreviousPreloader();
    this.adoptedPreloader?.destroy();
    this.adoptedPreloader = undefined;
  }
}

export const preloadManager = new PreloadManager();
