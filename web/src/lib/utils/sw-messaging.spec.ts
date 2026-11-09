import { ImageRequestLedger } from '$lib/utils/sw-messaging';

describe('ImageRequestLedger (page-side cancel reference counting)', () => {
  const url = '/api/assets/11111111-1111-4111-8111-111111111111/thumbnail';

  it('the last unsettled consumer cancelling sends one cancel', () => {
    const send = vi.fn();
    const ledger = new ImageRequestLedger(send);
    const first = ledger.track(url);
    const second = ledger.track(url);

    first.cancel();
    expect(send).not.toHaveBeenCalled();
    second.cancel();
    expect(send).toHaveBeenCalledExactlyOnceWith(url);
  });

  it('a consumer whose request settled never cancels another consumer of the same URL', () => {
    const send = vi.fn();
    const ledger = new ImageRequestLedger(send);
    const old = ledger.track(url);
    old.settle();
    const fresh = ledger.track(url);

    // the stale component unmounts after the fresh one started
    old.cancel();
    expect(send).not.toHaveBeenCalled();

    fresh.cancel();
    expect(send).toHaveBeenCalledExactlyOnceWith(url);
  });

  it('a consumer that settled sends nothing on cancel, and cancel is idempotent', () => {
    const send = vi.fn();
    const ledger = new ImageRequestLedger(send);
    const settled = ledger.track(url);
    settled.settle();
    settled.cancel();

    const cancelled = ledger.track(url);
    cancelled.cancel();
    cancelled.cancel();
    cancelled.settle();
    expect(send).toHaveBeenCalledExactlyOnceWith(url);
  });

  it('URLs are counted separately', () => {
    const send = vi.fn();
    const ledger = new ImageRequestLedger(send);
    const a = ledger.track(url);
    ledger.track(`${url}?size=preview`);

    a.cancel();
    expect(send).toHaveBeenCalledExactlyOnceWith(url);
  });
});
