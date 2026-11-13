import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxStripe, validateSession } from '../src/payments.ts';

test('sandbox provider rejects live and restricted live keys', () => {
  for (const key of ['sk_live_example', 'rk_live_example', 'anything']) assert.throws(() => sandboxStripe(key));
});
test('payment settlement validates mode, amount, currency and reservation', () => {
  const booking = { id: 'booking', total_cents: 10000, currency: 'USD' };
  const session = { livemode: false, mode: 'payment', client_reference_id: 'booking', amount_total: 10000, currency: 'usd' };
  assert.doesNotThrow(() => validateSession(session as any, booking));
  for (const change of [{ livemode: true }, { mode: 'subscription' }, { client_reference_id: 'other' }, { amount_total: 9999 }, { currency: 'eur' }]) {
    assert.throws(() => validateSession({ ...session, ...change } as any, booking));
  }
});
