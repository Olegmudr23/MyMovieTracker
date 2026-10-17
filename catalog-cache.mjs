const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Only public provider responses belong here; never sessions or user collections.
export function createCatalogCache(db, { fetcher = fetch, now = Date.now } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS catalog_cache (
    path TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL, stale_until INTEGER NOT NULL
  );`);
  const pending = new Map();
  let retryAfter = 0;
  const unavailable = () => Object.assign(new Error('Каталог временно недоступен. Попробуйте позже.'), { status: 502 });

  return async function get(path, key) {
    if (!key) return null;
    const old = db.prepare('SELECT * FROM catalog_cache WHERE path=?').get(path);
    const time = now();
    if (old && old.expires > time) return JSON.parse(old.data);
    if (pending.has(path)) return pending.get(path);
    const fallback = () => {
      if (old && old.stale_until > now()) return JSON.parse(old.data);
      throw unavailable();
    };
    if (retryAfter > time) return fallback();

    const request = (async () => {
      try {
        const response = await fetcher('https://kinopoiskapiunofficial.tech' + path, {
          headers: { 'X-API-KEY': key }, signal: AbortSignal.timeout(10000)
        });
        if (!response.ok) {
          const seconds = Number(response.headers?.get('retry-after'));
          retryAfter = now() + (response.status === 429 && seconds > 0
            ? Math.min(seconds * 1000, DAY) : 60000);
          return fallback();
        }
        const data = await response.json();
        const detail = /^\/api\/v2\.2\/films\/\d+$/.test(path);
        if (detail ? !Number.isInteger(data?.kinopoiskId) : !Array.isArray(data?.items)) throw unavailable();
        const expires = now() + (detail ? 7 * DAY : 6 * HOUR);
        db.prepare(`INSERT INTO catalog_cache VALUES (?,?,?,?) ON CONFLICT(path)
          DO UPDATE SET data=excluded.data,expires=excluded.expires,stale_until=excluded.stale_until`)
          .run(path, JSON.stringify(data), expires, expires + 7 * DAY);
        db.prepare('DELETE FROM catalog_cache WHERE stale_until<=?').run(now());
        db.prepare(`DELETE FROM catalog_cache WHERE path IN (
          SELECT path FROM catalog_cache ORDER BY expires DESC LIMIT -1 OFFSET 3000
        )`).run();
        return data;
      } catch {
        retryAfter = Math.max(retryAfter, now() + 60000);
        return fallback();
      }
    })();
    pending.set(path, request);
    try { return await request; } finally { pending.delete(path); }
  };
}
