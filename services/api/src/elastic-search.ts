import { createHash, randomUUID } from 'node:crypto';
import type { MongoClient } from 'mongodb';
import type { Pool } from 'pg';

export const SEARCH_LIMIT = 60000;
const fields = ['name', 'city', 'province', 'state', 'country', 'countryCode', 'locationName'];
export function searchDocument(hotel: any) {
  const doc: any = { hotelId: String(hotel._id) };
  for (const field of fields) doc[field] = typeof hotel[field] === 'string' ? hotel[field] : '';
  doc.destination = fields.map(field => doc[field]).filter(Boolean).join(' ');
  doc.priceFrom = typeof hotel.priceFrom === 'number' && Number.isFinite(hotel.priceFrom) ? hotel.priceFrom : null;
  return doc;
}
export const searchMapping = {
  dynamic: 'strict',
  properties: {
    hotelId: { type: 'keyword' },
    priceFrom: { type: 'double' },
    name: { type: 'text', analyzer: 'folded', fields: { sort: { type: 'keyword', normalizer: 'folded_keyword' } } },
    ...Object.fromEntries(fields.filter(f => f !== 'name').map(f => [f, { type: 'text', analyzer: 'folded' }])),
    destination: { type: 'search_as_you_type', analyzer: 'folded' },
  },
};
export type SearchInput = { q: string; page: number; sort: 'relevance' | 'name' | 'price' };
export function elasticQuery(input: SearchInput, ids: string[], size = 20) {
  if (ids.length > SEARCH_LIMIT || input.page * size > 10000) throw new Error('Search window exceeded');
  return { from: (input.page - 1) * size, size, track_total_hits: true, _source: ['hotelId'], timeout: '2s',
    query: { bool: { filter: [{ terms: { hotelId: ids } }], must: input.q ? [{ bool: { minimum_should_match: 1, should: [
      { match: { destination: { query: input.q, operator: 'and', fuzziness: 'AUTO', prefix_length: 1, max_expansions: 25 } } },
      { multi_match: { query: input.q, type: 'bool_prefix', operator: 'and', fields: ['destination', 'destination._2gram', 'destination._3gram'], boost: 2 } },
      { multi_match: { query: input.q, type: 'phrase', fields: ['name^4', 'city^3', 'province^2', 'state^2', 'country'] } },
    ] } }] : [{ match_all: {} }] } },
    sort: input.sort === 'price' ? [{ priceFrom: { order: 'asc', missing: '_last' } }, { hotelId: 'asc' }] : input.sort === 'name' || !input.q ? [{ 'name.sort': 'asc' }, { hotelId: 'asc' }] : [{ _score: 'desc' }, { hotelId: 'asc' }],
  };
}
export class ElasticSearch {
  readonly alias: string;
  private readonly url: string;
  constructor(url: string, alias = process.env.ELASTICSEARCH_INDEX || 'geobook-hotels', private readonly apiKey = process.env.ELASTICSEARCH_API_KEY, private readonly transport: typeof fetch = fetch) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid ELASTICSEARCH_URL');
    if (!/^[a-z][a-z0-9-]{0,60}$/.test(alias)) throw new Error('Invalid ELASTICSEARCH_INDEX');
    this.url = url.replace(/\/$/, ''); this.alias = alias;
  }
  async request(path: string, method = 'GET', body?: unknown, ndjson = false): Promise<any> {
    const response = await this.transport(this.url + path, { method, redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': ndjson ? 'application/x-ndjson' : 'application/json', ...(this.apiKey ? { Authorization: `ApiKey ${this.apiKey}` } : {}) },
      ...(body === undefined ? {} : { body: ndjson ? String(body) : JSON.stringify(body) }) });
    if (!response.ok) { const error = new Error(`Search service HTTP ${response.status}`); (error as any).status = response.status; throw error; }
    return response.json();
  }
  async search(input: SearchInput, ids: string[], size = 20): Promise<{ ids: string[]; total: number }> {
    if (!ids.length) return { ids: [], total: 0 };
    const result = await this.request(`/${this.alias}/_search`, 'POST', elasticQuery(input, ids, size));
    if (result.timed_out || result._shards?.failed || result.hits?.total?.relation !== 'eq') throw new Error('Search returned incomplete results');
    return { ids: result.hits.hits.map((hit: any) => hit._source.hotelId), total: result.hits.total.value };
  }
}
export function configuredSearch() { return process.env.ELASTICSEARCH_URL ? new ElasticSearch(process.env.ELASTICSEARCH_URL) : undefined; }

