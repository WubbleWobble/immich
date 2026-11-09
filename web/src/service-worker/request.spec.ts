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

/** A response body the test feeds chunk by chunk; it errors when the request is aborted, like a network body. */
const streamingBody = (signal: AbortSignal) => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start: (streamController) => {
      controller = streamController;
      signal.addEventListener('abort', () => streamController.error(signal.reason));
    },
  });
  return { stream, push: (text: string) => controller.enqueue(new TextEncoder().encode(text)) };
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

  describe('byte-range requests bypass sharing', () => {
    const originalUrl = url.replace('thumbnail?size=preview', 'original');
    const bytes = 'ABCDEFGH';
    /** The server's partial response for `range` (`bytes=start-end`) of the 8-byte original. */
    const partial = (range: string) => {
      const [start, end] = range.replace('bytes=', '').split('-').map(Number);
      return new Response(bytes.slice(start, end + 1), {
        status: 206,
        headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` },
      });
    };
    const ranged = (range: string, headers: Record<string, string> = {}) =>
      new Request(originalUrl, { headers: { Range: range, ...headers } });

    it('simultaneous different ranges each get their own network request and bytes', async () => {
      const { fetchMock, calls } = controlledFetch();

      const head = handleFetch(ranged('bytes=0-3'));
      const tail = handleFetch(ranged('bytes=4-7'));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(calls.map(({ request }) => request.headers.get('range'))).toEqual(['bytes=0-3', 'bytes=4-7']);

      calls[0].release(partial('bytes=0-3'));
      calls[1].release(partial('bytes=4-7'));
      const [headResponse, tailResponse] = await Promise.all([head, tail]);
      expect(headResponse.headers.get('content-range')).toBe('bytes 0-3/8');
      expect(tailResponse.headers.get('content-range')).toBe('bytes 4-7/8');
      await expect(headResponse.text()).resolves.toBe('ABCD');
      await expect(tailResponse.text()).resolves.toBe('EFGH');
    });

    it('a ranged and a full request for the same URL are not shared, in either order', async () => {
      const { fetchMock, calls } = controlledFetch();

      const full = handleFetch(new Request(originalUrl));
      const range = handleFetch(ranged('bytes=4-7'));
      const conditional = handleFetch(new Request(originalUrl, { headers: { 'If-Range': '"etag"' } }));
      const fullAgain = handleFetch(new Request(originalUrl));
      // the second full request still joins the first; the ranged and conditional-range ones go to the network
      expect(fetchMock).toHaveBeenCalledTimes(3);

      calls[0].release(new Response(bytes, { status: 200 }));
      calls[1].release(partial('bytes=4-7'));
      calls[2].release(new Response(bytes, { status: 200 }));
      await expect(textOf(full)).resolves.toBe(bytes);
      await expect(textOf(fullAgain)).resolves.toBe(bytes);
      await expect(range).resolves.toMatchObject({ status: 206 });
      await expect(textOf(range)).resolves.toBe('EFGH');
      await expect(textOf(conditional)).resolves.toBe(bytes);

      // a ranged request in flight is not joined by a later full request either
      const laterRange = handleFetch(ranged('bytes=0-3'));
      const laterFull = handleFetch(new Request(originalUrl));
      expect(fetchMock).toHaveBeenCalledTimes(5);
      calls[3].release(partial('bytes=0-3'));
      calls[4].release(new Response(bytes, { status: 200 }));
      await expect(textOf(laterRange)).resolves.toBe('ABCD');
      await expect(textOf(laterFull)).resolves.toBe(bytes);
    });

    it('a purge still aborts an in-flight ranged request, headers pending or body streaming', async () => {
      const { calls } = controlledFetch();

      const pending = handleFetch(ranged('bytes=0-3'));
      const streaming = handleFetch(ranged('bytes=4-7'));
      const { stream } = streamingBody(calls[1].signal);
      calls[1].release(new Response(stream, { status: 206 }));
      await streaming;

      handlePurge();
      expect(calls.map(({ signal }) => signal.aborted)).toEqual([true, true]);
      await expect(pending).resolves.toMatchObject({ status: 204 });
    });

    it('a cancel from its last consumer still aborts a ranged request', async () => {
      const { calls } = controlledFetch();

      const pending = handleFetch(ranged('bytes=0-3'), 'tab-a');
      handleCancel(new URL(originalUrl), 'tab-a');

      expect(calls[0].signal.aborted).toBe(true);
      await expect(pending).resolves.toMatchObject({ status: 204 });
    });
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

  describe('cancel (reference-counted per in-flight request)', () => {
    it("never affects a request started after the cancelling consumer's request settled", async () => {
      const { calls } = controlledFetch();

      const old = handleFetch(new Request(url), 'tab-a');
      calls[0].release(new Response('old', { status: 200 }));
      await expect(textOf(old)).resolves.toBe('old');

      const fresh = handleFetch(new Request(url), 'tab-b');
      // the old consumer unmounts late
      handleCancel(new URL(url), 'tab-a');

      expect(calls[1].signal.aborted).toBe(false);
      calls[1].release(new Response('fresh', { status: 200 }));
      await expect(textOf(fresh)).resolves.toBe('fresh');
    });

    it('two consumers in flight, one cancels: the request continues for the other', async () => {
      const { fetchMock, calls } = controlledFetch();

      handleFetch(new Request(url), 'tab-a').catch(() => {});
      const other = handleFetch(new Request(url), 'tab-b');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      handleCancel(new URL(url), 'tab-a');
      expect(calls[0].signal.aborted).toBe(false);

      calls[0].release(new Response('bytes', { status: 200 }));
      await expect(textOf(other)).resolves.toBe('bytes');
    });

    it('two consumers of one tab: each cancel releases one reference', async () => {
      const { calls } = controlledFetch();

      const first = handleFetch(new Request(url), 'tab-a');
      const second = handleFetch(new Request(url), 'tab-a');

      handleCancel(new URL(url), 'tab-a');
      expect(calls[0].signal.aborted).toBe(false);
      handleCancel(new URL(url), 'tab-a');
      expect(calls[0].signal.aborted).toBe(true);
      await expect(first).resolves.toMatchObject({ status: 204 });
      await expect(second).resolves.toMatchObject({ status: 204 });
    });

    it('the last consumer cancelling aborts the request', async () => {
      const { calls } = controlledFetch();

      const first = handleFetch(new Request(url), 'tab-a');
      const second = handleFetch(new Request(url), 'tab-b');
      handleCancel(new URL(url), 'tab-a');
      handleCancel(new URL(url), 'tab-b');

      expect(calls[0].signal.aborted).toBe(true);
      await expect(first).resolves.toMatchObject({ status: 204 });
      await expect(second).resolves.toMatchObject({ status: 204 });
    });

    it('a cancel from a client with no consumer, or after the body completed, aborts nothing', async () => {
      const { calls } = controlledFetch();

      const pending = handleFetch(new Request(url), 'tab-a');
      handleCancel(new URL(url), 'tab-z');
      expect(calls[0].signal.aborted).toBe(false);

      calls[0].release(new Response('bytes', { status: 200 }));
      await expect(textOf(pending)).resolves.toBe('bytes');
      handleCancel(new URL(url), 'tab-a');
      expect(calls[0].signal.aborted).toBe(false);
    });

    it('cancel after the headers arrived still aborts the body download once the last consumer is gone', async () => {
      const { calls } = controlledFetch();

      const first = handleFetch(new Request(url), 'tab-a');
      const second = handleFetch(new Request(url), 'tab-b');
      const body = streamingBody(calls[0].signal);
      calls[0].release(new Response(body.stream, { status: 200 }));
      const [a, b] = await Promise.all([first, second]);
      body.push('first chunk');

      // one consumer goes away mid-download: the other keeps receiving bytes
      handleCancel(new URL(url), 'tab-a');
      expect(calls[0].signal.aborted).toBe(false);
      const reader = b.body!.getReader();
      await expect(reader.read()).resolves.toMatchObject({ done: false });

      // the last one goes away: the download is aborted
      handleCancel(new URL(url), 'tab-b');
      expect(calls[0].signal.aborted).toBe(true);
      await expect(reader.read()).rejects.toBeDefined();
      void a.body?.cancel().catch(() => {});
    });

    it('a stale consumer still cannot abort the download of a request started after its own settled', async () => {
      const { calls } = controlledFetch();

      const old = handleFetch(new Request(url), 'tab-a');
      calls[0].release(new Response('old', { status: 200 }));
      await expect(textOf(old)).resolves.toBe('old');

      const fresh = handleFetch(new Request(url), 'tab-b');
      const body = streamingBody(calls[1].signal);
      calls[1].release(new Response(body.stream, { status: 200 }));
      await fresh;

      handleCancel(new URL(url), 'tab-a');
      expect(calls[1].signal.aborted).toBe(false);
    });

    it('a completed download is forgotten: neither cancel nor purge touches it', async () => {
      const { calls } = controlledFetch();

      const pending = handleFetch(new Request(url), 'tab-a');
      calls[0].release(new Response('all bytes', { status: 200 }));
      await expect(textOf(pending)).resolves.toBe('all bytes');

      handleCancel(new URL(url), 'tab-a');
      handlePurge();
      expect(calls[0].signal.aborted).toBe(false);
    });

    it('releases the consumer in every credential variant of the URL', async () => {
      const { calls } = controlledFetch();

      const first = handleFetch(new Request(url, { headers: { Authorization: 'Bearer a' } }), 'tab-a');
      const second = handleFetch(new Request(url, { headers: { Authorization: 'Bearer b' } }), 'tab-a');
      handleCancel(new URL(url), 'tab-a');

      expect(calls.map(({ signal }) => signal.aborted)).toEqual([true, true]);
      await expect(first).resolves.toMatchObject({ status: 204 });
      await expect(second).resolves.toMatchObject({ status: 204 });
    });

    it('the cancel message is matched to the sending client', async () => {
      const { calls } = controlledFetch();
      installMessageListener();

      const pending = handleFetch(new Request(url), 'tab-a');
      dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'cancel', url },
          source: { id: 'tab-b' } as unknown as MessagePort,
        }),
      );
      expect(calls[0].signal.aborted).toBe(false);
      dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'cancel', url },
          source: { id: 'tab-a' } as unknown as MessagePort,
        }),
      );
      expect(calls[0].signal.aborted).toBe(true);
      await expect(pending).resolves.toMatchObject({ status: 204 });
    });
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
