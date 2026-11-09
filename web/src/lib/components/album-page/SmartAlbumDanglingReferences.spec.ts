import { modalManager } from '@immich/ui';
import { fireEvent, render, screen } from '@testing-library/svelte';
import SmartAlbumDanglingReferences from '$lib/components/album-page/SmartAlbumDanglingReferences.svelte';

vi.mock('@immich/ui', async (importOriginal) => {
  const original = await importOriginal<typeof import('@immich/ui')>();
  return { ...original, modalManager: { ...original.modalManager, showDialog: vi.fn() } };
});

const references = { personIds: ['person-1'], tagIds: [] };

describe('SmartAlbumDanglingReferences component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('asks for confirmation before removing and does nothing when cancelled', async () => {
    vi.mocked(modalManager.showDialog).mockResolvedValue(false);
    const onRemove = vi.fn();
    render(SmartAlbumDanglingReferences, { references, onRemove });

    await fireEvent.click(screen.getByRole('button'));

    await vi.waitFor(() => expect(modalManager.showDialog).toHaveBeenCalledOnce());
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('removes the references once confirmed', async () => {
    vi.mocked(modalManager.showDialog).mockResolvedValue(true);
    const onRemove = vi.fn();
    render(SmartAlbumDanglingReferences, { references, onRemove });

    await fireEvent.click(screen.getByRole('button'));

    await vi.waitFor(() => expect(onRemove).toHaveBeenCalledWith(references));
    expect(modalManager.showDialog).toHaveBeenCalledOnce();
  });
});
