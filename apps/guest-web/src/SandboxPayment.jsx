import React, { useEffect, useState } from 'react';
import { api, today } from './client.jsx';

export default function SandboxPayment({ booking, reload }) {
  const [enabled, setEnabled] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { api('/payments/config').then(r => setEnabled(r.enabled)).catch(() => {}); }, []);
  async function checkout() {
    setBusy(true); setError('');
    try {
      const result = await api(`/bookings/${booking.id}/checkout`, { method: 'POST' });
      if (result.url) location.assign(result.url); else reload();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  if (!enabled && !booking.payment_status) return null;
  return <section className="notice"><strong>Sandbox payment</strong><p>No real money is charged. This is an optional payment test for your existing demo reservation.</p>
    <p>Status: {booking.payment_status || 'Not started'}</p>
    {enabled && booking.demo && booking.status === 'confirmed' && booking.check_in > today() && (!booking.payment_status || booking.payment_status === 'pending') && <button disabled={busy} onClick={checkout}>{busy ? 'Opening…' : 'Open Stripe test checkout'}</button>}
    {booking.payment_status === 'expired' && <p>This test checkout expired. The demo reservation remains confirmed; cancel and create a new reservation to test again.</p>}
    <button disabled={busy} onClick={reload}>Refresh payment status</button>
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