export async function rebuildSearch(mongo: MongoClient, pool: Pool, elastic: ElasticSearch) {
  const lock = await pool.connect();
  let held = false;
  try {
    held = (await lock.query('SELECT pg_try_advisory_lock(731903,hashtext($1)) AS held', [elastic.alias])).rows[0].held;
    if (!held) return { skipped: true, reason: 'Another indexer is running' };
    const projection = Object.fromEntries([...fields, 'priceFrom'].map(field => [field, 1]));
    const hotels = await mongo.db('geobook').collection('hotels').find({ active: { $ne: false } }, { projection }).sort({ _id: 1 }).limit(SEARCH_LIMIT + 1).toArray();
    if (hotels.length > SEARCH_LIMIT) throw new Error('Catalog exceeds the supported search limit');
    const docs = hotels.map(searchDocument);
    const fingerprint = createHash('sha256').update(JSON.stringify({ version: 1, docs })).digest('hex');
    let previous: any = {};
    try { previous = await elastic.request(`/${elastic.alias}/_mapping`); } catch (error) { if ((error as any).status !== 404) throw error; }
    if (Object.values(previous).some((entry: any) => entry.mappings?._meta?.fingerprint === fingerprint)) return { skipped: true, count: docs.length };
    const index = `${elastic.alias}-snapshot-${Date.now()}-${randomUUID()}`;
    await elastic.request(`/${index}`, 'PUT', {
      settings: { number_of_shards: 1, number_of_replicas: 0, analysis: {
        analyzer: { folded: { type: 'custom', tokenizer: 'standard', filter: ['lowercase', 'asciifolding'] } },
        normalizer: { folded_keyword: { type: 'custom', filter: ['lowercase', 'asciifolding'] } },
      } }, mappings: { ...searchMapping, _meta: { fingerprint, generatedAt: new Date().toISOString() } },
    });
    for (let offset = 0; offset < docs.length; offset += 500) {
      const body = docs.slice(offset, offset + 500).map(doc => JSON.stringify({ index: { _id: doc.hotelId } }) + '\n' + JSON.stringify(doc) + '\n').join('');
      const response = await elastic.request(`/${index}/_bulk`, 'POST', body, true);
      if (response.errors) throw new Error('Hotel bulk indexing failed; previous search index retained');
    }
    await elastic.request(`/${index}/_refresh`, 'POST');
    const count = await elastic.request(`/${index}/_count`);
    if (count.count !== docs.length) throw new Error('Search index count verification failed');
    const actions: any[] = Object.keys(previous).map(old => ({ remove: { index: old, alias: elastic.alias, must_exist: true } }));
    actions.push({ add: { index, alias: elastic.alias } });
    const switched = await elastic.request('/_aliases', 'POST', { actions });
    if (!switched.acknowledged || switched.errors) throw new Error('Search alias switch not acknowledged');
    // Keep the current and previous snapshots. Delete only this indexer's older generated indices.
    try {
      const all = await elastic.request(`/${elastic.alias}-snapshot-*/_mapping`);
      const keep = new Set([index, ...Object.keys(previous)]);
      const own = new RegExp(`^${elastic.alias}-snapshot-\\d+-[a-f0-9-]{36}$`);
      for (const name of Object.keys(all)) if (own.test(name) && !keep.has(name)) await elastic.request(`/${name}`, 'DELETE');
    } catch { console.warn('Search snapshot cleanup will be retried after the next rebuild'); }
    return { indexed: docs.length, index };
  } finally {
    if (held) await lock.query('SELECT pg_advisory_unlock(731903,hashtext($1))', [elastic.alias]);
    lock.release();
  }
}
