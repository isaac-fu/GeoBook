import React, { createContext, useContext, useEffect, useState } from 'react';

export async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', ...options,
    headers: { 'Content-Type': 'application/json', 'X-GeoBook-Request': '1', ...options.headers },
    ...(options.body && typeof options.body !== 'string' ? { body: JSON.stringify(options.body) } : {}),
  });
  const body = await response.json().catch(() => ({ error: 'The service is unavailable. Please try again.' }));
  if (!response.ok) { const error = new Error(body.error || 'Request failed.'); error.status = response.status; throw error; }
  return body;
}
export const money = (cents, currency = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(cents) / 100);
export const today = () => new Date().toISOString().slice(0, 10);
export const hotelLink = id => `#/hotels/${encodeURIComponent(id)}`;
const Context = createContext(null);
export const useSession = () => useContext(Context);
export function SessionProvider({ children, portal }) {
  const [user, setUser] = useState(null), [ready, setReady] = useState(false), [open, setOpen] = useState(false);
  const [register, setRegister] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { api('/auth/me').then(r => setUser(r.user)).catch(() => {}).finally(() => setReady(true)); }, []);
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    const data = Object.fromEntries(new FormData(e.currentTarget));
    if (register) data.role = portal === 'hotel' ? 'hotel' : 'guest';
    try { const result = await api(`/auth/${register ? 'register' : 'login'}`, { method: 'POST', body: data }); setUser(result.user); setOpen(false); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const login = () => { setError(''); setRegister(false); setOpen(true); };
  const logout = async () => { await api('/auth/logout', { method: 'POST' }); setUser(null); location.hash = '#/'; };
  return <Context.Provider value={{ user, setUser, ready, login, logout }}>{children}{open && <div className="dialog-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="auth-title" className="dialog"><button className="dialog-close" aria-label="Close sign-in" onClick={() => setOpen(false)}>×</button><p className="eyebrow">WELCOME TO GEOBOOK</p><h2 id="auth-title">{register ? 'Create your account' : 'Sign in to your account'}</h2><form onSubmit={submit}>{register && <label>Your name<input name="name" required minLength="2" maxLength="100" autoComplete="name"/></label>}<label>Email<input name="email" type="email" required autoComplete="email"/></label><label>Password<input name="password" type="password" required minLength="12" maxLength="128" autoComplete={register ? 'new-password' : 'current-password'}/></label><p className="muted">Use at least 12 characters.</p>{error && <p className="error" role="alert">{error}</p>}<button className="search" disabled={busy}>{busy ? 'Please wait…' : register ? 'Create account' : 'Sign in'}</button></form>{portal !== 'admin' && <button className="text-button" onClick={() => { setRegister(!register); setError(''); }}>{register ? 'Already registered? Sign in' : 'New here? Create an account'}</button>}</section></div>}</Context.Provider>;
}
export function Gate({ children, roles }) {
  const { user, ready, login } = useSession();
  if (!ready) return <p role="status">Loading your account…</p>;
  if (!user) return <section className="empty-panel"><h2>Sign in to continue</h2><p>Manage your stays and account in one place.</p><button className="explore-button" onClick={login}>Sign in or create an account</button></section>;
  if (roles && !roles.includes(user.role)) return <p className="notice">This portal requires a {roles.join(' or ')} account. You are signed in as {user.role}.</p>;
  return children;
}
export function useResource(path, revision = 0) {
  const [state, setState] = useState({ data: null, error: '', loading: true });
  const { user } = useSession();
  useEffect(() => {
    const controller = new AbortController(); setState({ data: null, error: '', loading: true });
    api(path, { signal: controller.signal }).then(r => { if (!controller.signal.aborted) setState({ data: r.data, error: '', loading: false }); })
      .catch(e => { if (!controller.signal.aborted) setState({ data: null, error: e.message, loading: false }); });
    return () => controller.abort();
  }, [path, revision, user?.id]);
  return state;
}
export function Status({ state }) { return state.loading ? <p role="status">Loading…</p> : state.error ? <p className="error" role="alert">{state.error}</p> : null; }
