import { readFile } from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import { validateHotels } from '../src/hotel-model.ts';
import { catalogRegions } from '../src/catalog-regions.ts';

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  let input: unknown;
  const regionName = args.includes('--osm-midtown') ? 'midtown' : args.find(a => a.startsWith('--osm-region='))?.split('=')[1];
  if (regionName !== undefined) {
    if (!Object.hasOwn(catalogRegions, regionName)) throw new Error(`Unknown region. Choose: ${Object.keys(catalogRegions).join(', ')}`);
    const region = catalogRegions[regionName as keyof typeof catalogRegions];
    const query = `[out:json][timeout:30];nwr["tourism"="hotel"]["name"](${region.bbox.join(',')});out center tags;`;
    const endpoint = new URL(process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter');
    endpoint.searchParams.set('data', query);
    const response = await fetch(endpoint, {
      signal: AbortSignal.timeout(45000),
      headers: { 'User-Agent': 'GeoBook-local-catalog-import/1.0' },
    });
    if (!response.ok) throw new Error(`OSM request failed (${response.status})`);
    const data = await response.json();
    if (data.remark || !Array.isArray(data.elements)) throw new Error('Incomplete OSM response; import cancelled');
    input = data.elements.filter((e: any) => {
      const point = e.center ?? e;
      return point.lat >= region.bbox[0] && point.lon >= region.bbox[1] && point.lat <= region.bbox[2] && point.lon <= region.bbox[3];
    }).slice(0, region.limit).map((e: any) => {
      const tags = e.tags; const coordinates = e.center ?? e;
      return { _id: `osm:${e.type}:${e.id}`, name: tags.name,
        city: region.city, province: region.province, country: 'United States', countryCode: 'US',
        address: [tags['addr:housenumber'], tags['addr:street'], tags['addr:postcode']].filter(Boolean).join(' '),
        location: { type: 'Point', coordinates: [coordinates.lon, coordinates.lat] },
        priceFrom: null, currency: null, amenities: [], images: [], roomReferences: [], synthetic: false,
        source: { provider: 'OpenStreetMap', id: `${e.type}/${e.id}`, url: `https://www.openstreetmap.org/${e.type}/${e.id}`,
          license: 'ODbL-1.0', attribution: '© OpenStreetMap contributors', fetchedAt: new Date().toISOString() },
      };
    });
  } else {
    const path = args.find(a => !a.startsWith('--'));
    if (!path) throw new Error('Usage: import-hotels.ts <catalog.json> | --osm-midtown | --osm-region=<name> [--apply]');
    input = JSON.parse(await readFile(path, 'utf8'));
  }
  // Validate the entire input before connecting or writing any records.
  const hotels = validateHotels(input);
  if (args.includes('--print')) { console.log(JSON.stringify(hotels)); return; }
  if (!apply) { console.log(JSON.stringify({ validated: hotels.length, dryRun: true })); return; }
  const client = new MongoClient(process.env.MONGO_URL ?? 'mongodb://localhost:27017/geobook', { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const collection = client.db('geobook').collection<any>('hotels');
    await collection.createIndex({ location: '2dsphere' });
    await collection.createIndex({ countryCode: 1, province: 1, city: 1 });
    await collection.createIndex({ name: 1, _id: 1 });
    // Insert-only: reruns never overwrite operator edits, rates, or existing records.
    const result = await collection.bulkWrite(hotels.map(hotel => ({ updateOne: {
      filter: { _id: hotel._id }, update: { $setOnInsert: hotel }, upsert: true,
    } })));
    console.log(JSON.stringify({ validated: hotels.length, inserted: result.upsertedCount, existing: result.matchedCount }));
  } finally { await client.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Import failed'); process.exitCode = 1; });
