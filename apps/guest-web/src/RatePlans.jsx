import React from 'react';

export default function RatePlans({ plans, setPlans, disabled }) {
  function update(id, field, value) { setPlans(plans.map(p => p.id === id ? { ...p, [field]: value } : p)); }
  return <fieldset disabled={disabled}><legend>Optional rate plans</legend>
    <p className="muted">Room only is always offered at the base nightly rate. Extra plans add a nightly supplement. All demo plans allow free cancellation before check-in.</p>
    {plans.map(p => <div className="panel" key={p.id}><div className="filter-grid">
      <label>Plan name<input required maxLength="100" value={p.name} onChange={e => update(p.id, 'name', e.target.value)}/></label>
      <label>Extra USD per night<input type="number" min="0" max="100000" step="0.01" required value={p.additionalNightlyCents / 100} onChange={e => update(p.id, 'additionalNightlyCents', Math.round(Number(e.target.value) * 100))}/></label>
      <label>Minimum nights<input type="number" min="1" max="90" required value={p.minNights} onChange={e => update(p.id, 'minNights', Number(e.target.value))}/></label>
    </div><label className="check"><input type="checkbox" checked={p.breakfastIncluded} onChange={e => update(p.id, 'breakfastIncluded', e.target.checked)}/> Breakfast included</label>
    <button type="button" onClick={() => setPlans(plans.filter(other => other.id !== p.id))}>Remove plan</button></div>)}
    <button type="button" disabled={plans.length >= 10} onClick={() => setPlans([...plans, { id: crypto.randomUUID(), name: '', additionalNightlyCents: 0, minNights: 1, breakfastIncluded: false }])}>Add rate plan</button>
  </fieldset>;
}
