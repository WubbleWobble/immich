import { installMessageListener } from './messaging';
import { handleCancel, handleFetch, handlePurge } from './request';

const url = 'https://immich.invalid/api/assets/11111111-1111-4111-8111-111111111111/thumbnail?size=preview';

const deferred = () => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => (resolve = done));
  return { promise, resolve };
};

const textOf = async (pending: Promise<Response>) => {
  const response = await pending;
  return response.text();
};

/** A fetch whose responses the test releases one by one, recording each request's abort signal. */
const controlledFetch = () => {
  const calls: { request: Request; signal: AbortSignal; release: (response: Response) => void }[] = [];
  const fetchMock = vi.fn((request: Request, { signal }: { signal: AbortSignal }) => {
    const { promise, resolve } = deferred();
    calls.push({ request, signal, release: resolve });
    return new Promise<Response>((done, fail) => {
      signal.addEventListener('abort', () => fail(signal.reason));
      void promise.then(done);
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
};

describe('service worker asset requests (R50)', () => {
  afterEach(() => {
    handlePurge();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('never hands a completed response to a later request: the network is asked again', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('privileged photo bytes', { status: 200 }))
      .mockResolvedValue(new Response('access denied', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const before = await handleFetch(new Request(url, { headers: { Authorization: 'Bearer elevated' } }));
    expect(await before.text()).toBe('privileged photo bytes');

    // permission changes (re-hidden, elevation ended, other credentials) - the same URL must be re-authorized
    const after = await handleFetch(new Request(url, { headers: { Authorization: 'Bearer ordinary' } }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(after.status).toBe(400);
    expect(await after.text()).toBe('access denied');
  });

  it('still deduplicates concurrent in-flight requests for one URL', async () => {
    const { fetchMock, calls } = controlledFetch();

    const first = handleFetch(new Request(url));
    const second = handleFetch(new Request(url));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    calls[0].release(new Response('bytes', { status: 200 }));
    await expect(textOf(first)).resolves.toBe('bytes');
    await expect(textOf(second)).resolves.toBe('bytes');

    // settled: the next request goes to the network
    const third = handleFetch(new Request(url));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    calls[1].release(new Response('fresh', { status: 200 }));
    await expect(textOf(third)).resolves.toBe('fresh');
  });

  it('does not share an in-flight request between different explicit credentials', async () => {
    const { fetchMock, calls } = controlledFetch();

    const elevated = handleFetch(new Request(url, { headers: { Authorization: 'Bearer elevated' } }));
    const ordinary = handleFetch(new Request(url, { headers: { Authorization: 'Bearer ordinary' } }));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    calls[0].release(new Response('privileged photo bytes', { status: 200 }));
    calls[1].release(new Response('access denied', { status: 400 }));
    await expect(textOf(elevated)).resolves.toBe('privileged photo bytes');
    await expect(textOf(ordinary)).resolves.toBe('access denied');
  });

  it('cancel aborts every in-flight request for the URL', async () => {
    const { calls } = controlledFetch();

    const first = handleFetch(new Request(url, { headers: { Authorization: 'Bearer a' } }));
    const second = handleFetch(new Request(url, { headers: { Authorization: 'Bearer b' } }));
    handleCancel(new URL(url));

    expect(calls.map(({ signal }) => signal.aborted)).toEqual([true, true]);
    await expect(first).resolves.toMatchObject({ status: 204 });
    await expect(second).resolves.toMatchObject({ status: 204 });
  });

  it('a failed request is not reused either', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(handleFetch(new Request(url))).rejects.toThrow('network down');
    await expect(textOf(handleFetch(new Request(url)))).resolves.toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a purge aborts every pending request and forgets it', async () => {
    const { fetchMock, calls } = controlledFetch();
    const otherUrl = url.replace('thumbnail?size=preview', 'original');

    const pending = handleFetch(new Request(url));
    const otherPending = handleFetch(new Request(otherUrl));

    handlePurge();

    expect(calls.map(({ signal }) => signal.aborted)).toEqual([true, true]);
    // the aborted callers get the empty cancellation response, never bytes
    await expect(pending).resolves.toMatchObject({ status: 204 });
    await expect(otherPending).resolves.toMatchObject({ status: 204 });

    // the next request for the same URL is a new network request
    const next = handleFetch(new Request(url));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    calls[2].release(new Response('after purge', { status: 200 }));
    await expect(textOf(next)).resolves.toBe('after purge');
  });

  it('a purge also aborts a response whose body is still streaming', async () => {
    const { calls } = controlledFetch();

    const pending = handleFetch(new Request(url));
    calls[0].release(new Response('streaming', { status: 200 }));
    await pending;

    handlePurge();
    expect(calls[0].signal.aborted).toBe(true);
  });

  it('cancel still aborts a single pending request', async () => {
    const { calls } = controlledFetch();

    const pending = handleFetch(new Request(url));
    handleCancel(new URL(url));

    expect(calls[0].signal.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ status: 204 });
  });

  it('accepts a purge message from any client (one purge covers every tab)', async () => {
    const { calls } = controlledFetch();
    installMessageListener();

    const pending = handleFetch(new Request(url));
    // a message from another tab: the worker is shared by every client of the origin
    dispatchEvent(new MessageEvent('message', { data: { type: 'purge' } }));

    expect(calls[0].signal.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ status: 204 });
  });
});
