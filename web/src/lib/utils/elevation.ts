import { isHttpError } from '@immich/sdk';
import { modalManager } from '@immich/ui';
import PinPromptModal from '$lib/modals/PinPromptModal.svelte';
import { getServerErrorMessage } from '$lib/utils/handle-error';

/** The server's `requireElevatedPermission` refusal (401). */
const ELEVATION_REQUIRED_MESSAGE = 'Elevated permission is required';

/**
 * True only for the server's elevation-required refusal: HTTP 401 with exactly that message. Other 401s (expired
 * token, wrong PIN, ...) and anything that is not an SDK HttpError do not match. The body arrives as JSON or, for
 * endpoints without a response type, as text; getServerErrorMessage reads both.
 */
export const isElevationRequiredError = (error: unknown): boolean =>
  isHttpError(error) && error.status === 401 && getServerErrorMessage(error) === ELEVATION_REQUIRED_MESSAGE;

/**
 * Thrown when the user cancels the PIN prompt. Named 'AbortError' so handleError drops it silently: the call sites
 * keep their usual try/catch and a cancelled prompt shows no toast.
 */
export class ElevationCancelledError extends Error {
  override name = 'AbortError';

  constructor() {
    super('PIN prompt cancelled');
  }
}

/**
 * Run a lock-sensitive write (spec §8.5, ruling R73). If the server refuses it with the elevation-required 401,
 * prompt for the PIN and, once the session is elevated, run it again - once. A cancelled prompt throws
 * ElevationCancelledError; any other error passes through untouched.
 *
 * Deliberately reactive: nothing here looks at whether the user has a PIN or holds locks, so the UI is the same for
 * everyone until the server itself refuses.
 */
export async function withElevationRetry<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!isElevationRequiredError(error)) {
      throw error;
    }
  }

  const elevated = await modalManager.show(PinPromptModal, {});
  if (!elevated) {
    throw new ElevationCancelledError();
  }

  return action();
}
