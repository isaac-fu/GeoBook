import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import HotelPrice from './HotelPrice.jsx';
import './travel-map.css';
const modes = ['walking', 'cycling', 'driving'];
const colors = { walking: '#007c74', cycling: '#8b54bb', driving: '#dc7931' };
const hotelIcon = L.divIcon({
  className: 'travel-hotel-marker', iconSize: [36, 50], iconAnchor: [18, 50], tooltipAnchor: [0, -46],
  html: '<span class="travel-hotel-badge"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 21V3h14v18M3 21h18M10 21v-5h4v5M9 7h1m4 0h1M9 11h1m4 0h1"/></svg></span><span class="travel-hotel-stem"></span>',
});
const anchorIcon = L.divIcon({
  className: 'travel-anchor-marker', iconSize: [26, 26], iconAnchor: [13, 13], tooltipAnchor: [0, 16],
  html: '<svg viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="9"/><path d="M13 1v7m0 10v7M1 13h7m10 0h7"/><circle class="anchor-center" cx="13" cy="13" r="2"/></svg>',
});
function TravelMap({ hotel, anchor, onAnchor, result, visible, selected, onSelect }) {
  const element = useRef(null), map = useRef(null), layers = useRef(null);
  const click = useRef(onAnchor); click.current = onAnchor;
  useEffect(() => {
    const instance = L.map(element.current).setView([anchor[1], anchor[0]], 13);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', maxZoom: 19,
    }).addTo(instance);
    instance.on('click', e => click.current([e.latlng.lng, e.latlng.lat]));
    map.current = instance; layers.current = L.layerGroup().addTo(instance);
    return () => { instance.remove(); map.current = null; };
  }, []);
  useEffect(() => {
    if (!map.current) return;
    const [lng, lat] = hotel.location.coordinates;
    const label = document.createElement('span'); label.textContent = `${hotel.name} · Fixed hotel location`;
    const marker = L.marker([lat, lng], { icon: hotelIcon, draggable: false, bubblingMouseEvents: false,
      title: `${hotel.name} — fixed hotel location`, alt: `${hotel.name} hotel`, zIndexOffset: 1000 })
      .bindTooltip(label).addTo(map.current);
    return () => { marker.remove(); };
  }, [hotel]);
  useEffect(() => {
    if (!map.current) return;
    layers.current.clearLayers();
    for (const mode of visible) {
      const geo = result?.contours[mode];
      if (!geo) continue;
      const features = [...geo.features].sort((a, b) => b.properties.contour - a.properties.contour);
      L.geoJSON({ ...geo, features }, {
        style: () => ({ color: colors[mode], weight: 2, fillColor: colors[mode], fillOpacity: 0.10 }),
        onEachFeature: (feature, layer) => layer.bindTooltip(`${mode} · ${feature.properties.contour} min from anchor`),
      }).addTo(layers.current);
    }
    L.marker([anchor[1], anchor[0]], { icon: anchorIcon, draggable: false, bubblingMouseEvents: false,
      title: 'Travel anchor — click the map to move', alt: 'Travel search anchor', zIndexOffset: 1100 })
      .bindTooltip('Travel anchor — click the map to move').addTo(layers.current);
    for (const [index, row] of (result?.data ?? []).entries()) {
      if (row.hotel._id === hotel._id) continue;
      const [lng, lat] = row.hotel.location.coordinates;
      const label = document.createElement('span'); label.textContent = `${index + 1}. ${row.hotel.name ?? 'Hotel'}`;
      L.circleMarker([lat, lng], { radius: selected === row.hotel._id ? 11 : 7, color: '#fff', weight: 2, fillColor: selected === row.hotel._id ? '#dc7931' : '#007c74', fillOpacity: 1 })
        .bindTooltip(label).on('click', e => { L.DomEvent.stopPropagation(e); onSelect(row.hotel._id); }).addTo(layers.current);
    }
  }, [hotel, anchor, result, visible, selected]);
  useEffect(() => {
    if (!result || !map.current) return;
    const bounds = L.latLngBounds([[anchor[1], anchor[0]]]);
    bounds.extend([hotel.location.coordinates[1], hotel.location.coordinates[0]]);
    for (const row of result.data) bounds.extend([row.hotel.location.coordinates[1], row.hotel.location.coordinates[0]]);
    for (const geo of Object.values(result.contours)) {
      const region = L.geoJSON(geo).getBounds(); if (region.isValid()) bounds.extend(region);
    }
    map.current.fitBounds(bounds, { padding: [35, 35], maxZoom: 14 });
  }, [result, hotel]);
  return <div ref={element} className="map" aria-label="Hotel search map. Click to choose an anchor." />;
}

