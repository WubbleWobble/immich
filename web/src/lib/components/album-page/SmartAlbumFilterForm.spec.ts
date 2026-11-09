import type { SmartAlbumFilter } from '@immich/sdk';
import { tick } from 'svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { getVisualViewportMock } from '$lib/__mocks__/visual-viewport.mock';
import SmartAlbumFilterForm from '$lib/components/album-page/SmartAlbumFilterForm.svelte';
import { mergeSmartAlbumFilter, smartAlbumFilterToSearchFilter } from '$lib/utils/smart-album-filter';
import { renderWithTooltips } from '$tests/helpers';

describe('SmartAlbumFilterForm component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('visualViewport', getVisualViewportMock());
    // no suggestion lists anything: every stored location/camera value is "unlisted"
    sdkMock.getSearchSuggestions.mockResolvedValue([]);
    sdkMock.getAllPeople.mockResolvedValue({ people: [], total: 0, hidden: 0, hasNextPage: false });
    sdkMock.getAllTags.mockResolvedValue([]);
  });

  it('keeps stored location and camera values that no suggestion lists (keepUnlisted)', async () => {
    const stored: SmartAlbumFilter = { city: null, make: 'X' };
    const filter = smartAlbumFilterToSearchFilter(stored);

    renderWithTooltips(SmartAlbumFilterForm, { formId: 'form', name: 'Album', filter });
    await vi.waitFor(() => expect(sdkMock.getSearchSuggestions).toHaveBeenCalled());
    await tick();
    await tick();

    // opening and saving the editor must not change the stored filter on its own
    expect(mergeSmartAlbumFilter(stored, filter)).toEqual(stored);
  });
});
