import { deleteTag, mergePeople } from '@immich/sdk';
import { modalManager, toastManager } from '@immich/ui';
import PinPromptModal from '$lib/modals/PinPromptModal.svelte';
import { handleError } from '$lib/utils/handle-error';
import { isElevationRequiredError, withElevationRetry } from '$lib/utils/elevation';

vi.mock('@immich/ui', async (importOriginal) => {
  const original = await importOriginal<typeof import('@immich/ui')>();
  return {
    ...original,
    modalManager: { show: vi.fn(), showDialog: vi.fn() },
    toastManager: { primary: vi.fn(), danger: vi.fn(), warning: vi.fn(), info: vi.fn() },
  };
});

// Real SDK calls against a fake fetch, so the errors are the HttpErrors the SDK really throws: a void endpoint
// (deleteTag) surfaces the body as text, a JSON one (mergePeople) as parsed JSON.
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const elevationRequired = () =>
  json(401, { message: 'Elevated permission is required', error: 'Unauthorized', statusCode: 401 });
const noContent = () => new Response(null, { status: 204 });

const fakeFetch = (...responses: Array<() => Response>) => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) {
    fetch.mockResolvedValueOnce(response());
  }
  return fetch;
};

describe('isElevationRequiredError', () => {
  it('recognises the elevation-required 401 from text and JSON endpoints', async () => {
    const textError = await deleteTag({ id: 'tag-1' }, { fetch: fakeFetch(elevationRequired) }).catch((e) => e);
    const jsonError = await mergePeople(
      { mergePersonDto: { ids: ['a', 'b'] } },
      { fetch: fakeFetch(elevationRequired) },
    ).catch((e) => e);
    expect(isElevationRequiredError(textError)).toBe(true);
    expect(isElevationRequiredError(jsonError)).toBe(true);
  });

  it('ignores other 401s, other statuses with the same message, and non-HTTP errors', async () => {
    const otherUnauthorized = await deleteTag(
      { id: 'tag-1' },
      { fetch: fakeFetch(() => json(401, { message: 'Invalid user token', statusCode: 401 })) },
    ).catch((e) => e);
    const forbidden = await deleteTag(
      { id: 'tag-1' },
      { fetch: fakeFetch(() => json(403, { message: 'Elevated permission is required', statusCode: 403 })) },
    ).catch((e) => e);
    expect(isElevationRequiredError(otherUnauthorized)).toBe(false);
    expect(isElevationRequiredError(forbidden)).toBe(false);
    expect(isElevationRequiredError(new Error('Elevated permission is required'))).toBe(false);
    expect(isElevationRequiredError(undefined)).toBe(false);
  });
});

describe('withElevationRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('does not prompt when the action succeeds', async () => {
    const fetch = fakeFetch(noContent);
    await withElevationRetry(() => deleteTag({ id: 'tag-1' }, { fetch }));
    expect(fetch).toHaveBeenCalledOnce();
    expect(modalManager.show).not.toHaveBeenCalled();
  });

  it('prompts for the PIN after the refusal and retries once when it is accepted', async () => {
    vi.mocked(modalManager.show).mockResolvedValue(true);
    const fetch = fakeFetch(elevationRequired, () => json(200, [{ id: 'b', success: true }]));

    const result = await withElevationRetry(() => mergePeople({ mergePersonDto: { ids: ['a', 'b'] } }, { fetch }));

    expect(result).toEqual([{ id: 'b', success: true }]);
    expect(modalManager.show).toHaveBeenCalledExactlyOnceWith(PinPromptModal, {});
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries only once: a second refusal is thrown to the caller', async () => {
    vi.mocked(modalManager.show).mockResolvedValue(true);
    const fetch = fakeFetch(elevationRequired, elevationRequired);

    const error = await withElevationRetry(() => deleteTag({ id: 'tag-1' }, { fetch })).catch((e) => e);

    expect(isElevationRequiredError(error)).toBe(true);
    expect(modalManager.show).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('aborts quietly when the PIN prompt is cancelled: no retry and no error toast', async () => {
    vi.mocked(modalManager.show).mockResolvedValue(undefined);
    const fetch = fakeFetch(elevationRequired);

    // The call sites route failures through handleError; a cancelled prompt must not toast there.
    const error = await withElevationRetry(() => deleteTag({ id: 'tag-1' }, { fetch })).catch((e) => e);
    handleError(error, 'something went wrong');

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('AbortError');
    expect(fetch).toHaveBeenCalledOnce();
    expect(toastManager.danger).not.toHaveBeenCalled();
  });

  it('passes any other error through unchanged, without prompting', async () => {
    const fetch = fakeFetch(() => json(400, { message: 'Tag not found', statusCode: 400 }));
    let thrown: unknown;
    const action = () =>
      deleteTag({ id: 'tag-1' }, { fetch }).catch((error: unknown) => {
        thrown = error;
        throw error;
      });

    const error = await withElevationRetry(action).catch((e) => e);
    expect(error).toBe(thrown);
    expect(error.status).toBe(400);
    expect(fetch).toHaveBeenCalledOnce();
    expect(modalManager.show).not.toHaveBeenCalled();

    const plain = new Error('boom');
    await expect(withElevationRetry(() => Promise.reject(plain))).rejects.toBe(plain);
    expect(modalManager.show).not.toHaveBeenCalled();
  });
});