export default function TravelSearch({ hotel, onBack }) {
  const [anchor, setAnchor] = useState(hotel.location.coordinates);
  const [chosen, setChosen] = useState(['walking', 'cycling']);
  const [visible, setVisible] = useState(modes);
  const [direction, setDirection] = useState('from-anchor');
  const [budget, setBudget] = useState(30), [distance, setDistance] = useState('');
  const [includeUnpriced, setIncludeUnpriced] = useState(true);
  const [price, setPrice] = useState(300), [match, setMatch] = useState('any'), [sort, setSort] = useState('duration');
  const [result, setResult] = useState(null), [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const request = useRef(null);
  function invalidate() { request.current?.abort(); setLoading(false); setResult(null); setError(''); setSelected(null); }
  function moveAnchor(point) { invalidate(); setAnchor(point); }
  useEffect(() => () => request.current?.abort(), []);
  async function search(e) {
    e.preventDefault(); invalidate();
    if (!chosen.length) { setError('Choose at least one travel mode.'); return; }
    const controller = new AbortController(); request.current = controller; setLoading(true);
    try {
      const ringsMinutes = [...new Set([Math.max(1, Math.round(budget / 3)), Math.max(1, Math.round(budget * 2 / 3)), Number(budget)])];
      const response = await fetch('/api/hotels/travel-search', { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'X-GeoBook-Request': '1' }, body: JSON.stringify({
        anchor, modes: chosen, direction, ringsMinutes, maxMinutes: Number(budget),
        ...(distance ? { maxDistanceMeters: Number(distance) * 1000 } : {}),
        maxPrice: Number(price), includeUnpriced, match, sortBy: sort, limit: 100,
      }) });
      const body = await response.json();
      if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Check your search filters and try again.');
      if (!controller.signal.aborted) setResult(body);
    } catch (err) { if (!controller.signal.aborted) setError(err instanceof SyntaxError ? 'The search API is unavailable. Start the API and try again.' : err.message); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  return <>
    <section className="travel-search"><button className="explore-button" onClick={onBack}>← Back to hotel</button><section className="intro"><div><p className="eyebrow">STAY WITHIN REACH</p><h1>Explore your surroundings.</h1><p>The hotel pin stays at {hotel.name}. Click the map to move the travel anchor.</p></div></section>
    <div className="workspace"><aside><form onSubmit={search} onChange={invalidate}>
      <h2>Where do you want to be?</h2><p className="muted">Click the map or enter coordinates.</p>
      <div className="pair"><label>Longitude<input type="number" step="any" min="-180" max="180" required value={anchor[0]} onChange={e => setAnchor([Number(e.target.value), anchor[1]])}/></label><label>Latitude<input type="number" step="any" min="-90" max="90" required value={anchor[1]} onChange={e => setAnchor([anchor[0], Number(e.target.value)])}/></label></div>
      <label>Journey<select value={direction} onChange={e => setDirection(e.target.value)}><option value="from-anchor">From this spot to a hotel</option><option value="to-anchor">From a hotel to this spot</option></select></label>
      <fieldset><legend>How will you travel?</legend>{modes.map(mode => <label className="check" key={mode}><input type="checkbox" checked={chosen.includes(mode)} onChange={e => setChosen(e.target.checked ? [...chosen, mode] : chosen.filter(m => m !== mode))}/><span style={{ color: colors[mode] }}>●</span> {mode}</label>)}</fieldset>
      <label>Travel budget <strong>{budget} min</strong><input type="range" min="3" max="60" step="3" value={budget} onChange={e => setBudget(Number(e.target.value))}/></label>
      <div className="pair"><label>Max route km<input type="number" min="0.1" max="1000" step="0.1" placeholder="Any distance" value={distance} onChange={e => setDistance(e.target.value)}/></label><label>Max nightly price<input type="number" min="0" required value={price} onChange={e => setPrice(e.target.value)}/></label></div>
      <label className="check"><input type="checkbox" checked={includeUnpriced} onChange={e => setIncludeUnpriced(e.target.checked)}/> Include hotels with unknown rates</label>
      <label>Modes within budget<select value={match} onChange={e => setMatch(e.target.value)}><option value="any">At least one selected mode</option><option value="all">Every selected mode</option></select></label>
      <label>Rank stays by<select value={sort} onChange={e => setSort(e.target.value)}><option value="duration">Fastest eligible travel time</option><option value="distance">Shortest eligible route distance</option></select></label>
      <button className="search" disabled={loading}>{loading ? 'Finding your stays…' : 'Find stays →'}</button>
    </form></aside><section className="explore"><div className="map-wrap"><TravelMap hotel={hotel} anchor={anchor} onAnchor={moveAnchor} result={result} visible={visible} selected={selected} onSelect={setSelected}/></div>
      <div className="map-marker-legend"><span><i className="hotel-key" aria-hidden="true">▥</i> Hotel · fixed location</span><span><i className="anchor-key" aria-hidden="true">⊕</i> Travel anchor · click map to move</span></div><div className="legend"><span>Show contours:</span>{modes.map(mode => <label key={mode}><input type="checkbox" checked={visible.includes(mode)} onChange={e => setVisible(e.target.checked ? [...visible, mode] : visible.filter(m => m !== mode))}/><span style={{ color: colors[mode] }}>{mode}</span></label>)}</div>
      {direction === 'to-anchor' && <p className="notice">Contours show travel from the selected spot. Hotel rankings use the reverse journey to your spot.</p>}
      <div aria-live="polite">{error && <p className="error" role="alert">{error}</p>}{loading && <p className="notice">Calculating reachable areas and hotel journeys…</p>}
      <div className="results-title"><h2>{result ? `${result.meta.matchedCount} stays within reach` : 'Find a stay that fits your day'}</h2>{result && <span className="muted">Best eligible mode · {sort === 'duration' ? 'travel time' : 'route distance'}</span>}</div>
      {!result && !loading && <p className="muted">Your ranked hotels and travel-time contours will appear after a search.</p>}
      {result?.data.length === 0 && <p>No stays match these budgets. Try increasing the time or price limit.</p>}
      {result?.data.map((row, i) => <button className={`hotel ${selected === row.hotel._id ? 'selected' : ''}`} key={row.hotel._id} onClick={() => setSelected(row.hotel._id)}><span className="rank">{i + 1}</span><div><h3>{row.hotel.name ?? 'Hotel'}</h3><p>{row.hotel.city} · <HotelPrice hotel={row.hotel}/></p><div className="estimates">{Object.entries(row.travel).map(([mode, value]) => <span key={mode} style={{ borderColor: colors[mode] }}>{mode}: {value ? `${Math.ceil(value.durationSeconds / 60)} min · ${(value.distanceMeters / 1000).toFixed(1)} km` : 'No route'}</span>)}</div></div><span className="best">Best by<br/><strong>{row.bestMode}</strong></span></button>)}</div>
    </section></div></section></>;
}
