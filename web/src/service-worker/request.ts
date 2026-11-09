/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

type PendingRequest = {
  url: string;
  controller: AbortController;
  promise: Promise<Response>;
  /** Live consumers per client (tab): a cancel releases one of the sending client's references. */
  consumers: Map<string, number>;
};

/**
 * Fork (R50): IN-FLIGHT requests only, for deduplicating concurrent requests for one URL. An entry is dropped as soon
 * as its response settles (headers received, or failure): a completed response - possibly fetched under credentials,
 * an elevation or a reveal set that no longer hold - is never handed to a later request, which goes to the network
 * and is re-authorized there. Callers already hold their own clones.
 */
const pendingRequests = new Map<string, PendingRequest>();

/**
 * Every request whose body may still be streaming, so an authorization-boundary purge can still abort it after its
 * headers arrived. Never used to answer a request, and never touched by a cancel.
 */
const activeControllers = new Map<string, Set<AbortController>>();

const getRequestKey = (request: URL | Request): string => (request instanceof URL ? request.href : request.url);

/** Request headers that carry credentials or change what the server authorizes (cookies are not visible here). */
const AUTHORIZATION_HEADERS = [
  'authorization',
  'x-api-key',
  'x-immich-user-token',
  'x-immich-session-token',
  'x-immich-share-key',
  'x-immich-share-slug',
  'x-immich-revealed-albums',
  'x-immich-revealed-containers',
];

/** In-flight requests are shared only between requests for the same URL with the same explicit credentials. */
const getPendingKey = (request: URL | Request): string => {
  const url = getRequestKey(request);
  if (request instanceof URL) {
    return url;
  }
  return JSON.stringify([url, ...AUTHORIZATION_HEADERS.map((name) => request.headers.get(name))]);
};

const CANCELATION_MESSAGE = 'Request canceled by application';
const CLEANUP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const forgetController = (requestKey: string, controller: AbortController) => {
  const controllers = activeControllers.get(requestKey);
  controllers?.delete(controller);
  if (controllers?.size === 0) {
    activeControllers.delete(requestKey);
  }
};

const addConsumer = (pendingRequest: PendingRequest, clientId: string) =>
  pendingRequest.consumers.set(clientId, (pendingRequest.consumers.get(clientId) ?? 0) + 1);

export const handleFetch = async (request: URL | Request, clientId = ''): Promise<Response> => {
  const requestKey = getRequestKey(request);
  const pendingKey = getPendingKey(request);
  const existing = pendingRequests.get(pendingKey);

  if (existing) {
    addConsumer(existing, clientId);
    // Clone the response since response bodies can only be read once
    // Each caller gets an independent clone they can consume
    return existing.promise.then((response) => response.clone());
  }

  const controller = new AbortController();
  const pendingRequest: PendingRequest = {
    url: requestKey,
    controller,
    promise: undefined as unknown as Promise<Response>,
    consumers: new Map([[clientId, 1]]),
  };
  pendingRequests.set(pendingKey, pendingRequest);
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
      if (pendingRequests.get(pendingKey) === pendingRequest) {
        pendingRequests.delete(pendingKey);
      }
      // Keep the controller a while so the body stream can still be aborted
      setTimeout(() => forgetController(requestKey, controller), CLEANUP_TIMEOUT_MS);
    });

  // Clone for the first caller to keep the original response unconsumed for concurrent callers
  return pendingRequest.promise.then((response) => response.clone());
};

/**
 * A consumer in `clientId` no longer wants `url` (an image unmounted before it loaded). Only requests still in flight
 * are affected, and only those holding a reference from that client: one reference is released, and the request is
 * aborted when its last consumer is gone. A settled request - and so any request started after the canceller's own
 * request settled - is never touched. The page sends a cancel only for its last unsettled consumer of the URL (see
 * ImageRequestLedger), so a fresh consumer in the same tab is not cancelled by a stale one either.
 */
export const handleCancel = (url: URL, clientId = '') => {
  const requestKey = getRequestKey(url);

  for (const [pendingKey, pendingRequest] of pendingRequests) {
    const references = pendingRequest.consumers.get(clientId) ?? 0;
    if (pendingRequest.url !== requestKey || references === 0) {
      continue;
    }
    if (references > 1) {
      pendingRequest.consumers.set(clientId, references - 1);
      continue;
    }
    pendingRequest.consumers.delete(clientId);
    if (pendingRequest.consumers.size > 0) {
      continue;
    }

    pendingRequests.delete(pendingKey);
    pendingRequest.controller.abort(CANCELATION_MESSAGE);
  }
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
