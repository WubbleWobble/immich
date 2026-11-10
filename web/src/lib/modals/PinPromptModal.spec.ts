import { getAuthStatus, unlockAuthSession, type AuthStatusResponseDto } from '@immich/sdk';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import { lockManager } from '$lib/managers/lock-manager.svelte';
import PinPromptModal from '$lib/modals/PinPromptModal.svelte';
import { handleError } from '$lib/utils/handle-error';

vi.mock('@immich/sdk', async (importOriginal) => {
  const original = await importOriginal<typeof import('@immich/sdk')>();
  return { ...original, getAuthStatus: vi.fn(), unlockAuthSession: vi.fn() };
});

vi.mock('$lib/managers/lock-manager.svelte', () => ({
  lockManager: { onElevationAcquired: vi.fn(), refresh: vi.fn() },
}));

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

const authStatus = (pinCode: boolean) => ({ pinCode, password: true, isElevated: false }) as AuthStatusResponseDto;

// The PIN input is a password field (no textbox role); bits-ui marks it with this attribute.
const queryPinInput = () => document.querySelector<HTMLInputElement>('input[data-pin-input-input]');
const findPinInput = () =>
  waitFor(() => {
    const input = queryPinInput();
    expect(input).not.toBeNull();
    return input!;
  });

const enterPin = async (code: string) => {
  await userEvent.type(await findPinInput(), code);
};

describe('PinPromptModal', () => {
  const onClose = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    Element.prototype.animate = getAnimateMock();
    vi.mocked(lockManager.refresh).mockResolvedValue();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('shows neither the PIN input nor the create form until the PIN status arrives', async () => {
    let resolveStatus: (status: AuthStatusResponseDto) => void = () => {};
    vi.mocked(getAuthStatus).mockReturnValue(new Promise((resolve) => (resolveStatus = resolve)));

    render(PinPromptModal, { onClose });

    expect(await screen.findByText('pin_verification')).toBeInTheDocument();
    expect(queryPinInput()).toBeNull();
    expect(screen.queryByText('new_pin_code_subtitle')).not.toBeInTheDocument();

    resolveStatus(authStatus(true));
    expect(await screen.findByText('enter_your_pin_code_subtitle')).toBeInTheDocument();
  });

  it('elevates with the correct PIN and closes with true', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue(authStatus(true));
    vi.mocked(unlockAuthSession).mockResolvedValue('' as never);

    render(PinPromptModal, { onClose });
    await enterPin('123456');

    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    expect(unlockAuthSession).toHaveBeenCalledExactlyOnceWith({ sessionUnlockDto: { pinCode: '123456' } });
    expect(lockManager.onElevationAcquired).toHaveBeenCalledOnce();
    expect(lockManager.refresh).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('stays open after a wrong PIN, reporting it like the PIN page', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue(authStatus(true));
    const wrongPin = new Error('Wrong PIN code');
    vi.mocked(unlockAuthSession).mockRejectedValue(wrongPin);

    render(PinPromptModal, { onClose });
    await enterPin('000000');

    await waitFor(() => expect(handleError).toHaveBeenCalledWith(wrongPin, 'wrong_pin_code'));
    expect(onClose).not.toHaveBeenCalled();
    expect(lockManager.onElevationAcquired).not.toHaveBeenCalled();
    expect(queryPinInput()).not.toBeNull();
  });

  it('closes without elevating when cancelled', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue(authStatus(true));

    render(PinPromptModal, { onClose });
    await findPinInput();
    await userEvent.click(screen.getByRole('button', { name: 'cancel' }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose.mock.calls[0][0]).toBeFalsy();
    expect(unlockAuthSession).not.toHaveBeenCalled();
  });

  it('offers to create a PIN when none is set', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue(authStatus(false));

    render(PinPromptModal, { onClose });

    expect(await screen.findByText('new_pin_code_subtitle')).toBeInTheDocument();
    expect(screen.queryByText('enter_your_pin_code_subtitle')).not.toBeInTheDocument();
  });

  it('fails closed when the PIN status cannot be read: an error and only Cancel', async () => {
    vi.mocked(getAuthStatus).mockRejectedValue(new Error('network down'));

    render(PinPromptModal, { onClose });

    expect(await screen.findByRole('alert')).toHaveTextContent('errors.something_went_wrong');
    expect(queryPinInput()).toBeNull();
    expect(screen.queryByText('new_pin_code_subtitle')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalledWith(true);
    expect(unlockAuthSession).not.toHaveBeenCalled();
  });
});
