/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

type PendingRequest = {
  controller: AbortController;
  promise: Promise<Response>;
};

/**
 * Fork (R50): IN-FLIGHT requests only, for deduplicating concurrent requests for one URL. An entry is dropped as soon
 * as its response settles (headers received, or failure): a completed response - possibly fetched under credentials,
 * an elevation or a reveal set that no longer hold - is never handed to a later request, which goes to the network
 * and is re-authorized there. Callers already hold their own clones.
 */
const pendingRequests = new Map<string, PendingRequest>();

/**
 * Every request whose body may still be streaming, so an image unmount (cancel) or an authorization-boundary purge can
 * still abort it after its headers arrived. Never used to answer a request.
 */
const activeControllers = new Map<string, Set<AbortController>>();

const getRequestKey = (request: URL | Request): string => (request instanceof URL ? request.href : request.url);

const CANCELATION_MESSAGE = 'Request canceled by application';
const CLEANUP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const forgetController = (requestKey: string, controller: AbortController) => {
  const controllers = activeControllers.get(requestKey);
  controllers?.delete(controller);
  if (controllers?.size === 0) {
    activeControllers.delete(requestKey);
  }
};

export const handleFetch = async (request: URL | Request): Promise<Response> => {
  const requestKey = getRequestKey(request);
  const existing = pendingRequests.get(requestKey);

  if (existing) {
    // Clone the response since response bodies can only be read once
    // Each caller gets an independent clone they can consume
    return existing.promise.then((response) => response.clone());
  }

  const controller = new AbortController();
  const pendingRequest: PendingRequest = { controller, promise: undefined as unknown as Promise<Response> };
  pendingRequests.set(requestKey, pendingRequest);
  const controllers = activeControllers.get(requestKey) ?? new Set<AbortController>();
  controllers.add(controller);
  activeControllers.set(requestKey, controllers);

  // NOTE: fetch returns after headers received, not the body
  pendingRequest.promise = fetch(request, { signal: controller.signal })
    .catch((error: unknown) => {
      const standardError = error instanceof Error ? error : new Error(String(error));
      if (standardError.name === 'AbortError' || standardError.message === CANCELATION_MESSAGE) {
        // dummy response avoids network errors in the console for these requests
        return new Response(undefined, { status: 204 });
      }
      throw standardError;
    })
    .finally(() => {
      // Settled: stop sharing it (a purge or a newer request may already have replaced the entry)
      if (pendingRequests.get(requestKey) === pendingRequest) {
        pendingRequests.delete(requestKey);
      }
      // Keep the controller a while so the body stream can still be aborted
      setTimeout(() => forgetController(requestKey, controller), CLEANUP_TIMEOUT_MS);
    });

  // Clone for the first caller to keep the original response unconsumed for concurrent callers
  return pendingRequest.promise.then((response) => response.clone());
};

export const handleCancel = (url: URL) => {
  const requestKey = getRequestKey(url);

  pendingRequests.delete(requestKey);
  for (const controller of activeControllers.get(requestKey) ?? []) {
    controller.abort(CANCELATION_MESSAGE);
  }
  activeControllers.delete(requestKey);
};

/**
 * Fork (R50): authorization boundary (logout, session deleted or locked, end of elevation, lock/unlock, reveal-set
 * change - from any tab, the worker is shared by every client of the origin): abort and forget every request.
 */
export const handlePurge = () => {
  pendingRequests.clear();
  for (const controllers of activeControllers.values()) {
    for (const controller of controllers) {
      controller.abort(CANCELATION_MESSAGE);
    }
  }
  activeControllers.clear();
};
