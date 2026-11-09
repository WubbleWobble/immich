/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

type TrackedRequest = {
  url: string;
  pendingKey: string;
  controller: AbortController;
  /** Live consumers per client (tab): a cancel releases one of the sending client's references. */
  consumers: Map<string, number>;
  /** Callers that joined while the request was in flight; each gets its own response. */
  joiners: number;
  promise: Promise<Response[]>;
  cleanupTimeout?: ReturnType<typeof setTimeout>;
};

/**
 * Fork (R50): IN-FLIGHT requests only, for deduplicating concurrent requests for one URL. An entry is dropped as soon
 * as its response settles (headers received, or failure): a completed response - possibly fetched under credentials,
 * an elevation or a reveal set that no longer hold - is never handed to a later request, which goes to the network
 * and is re-authorized there.
 */
const pendingRequests = new Map<string, TrackedRequest>();

/**
 * Every request from its start until its body has been fully read, errored or been cancelled by every reader: a cancel
 * (last consumer gone) or an authorization-boundary purge can abort it even after the headers arrived. Its references
 * are only those of the consumers that joined it while it was in flight. Never used to answer a request.
 */
const activeRequests = new Set<TrackedRequest>();

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

const forget = (record: TrackedRequest) => {
  activeRequests.delete(record);
  clearTimeout(record.cleanupTimeout);
  if (pendingRequests.get(record.pendingKey) === record) {
    pendingRequests.delete(record.pendingKey);
  }
};

const abort = (record: TrackedRequest) => {
  forget(record);
  record.controller.abort(CANCELATION_MESSAGE);
};

/**
 * The response with a body that reports when it is done - fully read, errored (e.g. aborted) or cancelled by every
 * reader - so the request is forgotten then rather than held.
 */
const monitorBody = (response: Response, onDone: () => void): Response => {
  if (!response.body) {
    onDone();
    return response;
  }
  const reader = response.body.getReader();
  let done = false;
  const finish = () => {
    if (!done) {
      done = true;
      onDone();
    }
  };
  const body = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          finish();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
        finish();
      }
    },
    cancel: (reason) => {
      finish();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
};

/** One response per joined caller: clones of the monitored response plus the response itself. */
const distribute = (response: Response, count: number): Response[] => [
  ...Array.from({ length: count - 1 }, () => response.clone()),
  response,
];

const isCancellation = (error: Error) => error.name === 'AbortError' || error.message === CANCELATION_MESSAGE;

const settle = async (record: TrackedRequest, request: URL | Request): Promise<Response[]> => {
  let response: Response;
  try {
    // NOTE: fetch returns after headers received, not the body
    response = await fetch(request, { signal: record.controller.signal });
  } catch (error: unknown) {
    forget(record);
    const standardError = error instanceof Error ? error : new Error(String(error));
    if (isCancellation(standardError)) {
      // dummy response avoids network errors in the console for these requests
      return distribute(new Response(undefined, { status: 204 }), record.joiners);
    }
    throw standardError;
  }

  // Settled: stop sharing it. No caller can join from here on, so `joiners` is final.
  if (pendingRequests.get(record.pendingKey) === record) {
    pendingRequests.delete(record.pendingKey);
  }
  if (activeRequests.has(record)) {
    // Safety net: a body nobody reads is not held forever.
    record.cleanupTimeout = setTimeout(() => forget(record), CLEANUP_TIMEOUT_MS);
  }
  return distribute(
    monitorBody(response, () => forget(record)),
    record.joiners,
  );
};

export const handleFetch = async (request: URL | Request, clientId = ''): Promise<Response> => {
  const pendingKey = getPendingKey(request);
  const existing = pendingRequests.get(pendingKey);

  if (existing) {
    existing.consumers.set(clientId, (existing.consumers.get(clientId) ?? 0) + 1);
    const index = existing.joiners++;
    return existing.promise.then((responses) => responses[index]);
  }

  const record: TrackedRequest = {
    url: getRequestKey(request),
    pendingKey,
    controller: new AbortController(),
    consumers: new Map([[clientId, 1]]),
    joiners: 1,
    promise: undefined as unknown as Promise<Response[]>,
  };
  pendingRequests.set(pendingKey, record);
  activeRequests.add(record);
  record.promise = settle(record, request);

  return record.promise.then((responses) => responses[0]);
};

/**
 * A consumer in `clientId` no longer wants `url` (an image unmounted before it loaded). Only requests still in flight
 * or still downloading their body are affected, and only those holding a reference from that client - references of
 * the consumers that joined that request while it was in flight. One reference is released; the request (headers or
 * body) is aborted when its last consumer is gone. A request started after the canceller's own request settled holds no
 * reference of the canceller, except from the same tab, where the page sends a cancel only for its last unsettled
 * consumer of the URL (see ImageRequestLedger), so a stale consumer never cancels a fresh one.
 */
export const handleCancel = (url: URL, clientId = '') => {
  const requestKey = getRequestKey(url);

  for (const record of activeRequests) {
    const references = record.consumers.get(clientId) ?? 0;
    if (record.url !== requestKey || references === 0) {
      continue;
    }
    if (references > 1) {
      record.consumers.set(clientId, references - 1);
      continue;
    }
    record.consumers.delete(clientId);
    if (record.consumers.size === 0) {
      abort(record);
    }
  }
};

/**
 * Fork (R50): authorization boundary (logout, session deleted or locked, end of elevation, lock/unlock, reveal-set
 * change - from any tab, the worker is shared by every client of the origin): abort and forget every request.
 */
export const handlePurge = () => {
  for (const record of activeRequests) {
    abort(record);
  }
  pendingRequests.clear();
  activeRequests.clear();
};
