import { getPersonThumbnail } from '@immich/sdk';

/**
 * Fork (T6): loads a person portrait through the SDK, so the request carries the SDK default headers - including the
 * lock manager's reveal headers. A native <img> URL never carries them, so a portrait whose source face sits in an own
 * locked album stays withheld even after the elevated owner revealed that lock. The server rule is unchanged.
 *
 * The portrait is exposed as an object URL. Each `load` aborts the previous request and revokes the previous object
 * URL; `release` does the same without starting a new request (call it on unmount).
 */
export class PersonThumbnailLoader {
  /** Object URL of the loaded portrait, undefined while loading or when the portrait is withheld. */
  url = $state<string | undefined>();
  /** The request failed (withheld by the server, network error or bad response). */
  failed = $state(false);

  // Not reactive: `load` runs inside effects and must not track (or re-trigger on) its own bookkeeping.
  #controller: AbortController | undefined;
  #objectUrl: string | undefined;

  load(personId: string) {
    this.release();
    const controller = new AbortController();
    this.#controller = controller;
    void getPersonThumbnail({ id: personId }, { signal: controller.signal })
      .then((blob) => {
        if (controller.signal.aborted) {
          return;
        }
        this.#objectUrl = URL.createObjectURL(blob);
        this.url = this.#objectUrl;
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          this.failed = true;
        }
      });
  }

  /** Abort the in-flight request and revoke the current portrait. */
  release() {
    this.#controller?.abort();
    this.#controller = undefined;
    if (this.#objectUrl) {
      URL.revokeObjectURL(this.#objectUrl);
      this.#objectUrl = undefined;
    }
    this.url = undefined;
    this.failed = false;
  }
}
