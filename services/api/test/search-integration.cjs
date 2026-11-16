// Requires a running development Elasticsearch node; Mongo/PG are fixture adapters.
// Uses an isolated random alias and removes only indices created under that alias.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { ElasticSearch, rebuildSearch } = require('../dist/elastic-search.js');
async function main() {
  const alias = 'geobook-test-' + randomUUID();
  const es = new ElasticSearch(process.env.ELASTICSEARCH_URL || 'http://localhost:9200', alias);
  let docs = [
    { _id: 'h1', name: 'Harbor House', city: 'San Francisco', province: 'California', country: 'United States', priceFrom: 129 },
    { _id: 'h2', name: 'Park House', city: 'New York', province: 'New York', country: 'United States', priceFrom: 159 },
    { _id: 'h3', name: 'Café Hotel', city: 'Los Angeles', province: 'California', country: 'United States', priceFrom: null },
  ];
  const mongo = { db: () => ({ collection: () => ({ find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => docs }) }) }) }) }) };
  const pool = { connect: async () => ({ query: async () => ({ rows: [{ held: true }] }), release() {} }) };
  try {
    await rebuildSearch(mongo, pool, es);
    const find = (q, sort = 'relevance', ids = docs.map(d => d._id)) => es.search({ q, page: 1, sort }, ids);
    assert.deepEqual((await find('Francsico')).ids, ['h1']);
    assert.deepEqual((await find('San Fran')).ids, ['h1']);
    assert.deepEqual((await find('cafe')).ids, ['h3']);
    assert.equal((await find('California')).total, 2);
    assert.equal((await find('United States')).total, 3);
    assert.deepEqual((await find('', 'price')).ids, ['h1','h2','h3']);
    assert.deepEqual((await find('California', 'name', ['h2'])).ids, []);
    assert.equal((await rebuildSearch(mongo, pool, es)).skipped, true);
    docs = docs.slice(1); await rebuildSearch(mongo, pool, es);
    assert.equal((await find('Harbor', 'relevance', ['h1','h2','h3'])).total, 0);
    console.log('PASS: real Elasticsearch mappings, typo/prefix/accent matching, destination matching, price sorting, eligibility, unchanged snapshot, deletion and alias replacement.');
  } finally {
    let indices = {};
    try { indices = await es.request(`/${alias}-snapshot-*/_mapping`); } catch (e) { if (e.status !== 404) throw e; }
    for (const name of Object.keys(indices)) if (name.startsWith(alias + '-snapshot-')) await es.request('/' + name, 'DELETE');
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
