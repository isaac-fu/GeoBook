import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxStripe, validateSession, refundBalance, checkoutUrl } from '../src/payments.ts';

test('sandbox provider rejects live and restricted live keys', () => {
  for (const key of ['sk_live_example', 'rk_live_example', 'anything']) assert.throws(() => sandboxStripe(key));
});
test('payment settlement validates mode, amount, currency and reservation', () => {
  const booking = { id: 'booking', total_cents: 10000, currency: 'USD' };
  const session = { livemode: false, mode: 'payment', client_reference_id: 'booking', amount_total: 10000, currency: 'usd' };
  assert.doesNotThrow(() => validateSession(session as any, booking));
  for (const change of [{ livemode: true }, { livemode: undefined }, { mode: 'subscription' }, { client_reference_id: 'other' }, { amount_total: 9999 }, { currency: 'eur' }]) {
    assert.throws(() => validateSession({ ...session, ...change } as any, booking));
  }
});

test('partial and manual refunds only count their actual successful amount', () => {
  const booking = { id: 'booking', total_cents: 10000, currency: 'USD' };
  const refund = { payment_intent: 'pi_test', currency: 'usd', amount: 2500, status: 'succeeded', metadata: { bookingId: 'booking' } };
  assert.equal(refundBalance([refund] as any, 'pi_test', booking), 7500);
  assert.equal(refundBalance([refund, { ...refund, amount: 7500, metadata: {} }] as any, 'pi_test', booking), 0);
  for (const change of [{ status: 'pending' }, { status: 'requires_action' }, { status: 'failed' }, { status: 'canceled' }, { currency: 'eur' }, { amount: 10001 }, { amount: -1 }, { payment_intent: 'other' }]) {
    assert.throws(() => refundBalance([{ ...refund, ...change }] as any, 'pi_test', booking));
  }
  assert.equal(refundBalance([{ ...refund, status: 'failed', metadata: {} }] as any, 'pi_test', booking), 10000);
});

test('checkout redirects are restricted to the hosted Stripe HTTPS destination', () => {
  assert.equal(checkoutUrl('https://checkout.stripe.com/c/pay/cs_test'), 'https://checkout.stripe.com/c/pay/cs_test');
  for (const url of [null, 'javascript:alert(1)', 'http://checkout.stripe.com/pay', 'https://checkout.stripe.com.attacker.test/', 'https://user:password@checkout.stripe.com/', 'https://checkout.stripe.com:8443/pay']) assert.throws(() => checkoutUrl(url));
});
