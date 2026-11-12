import React from 'react';
export default function HotelPrice({ hotel }) {
  return <>{hotel.priceFrom == null ? 'Rate unavailable' : `From ${hotel.priceFrom} ${hotel.currency || ''} / night`}</>;
}
export function CatalogAttribution() {
  return <p className="muted">Hotel location data: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors · ODbL</a>. Rates and availability are not supplied by OpenStreetMap.</p>;
}
