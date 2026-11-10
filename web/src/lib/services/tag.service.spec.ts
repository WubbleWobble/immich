import { defaults } from '@immich/sdk';
import { modalManager, toastManager } from '@immich/ui';
import { eventManager } from '$lib/managers/event-manager.svelte';
import PinPromptModal from '$lib/modals/PinPromptModal.svelte';
import { getTagActions } from '$lib/services/tag.service';
import type { TreeNode } from '$lib/utils/tree-utils';

vi.mock('@immich/ui', async (importOriginal) => {
  const original = await importOriginal<typeof import('@immich/ui')>();
  return {
    ...original,
    modalManager: { show: vi.fn(), showDialog: vi.fn() },
    toastManager: { primary: vi.fn(), danger: vi.fn(), warning: vi.fn(), info: vi.fn() },
  };
});

vi.mock('$lib/utils/i18n', () => ({
  getFormatter: vi.fn().mockResolvedValue((key: string) => key),
  getPreferredLocale: vi.fn(),
}));

const $t = ((key: string) => key) as never;
const tag = { id: 'tag-1', value: 'Holiday', path: 'Holiday' } as TreeNode;

const elevationRequired = () =>
  Response.json({ message: 'Elevated permission is required', statusCode: 401 }, { status: 401 });

describe('tag delete (lock-sensitive write)', () => {
  const fetch = vi.fn<typeof globalThis.fetch>();

  beforeEach(() => {
    vi.clearAllMocks();
    fetch.mockReset();
    defaults.fetch = fetch;
    vi.mocked(modalManager.showDialog).mockResolvedValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    delete defaults.fetch;
  });

  it('asks for the PIN when the server refuses, then deletes the tag on the retry', async () => {
    fetch.mockResolvedValueOnce(elevationRequired()).mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.mocked(modalManager.show).mockResolvedValue(true as never);
    const emit = vi.spyOn(eventManager, 'emit');

    await getTagActions($t, tag).Delete.onAction?.(undefined as never);

    expect(modalManager.show).toHaveBeenCalledExactlyOnceWith(PinPromptModal, {});
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith('TagDelete', tag);
    expect(toastManager.danger).not.toHaveBeenCalled();
  });

  it('keeps the tag and shows no error when the PIN prompt is cancelled', async () => {
    fetch.mockResolvedValueOnce(elevationRequired());
    vi.mocked(modalManager.show).mockResolvedValue(undefined as never);
    const emit = vi.spyOn(eventManager, 'emit');

    await getTagActions($t, tag).Delete.onAction?.(undefined as never);

    expect(fetch).toHaveBeenCalledOnce();
    expect(emit).not.toHaveBeenCalledWith('TagDelete', expect.anything());
    expect(toastManager.danger).not.toHaveBeenCalled();
  });
});
