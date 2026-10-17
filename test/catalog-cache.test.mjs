import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCatalogCache } from '../catalog-cache.mjs';

test('Persistent cache, TTL, shared in-flight requests and stale fallback', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'catalog-cache-')), 'cache.sqlite');
  let db = new DatabaseSync(file);
  let time = 1000, calls = 0, broken = false;
  const fetcher = async url => {
    calls++;
    await new Promise(resolve => setImmediate(resolve));
    if (broken) throw new Error('Offline');
    return { ok: true, json: async () => url.endsWith('/42')
      ? { kinopoiskId: 42, description: 'Details' } : { items: [{ kinopoiskId: 42 }] } };
  };
  const options = { fetcher, now: () => time };
  let get = createCatalogCache(db, options);
  const search = '/api/v2.2/films?page=1', detail = '/api/v2.2/films/42';
  try {
    await Promise.all(Array.from({ length: 10 }, () => get(search, 'test-key')));
    assert.equal(calls, 1);
    await get(detail, 'test-key');
    assert.equal(calls, 2);
    db.close(); db = new DatabaseSync(file); get = createCatalogCache(db, options);
    await get(search, 'test-key');
    assert.equal(calls, 2, 'cache survives database reopen');
    time += 6 * 3600000 + 1;
    await get(search, 'test-key');
    await get(detail, 'test-key');
    assert.equal(calls, 3, 'search refreshes while detail remains fresh');
    time += 6 * 3600000 + 1; broken = true;
    assert.equal((await get(search, 'test-key')).items.length, 1);
    assert.equal(calls, 4);
    await get(search, 'test-key');
    await assert.rejects(get('/api/v2.2/films?keyword=new', 'test-key'), { status: 502 });
    assert.equal(calls, 4, 'cooldown avoids repeated failed requests');
    time += 15 * 86400000;
    await assert.rejects(get(search, 'test-key'), { status: 502 });
    assert.equal(await get(detail, ''), null);
  } finally { db.close(); }
});

test('429 backoff and malformed responses are not cached', async () => {
  const db = new DatabaseSync(':memory:');
  let time = 0, calls = 0;
  const get = createCatalogCache(db, { now: () => time, fetcher: async () => {
    calls++;
    return calls === 1
      ? { ok: false, status: 429, headers: new Headers({ 'retry-after': '120' }) }
      : { ok: true, json: async () => ({ invalid: true }) };
  } });
  try {
    await assert.rejects(get('/api/v2.2/films', 'key'), { status: 502 });
    time = 61000;
    await assert.rejects(get('/api/v2.2/films', 'key'), { status: 502 });
    assert.equal(calls, 1);
    time = 121000;
    await assert.rejects(get('/api/v2.2/films', 'key'), { status: 502 });
    assert.equal(db.prepare('SELECT count(*) AS n FROM catalog_cache').get().n, 0);
  } finally { db.close(); }
});
