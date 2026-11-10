export type Mode = 'walking' | 'cycling' | 'driving';
export type Point = [number, number];
export type TravelQuery = {
  anchor: Point; modes: Mode[]; direction: 'from-anchor' | 'to-anchor';
  ringsMinutes: number[]; maxMinutes: number; maxDistanceMeters?: number;
  match: 'any' | 'all'; sortBy: 'duration' | 'distance';
};
export type Hotel = { _id: unknown; location: { type: 'Point'; coordinates: Point }; [key: string]: unknown };
export type Estimate = { durationSeconds: number; distanceMeters: number } | null;
type Polygon = { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown[] };
export type Contours = { type: 'FeatureCollection'; features: { type: 'Feature'; geometry: Polygon; properties: Record<string, unknown> }[] };

export class RoutingError extends Error {}

export class MapboxRouting {
  constructor(private token: string, private request: typeof fetch = fetch) {}
  private async get(url: URL) {
    if (!this.token) throw new RoutingError('MAPBOX_TOKEN is not configured');
    url.searchParams.set('access_token', this.token);
    try {
      const response = await this.request(url, { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error('provider error');
      return await response.json();
    } catch { throw new RoutingError('Routing provider unavailable; retry later'); }
  }
  async contours(anchor: Point, mode: Mode, minutes: number[]): Promise<Contours> {
    const url = new URL(`https://api.mapbox.com/isochrone/v1/mapbox/${mode}/${anchor.join(',')}`);
    url.searchParams.set('contours_minutes', minutes.join(','));
    url.searchParams.set('polygons', 'true');
    url.searchParams.set('denoise', '0');
    const data = await this.get(url);
    if (data.type !== 'FeatureCollection' || !Array.isArray(data.features) || !data.features.length ||
      data.features.some((f: any) => !['Polygon', 'MultiPolygon'].includes(f.geometry?.type))) {
      throw new RoutingError('Invalid isochrone response');
    }
    return data;
  }
  async matrix(anchor: Point, hotels: Hotel[], mode: Mode, direction: TravelQuery['direction']): Promise<Estimate[]> {
    const estimates: Estimate[] = [];
    // A batch reserves one of Mapbox's 25 coordinates for the anchor.
    for (let offset = 0; offset < hotels.length; offset += 24) {
      const batch = hotels.slice(offset, offset + 24);
      const coordinates = [anchor, ...batch.map(h => h.location.coordinates)].map(p => p.join(',')).join(';');
      const url = new URL(`https://api.mapbox.com/directions-matrix/v1/mapbox/${mode}/${coordinates}`);
      const indices = batch.map((_, i) => i + 1).join(';');
      url.searchParams.set('sources', direction === 'from-anchor' ? '0' : indices);
      url.searchParams.set('destinations', direction === 'from-anchor' ? indices : '0');
      url.searchParams.set('annotations', 'duration,distance');
      const data = await this.get(url);
      if (data.code !== 'Ok') throw new RoutingError('Invalid matrix response');
      for (let i = 0; i < batch.length; i++) {
        const row = direction === 'from-anchor' ? 0 : i;
        const col = direction === 'from-anchor' ? i : 0;
        const duration = data.durations?.[row]?.[col];
        const distance = data.distances?.[row]?.[col];
        if (duration === null || distance === null) { estimates.push(null); continue; }
        if (!Number.isFinite(duration) || duration < 0 || !Number.isFinite(distance) || distance < 0) {
          throw new RoutingError('Invalid matrix values');
        }
        estimates.push({ durationSeconds: duration, distanceMeters: distance });
      }
    }
    return estimates;
  }
}

export function rankHotels(hotels: Hotel[], matrices: Partial<Record<Mode, Estimate[]>>, query: TravelQuery) {
  const metric = query.sortBy === 'duration' ? 'durationSeconds' : 'distanceMeters';
  return hotels.flatMap((hotel, index) => {
    const travel = Object.fromEntries(query.modes.map(mode => [mode, matrices[mode]?.[index] ?? null]));
    const eligible = query.modes.filter(mode => {
      const value = travel[mode];
      return value && value.durationSeconds <= query.maxMinutes * 60 &&
        (query.maxDistanceMeters === undefined || value.distanceMeters <= query.maxDistanceMeters);
    });
    if (!eligible.length || (query.match === 'all' && eligible.length !== query.modes.length)) return [];
    const bestMode = eligible.reduce((a, b) => travel[a]![metric] <= travel[b]![metric] ? a : b);
    return [{ hotel, travel, bestMode, score: travel[bestMode]![metric] }];
  }).sort((a, b) => a.score - b.score || String(a.hotel._id).localeCompare(String(b.hotel._id)));
}

// Outbound contours cannot safely exclude hotels on an inbound journey.
export function spatialFilter(contours: Partial<Record<Mode, Contours>>, query: TravelQuery) {
  if (query.direction === 'to-anchor') return {};
  const perMode = query.modes.map(mode => ({ $or: contours[mode]!.features
    .filter(f => Number(f.properties.contour) === query.maxMinutes)
    .map(f => ({ location: { $geoWithin: { $geometry: f.geometry } } })) }));
  if (perMode.some(p => !p.$or.length)) throw new RoutingError('Missing outer isochrone');
  return query.match === 'all' ? { $and: perMode } : { $or: perMode };
}
