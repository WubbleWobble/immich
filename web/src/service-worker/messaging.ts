/* eslint-disable unicorn/no-unnecessary-global-this */
/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { handleCancel, handlePurge } from './request';

const sw = globalThis as unknown as ServiceWorkerGlobalScope;

export const installMessageListener = () => {
  sw.addEventListener('message', (event) => {
    if (!event.data?.type) {
      return;
    }

    switch (event.data.type) {
      case 'cancel': {
        const url = event.data.url ? new URL(event.data.url, globalThis.location.origin) : undefined;
        if (!url) {
          return;
        }

        const client = event.source;
        if (!client) {
          return;
        }

        handleCancel(url);
        break;
      }

      // Fork (R50): an authorization boundary in any tab - one worker serves every client of the origin
      case 'purge': {
        handlePurge();
        break;
      }
    }
  });
};
