import { z } from 'zod';
import type { Express } from 'express';
import type { MongoClient } from 'mongodb';
import { MapboxRouting, RoutingError, rankHotels, spatialFilter } from './travel.js';
import type { Hotel, Mode, Contours, Estimate } from './travel.js';

const schema = z.object({
  anchor: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
  modes: z.array(z.enum(['walking', 'cycling', 'driving'])).min(1).max(3).refine(a => new Set(a).size === a.length),
  direction: z.enum(['from-anchor', 'to-anchor']).default('to-anchor'),
  ringsMinutes: z.array(z.number().int().min(1).max(60)).min(1).max(4).default([15, 30, 45]),
  maxMinutes: z.number().int().min(1).max(60).default(45),
  maxDistanceMeters: z.number().positive().max(1000000).optional(),
  match: z.enum(['any', 'all']).default('any'),
  sortBy: z.enum(['duration', 'distance']).default('duration'),
  minPrice: z.number().nonnegative().default(0),
  maxPrice: z.number().nonnegative().default(100000),
  limit: z.number().int().min(1).max(100).default(20),
}).refine(q => q.minPrice <= q.maxPrice && q.ringsMinutes.at(-1) === q.maxMinutes &&
  q.ringsMinutes.every((n, i, a) => i === 0 || n > a[i - 1]),
  { message: 'Prices must be ordered; rings must increase and end at maxMinutes' });

export function registerTravelSearch(app: Express, mongo: MongoClient) {
  const routing = new MapboxRouting(process.env.MAPBOX_TOKEN ?? '');
  let active = 0;
  app.post('/api/hotels/travel-search', async (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    if (active >= 2) { res.status(429).json({ error: 'Travel search busy; retry shortly' }); return; }
    active++;
    try {
      const query = parsed.data;
      const contours: Partial<Record<Mode, Contours>> = {};
      for (const mode of query.modes) contours[mode] = await routing.contours(query.anchor, mode, query.ringsMinutes);
      const collection = mongo.db('geobook').collection('hotels');
      await collection.createIndex({ location: '2dsphere' });
      const filter = { $and: [spatialFilter(contours, query), { priceFrom: { $gte: query.minPrice, $lte: query.maxPrice } }, { 'location.type': 'Point' }] };
      // Reject oversized searches rather than silently returning an incomplete ranking.
      const hotels = await collection.find(filter).sort({ _id: 1 }).limit(121).toArray() as unknown as Hotel[];
      if (hotels.length > 120) {
        res.status(422).json({ error: 'Too many candidates. Narrow price filters or use from-anchor with a smaller travel budget.', candidateLimit: 120 }); return;
      }
      const matrices: Partial<Record<Mode, Estimate[]>> = {};
      for (const mode of query.modes) matrices[mode] = await routing.matrix(query.anchor, hotels, mode, query.direction);
      const ranked = rankHotels(hotels, matrices, query);
      res.json({ data: ranked.slice(0, query.limit), contours, meta: {
        candidateCount: hotels.length, matchedCount: ranked.length, direction: query.direction,
        contourDirection: 'from-anchor', contourPrefilterApplied: query.direction === 'from-anchor',
        sortBy: query.sortBy, match: query.match, provider: 'mapbox',
        scoreUnit: query.sortBy === 'duration' ? 'seconds' : 'meters',
        ranking: 'Best eligible mode per hotel; all requires every selected mode within budget',
      } });
    } catch (error) {
      res.status(error instanceof RoutingError ? 502 : 500).json({ error: error instanceof RoutingError ? error.message : 'Travel search failed' });
    } finally { active--; }
  });
}
