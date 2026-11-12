import { z } from 'zod';

// Canonical catalog record. PostgreSQL remains responsible for bookable inventory.
export const hotelSchema = z.object({
  _id: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(300),
  city: z.string().trim().min(1), province: z.string().trim().min(1),
  country: z.string().trim().min(1), countryCode: z.string().regex(/^[A-Z]{2}$/),
  address: z.string().default(''),
  description: z.string().trim().max(10000).nullable().default(null),
  rating: z.object({ score: z.number().nonnegative(), scale: z.number().positive().max(100),
    reviewCount: z.number().int().positive(), provider: z.string().min(1),
  }).refine(r => r.score <= r.scale, { message: 'Rating cannot exceed its scale' }).nullable().default(null),
  location: z.object({ type: z.literal('Point'), coordinates: z.tuple([
    z.number().min(-180).max(180), z.number().min(-90).max(90),
  ]) }),
  priceFrom: z.number().nonnegative().nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  amenities: z.array(z.string()).default([]),
  images: z.array(z.object({ url: z.url(), attribution: z.string().min(1), license: z.string().min(1) })).default([]),
  roomReferences: z.array(z.string()).default([]),
  synthetic: z.boolean().default(false),
  source: z.object({ provider: z.string().min(1), id: z.string().min(1), url: z.url(),
    license: z.string().min(1), attribution: z.string().min(1), fetchedAt: z.iso.datetime() }),
}).refine(h => h.priceFrom === null || h.currency !== null, { message: 'A known price requires a currency' });

export function validateHotels(input: unknown) {
  const rows = z.array(hotelSchema).min(1).max(10000).parse(input);
  if (new Set(rows.map(h => h._id)).size !== rows.length) throw new Error('Duplicate hotel IDs in import');
  return rows;
}
