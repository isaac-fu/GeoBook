import React, { useEffect, useRef, useState } from 'react';
import HotelPrice from './HotelPrice.jsx';
import { api, hotelLink, today } from './client.jsx';
export default function Home() {
  const [query, setQuery] = useState(''), [result, setResult] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [filters, setFilters] = useState({ checkIn: '', checkOut: '', guests: 2, maxPrice: '', sort: 'name' });
  const [featured, setFeatured] = useState([]);
  const pending = useRef(null);
  useEffect(() => { const c = new AbortController(); api('/hotels?demo=true', { signal: c.signal }).then(r => setFeatured(r.data)).catch(() => {}); return () => { c.abort(); pending.current?.abort(); }; }, []);
  async function search(page = 1) {
    pending.current?.abort(); const c = new AbortController(); pending.current = c; setError(''); setBusy(true);
    const params = new URLSearchParams({ q: query, page: String(page), guests: String(filters.guests), sort: filters.sort });
    for (const key of ['checkIn', 'checkOut', 'maxPrice']) if (filters[key]) params.set(key, filters[key]);
    try { const body = await api('/hotels?' + params, { signal: c.signal }); if (!c.signal.aborted) { setResult(body); sessionStorage.setItem('geobook_stay', JSON.stringify(filters)); } }
    catch(e) { if (!c.signal.aborted) setError(e.message); } finally { if (!c.signal.aborted) setBusy(false); }
  }
  function change(key, value) { pending.current?.abort(); setBusy(false); setResult(null); setFilters({ ...filters, [key]: value }); }
  const cards = result?.data ?? featured;
  return <><section className="home-hero"><p className="eyebrow">YOUR NEXT STAY STARTS HERE</p><h1>Where would you<br/>like to go?</h1><p>Find your place, from a favorite city to a whole new country.</p>
    <form className="destination-search" onSubmit={e => { e.preventDefault(); search(); }}><label htmlFor="destination">Where are you going?</label><div className="destination-input"><span aria-hidden="true">⌕</span><input id="destination" type="search" maxLength="120" placeholder="City, province, country, or hotel name" value={query} onChange={e => { pending.current?.abort(); setBusy(false); setResult(null); setQuery(e.target.value); }}/><button disabled={busy}>{busy ? 'Searching…' : 'Search stays'}</button></div>
    <details className="search-options"><summary>Dates, guests & price</summary><div className="filter-grid"><label>Check-in<input type="date" min={today()} required={!!filters.checkOut} value={filters.checkIn} onChange={e => change('checkIn', e.target.value)}/></label><label>Check-out<input type="date" min={filters.checkIn || today()} required={!!filters.checkIn} value={filters.checkOut} onChange={e => change('checkOut', e.target.value)}/></label><label>Guests<input type="number" min="1" max="30" value={filters.guests} onChange={e => change('guests', Number(e.target.value))}/></label><label>Max nightly USD<input type="number" min="0" placeholder="Any" value={filters.maxPrice} onChange={e => change('maxPrice', e.target.value)}/></label><label>Sort<select value={filters.sort} onChange={e => change('sort', e.target.value)}><option value="name">Hotel name</option><option value="price">Lowest price</option></select></label></div><p className="muted">Dates show only connected room inventory. Price limits exclude unknown rates.</p></details></form>
    <p className="home-note">Discover a hotel, choose a room, and plan your stay.</p></section>
    <section className="destination-results" aria-live="polite" aria-busy={busy}>{error && <p className="error" role="alert">{error}</p>}{busy && <p>Finding stays…</p>}<div className="results-title"><h2>{result ? result.meta.total + ' stays for “' + (result.meta.query || 'all destinations') + '”' : 'Try the full booking experience'}</h2>{result && <span className="muted">Page {result.meta.page}</span>}</div>
    {!result && <p className="muted">Fictional demo properties with bookable test rooms. No payment or real reservation is made.</p>}{result?.data.length === 0 && <p className="notice">No matching stays. Try a broader destination, different dates, or a higher budget.</p>}
    {cards.map(h => <a className="hotel hotel-result hotel-link" href={hotelLink(h._id)} key={h._id}><div><h3>{h.name}</h3><p>{[h.city, h.province, h.country].filter(Boolean).join(', ')}</p><strong><HotelPrice hotel={h}/></strong>{h.synthetic && <p className="muted">Demo property</p>}</div><span className="explore-button">View hotel →</span></a>)}
    {result && <nav className="pagination" aria-label="Results pages"><button disabled={busy || result.meta.page <= 1} onClick={() => search(result.meta.page - 1)}>Previous</button><button disabled={busy || !result.meta.hasMore} onClick={() => search(result.meta.page + 1)}>Next</button></nav>}</section></>;
}
