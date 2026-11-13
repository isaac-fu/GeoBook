import { z } from 'zod';

export const ratePlanSchema = z.object({
  id: z.uuid(), name: z.string().trim().min(1).max(100),
  additionalNightlyCents: z.number().int().min(0).max(10000000),
  breakfastIncluded: z.boolean().default(false),
  minNights: z.number().int().min(1).max(90).default(1),
});
export const roomSchema = z.object({
  name: z.string().trim().min(1).max(100), capacity: z.number().int().min(1).max(30),
  nightlyCents: z.number().int().min(100).max(10000000), active: z.boolean().default(true),
  roomType: z.string().trim().min(1).max(100).default('Standard'),
  ratePlans: z.array(ratePlanSchema).max(10).default([]),
}).refine(r => new Set(r.ratePlans.map(p => p.id)).size === r.ratePlans.length, { message: 'Rate plan IDs must be unique.' });

export function roomRates(room: { nightly_cents: number; rate_plans?: z.infer<typeof ratePlanSchema>[] }, nights: number) {
  return [
    { id: 'standard', name: 'Room only', additionalNightlyCents: 0, breakfastIncluded: false, minNights: 1 },
    ...(room.rate_plans ?? []),
  ].filter(p => nights >= p.minNights).map(p => ({
    ...p, nightlyCents: room.nightly_cents + p.additionalNightlyCents,
    totalCents: (room.nightly_cents + p.additionalNightlyCents) * nights,
  }));
}
