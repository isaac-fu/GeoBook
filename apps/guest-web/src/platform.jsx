import { AccountEmailPage } from './AccountEmail.jsx';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionProvider, useSession, Gate, useResource, Status, hotelLink } from './client.jsx';
import Home from './Home.jsx';
import HotelProfile from './HotelProfile.jsx';
import TravelSearch from './TravelSearch.jsx';
import { MyBookings, SavedHotels, Account, Notifications } from './GuestPages.jsx';
import { HotelPortal, AdminPortal } from './Management.jsx';
import { CatalogAttribution } from './HotelPrice.jsx';
import './style.css';
import './home.css';
import './profile.css';
import './platform.css';

function portalUrl(portal) { const port = import.meta.env.DEV ? { guest: 5173, hotel: 5174, admin: 5175 }[portal] : { guest: 8080, hotel: 8081, admin: 8082 }[portal]; return `${location.protocol}//${location.hostname}:${port}/`; }
function Header({ portal }) {
  const { user, ready, login, logout } = useSession(); const [error, setError] = useState('');
  return <><header className="site-header"><a className="brand" href="#/">◎ GeoBook{portal !== 'guest' && <small> {portal}</small>}</a><nav aria-label="Main navigation"><a href={portal === 'guest' ? '#/' : portalUrl('guest')}>Find stays</a>{portal === 'guest' && <><a href="#/saved">Saved</a><a href="#/bookings">My bookings</a></>}<a href="#/notifications">Updates</a>{portal === 'guest' && <a href={portalUrl('hotel')}>List your property</a>}{user?.role === 'admin' && <a href={portalUrl('admin')}>Admin</a>}</nav><div className="account-nav">{user ? <><a href="#/account">{user.name}</a><button onClick={() => logout().catch(e => setError(e.message))}>Sign out</button></> : <button disabled={!ready} className="explore-button" onClick={login}>Sign in / Register</button>}</div></header>{error && <p className="error">{error}</p>}</>;
}
function TravelPage({ id }) { const state = useResource('/hotels/' + encodeURIComponent(id)); return <><Status state={state}/>{state.data && <TravelSearch hotel={state.data} onBack={() => { location.hash = hotelLink(id); }}/>}</>; }
function App({ portal }) {
  const [hash, setHash] = useState(location.hash || '#/');
  useEffect(() => { const change = () => { setHash(location.hash || '#/'); window.scrollTo(0,0); }; window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, []);
  let parts; try { parts = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent); } catch { parts = ['missing']; }
  const page = parts[0]; let content;
  if (['forgot-password', 'reset-password', 'verify-email'].includes(page)) content = <AccountEmailPage key={hash} action={page} token={parts[1]}/>;
  else if (page === 'account') content = <Gate><Account/></Gate>;
  else if (page === 'notifications') content = <Gate><Notifications/></Gate>;
  else if (portal === 'hotel') content = <Gate roles={['hotel','admin']}><HotelPortal/></Gate>;
  else if (portal === 'admin') content = <Gate roles={['admin']}><AdminPortal/></Gate>;
  else if (page === 'bookings') content = <Gate><MyBookings/></Gate>;
  else if (page === 'saved') content = <Gate><SavedHotels/></Gate>;
  else if (page === 'hotels' && parts[1]) content = parts[2] === 'travel' ? <TravelPage key={parts[1]} id={parts[1]}/> : <HotelProfile key={parts[1]} id={parts[1]}/>;
  else if (page) content = <p className="empty-panel">Page not found. <a href="#/">Return home</a></p>;
  return <><Header portal={portal}/><main className={portal === 'guest' ? 'guest-main' : 'portal-main'}>{portal === 'guest' && <div hidden={!!page}><Home/></div>}{content}</main><footer><span>GeoBook · Discovery and demo reservations</span><CatalogAttribution/></footer></>;
}
export function mount(portal) { createRoot(document.getElementById('root')).render(<SessionProvider portal={portal}><App portal={portal}/></SessionProvider>); }
