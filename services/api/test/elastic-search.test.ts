import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ElasticSearch, elasticQuery, searchDocument, rebuildSearch, SEARCH_LIMIT } from '../src/elastic-search.ts';
import { createApp } from '../src/app.ts';

test('search projection excludes private/content fields and combines destinations', () => {
  const result = searchDocument({ _id: 'h1', name: 'Harbor', city: 'San Francisco', country: 'United States', priceFrom: 129, ownerEmail: 'private', images: ['private'], active: true });
  assert.equal(result.destination, 'Harbor San Francisco United States');
  assert.equal(result.priceFrom, 129); assert.equal(result.hotelId, 'h1');
  assert.equal(result.ownerEmail, undefined); assert.equal(result.images, undefined);
  assert.equal(searchDocument({ _id: 'h2' }).priceFrom, null);
});
test('typed queries preserve eligibility and treat user text as data rather than query syntax', () => {
  const q = elasticQuery({ q: 'name:* OR private', page: 2, sort: 'relevance' }, ['h1']);
  assert.deepEqual(q.query.bool.filter, [{ terms: { hotelId: ['h1'] } }]);
  assert.equal(q.from, 20); assert.equal(q.size, 20);
  assert.ok(!JSON.stringify(q).includes('query_string'));
  assert.equal(elasticQuery({ q: 'York', page: 1, sort: 'price' }, []).sort[0].priceFrom?.missing, '_last');
  assert.throws(() => elasticQuery({ q: '', page: 501, sort: 'name' }, ['h1']));
  assert.throws(() => elasticQuery({ q: '', page: 1, sort: 'name' }, Array(SEARCH_LIMIT + 1).fill('h1')));
});
test('search configuration rejects credentials in URL and index path injection', () => {
  for (const alias of ['../secret', '_all', 'hotels*', 'Hotels']) assert.throws(() => new ElasticSearch('http://localhost:9200', alias));
  assert.throws(() => new ElasticSearch('http://secret:password@localhost:9200'));
});
test('incomplete, failed and unavailable Elasticsearch responses fail for caller fallback', async () => {
  for (const result of [{ timed_out: true }, { _shards: { failed: 1 } }, { hits: { total: { value: 10000, relation: 'gte' } } }]) {
    const es = new ElasticSearch('http://localhost:9200', 'test', undefined, async () => Response.json(result));
    await assert.rejects(es.search({ q: 'harbor', page: 1, sort: 'relevance' }, ['h1']));
  }
  const es = new ElasticSearch('http://localhost:9200', 'test', undefined, async () => new Response('private provider error', { status: 503 }));
  await assert.rejects(es.search({ q: '', page: 1, sort: 'name' }, ['h1']), /Search service HTTP 503/);
});
test('snapshot failures retain previous alias and release the indexer lock', async () => {
  const calls: string[] = [], queries: string[] = [];
  const es = new ElasticSearch('http://localhost:9200', 'test', undefined, async (url, options) => {
    const path = new URL(String(url)).pathname; calls.push(`${options?.method} ${path}`);
    if (path === '/test/_mapping') return Response.json({ old: { mappings: { _meta: { fingerprint: 'old' } } } });
    if (path.endsWith('/_bulk')) return Response.json({ errors: true });
    return Response.json({ acknowledged: true });
  });
  const mongo: any = { db: () => ({ collection: () => ({ find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [{ _id: 'h1', name: 'Harbor' }] }) }) }) }) }) };
  const pool: any = { connect: async () => ({ query: async (sql: string) => { queries.push(sql); return { rows: [{ held: true }] }; }, release: () => queries.push('released') }) };
  await assert.rejects(rebuildSearch(mongo, pool, es), /bulk indexing failed/);
  assert.ok(!calls.some(call => call.endsWith('/_aliases')));
  assert.ok(queries.some(sql => sql.includes('pg_advisory_unlock'))); assert.equal(queries.at(-1), 'released');
});

test('API preserves ranked live hotel data and falls back on search outage', async () => {
  const hotel = { _id: 'h1', name: 'Live hotel name', priceFrom: 100 };
  const filters: any[] = [];
  const collection = {
    find: (filter: any, options: any) => {
      filters.push(filter);
      const rows = options?.projection ? [{ _id: 'h1' }] : [hotel];
      return { limit: () => ({ toArray: async () => rows }), toArray: async () => rows };
    },
    aggregate: () => ({ toArray: async () => [hotel] }), countDocuments: async () => 1,
  };
  let unavailable = false;
  const es: any = { search: async (input: any, ids: string[]) => {
    assert.equal(input.q, 'Californa'); assert.deepEqual(ids, ['h1']);
    if (unavailable) throw Error('Search down');
    return { ids: ['h1'], total: 1 };
  } };
  const app = createApp({ db: () => ({ collection: () => collection }) } as any, {} as any, async () => {}, undefined, es);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as any).port;
  try {
    let response = await fetch(`http://127.0.0.1:${port}/api/hotels?q=Californa&maxPrice=150`);
    let body = await response.json();
    assert.equal(response.status, 200); assert.equal(body.meta.searchEngine, 'elasticsearch');
    assert.deepEqual(body.data, [hotel]);
    assert.ok(filters.every(f => JSON.stringify(f).includes('active')));
    assert.ok(filters.every(f => JSON.stringify(f).includes('priceFrom')));
    unavailable = true;
    response = await fetch(`http://127.0.0.1:${port}/api/hotels?q=Californa`); body = await response.json();
    assert.equal(response.status, 200); assert.equal(body.meta.searchEngine, 'mongodb'); assert.equal(body.meta.degraded, true);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/hotels?page=501`)).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/hotels?minPrice=200&maxPrice=100`)).status, 400);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
