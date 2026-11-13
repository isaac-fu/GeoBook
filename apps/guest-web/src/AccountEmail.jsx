import React, { useState } from 'react';
import { api, useSession } from './client.jsx';

export function VerificationStatus() {
  const { user } = useSession();
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  async function send() {
    setBusy(true); setError(''); setMessage('');
    try { setMessage((await api('/account/verification-email', { method: 'POST' })).message); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <section className="panel"><h2>Email verification</h2><p>{user.email}</p>
    {user.email_verified_at ? <p className="notice">Email verified</p> : <><p>Your email is not verified yet. Request a link and open it from your inbox.</p><button disabled={busy} onClick={send}>{busy ? 'Sending…' : 'Send verification email'}</button></>}
    {message && <p role="status">{message}</p>}{error && <p className="error" role="alert">{error}</p>}
  </section>;
}

export function AccountEmailPage({ action, token }) {
  const { setUser, login } = useSession();
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState(''), [done, setDone] = useState(false);
  const reset = action === 'reset-password', forgot = action === 'forgot-password';
  async function submit(e) {
    e.preventDefault(); const data = Object.fromEntries(new FormData(e.currentTarget));
    if (reset && data.newPassword !== data.confirmPassword) { setError('Passwords do not match.'); return; }
    setBusy(true); setError('');
    try {
      const response = await api('/auth/' + action, { method: 'POST', body: forgot ? { email: data.email } : { token, ...(reset ? { newPassword: data.newPassword } : {}) } });
      setMessage(forgot ? response.message : reset ? 'Your password has been reset. Sign in with your new password.' : 'Your email is now verified.');
      setDone(true);
      if (reset) setUser(null);
      else if (!forgot) { try { setUser((await api('/auth/me')).user); } catch {} }
      if (!forgot) history.replaceState(null, '', location.pathname + location.search + '#/' + action);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <section className="panel"><h1>{forgot ? 'Forgot your password?' : reset ? 'Reset your password' : 'Verify your email'}</h1>
    {error && <p className="error" role="alert">{error}</p>}{message && <p className="notice" role="status">{message}</p>}
    {!done && <form onSubmit={submit}><fieldset disabled={busy}>
      {forgot ? <label>Email<input name="email" type="email" autoComplete="email" required maxLength="254"/></label> : reset ? <><label>New password<input name="newPassword" type="password" autoComplete="new-password" minLength="12" maxLength="128" required/></label><label>Confirm new password<input name="confirmPassword" type="password" autoComplete="new-password" minLength="12" maxLength="128" required/></label><p>Use at least 12 characters. All existing sessions will be signed out.</p></> : <p>Confirm to verify the email address associated with this link.</p>}
      <button className="search" disabled={busy || (!forgot && !token)}>{busy ? 'Please wait…' : forgot ? 'Send reset link' : reset ? 'Reset password' : 'Verify email'}</button>
    </fieldset></form>}
    {!forgot && !token && !done && <p className="notice">Open the full link from your email, or request a new one.</p>}
    {done && !forgot && <button onClick={login}>Sign in</button>}
    {!forgot && <p><a href={reset ? '#/forgot-password' : '#/account'}>Request a new link</a></p>}
    <p><a href="#/">Return home</a></p>
  </section>;
}
