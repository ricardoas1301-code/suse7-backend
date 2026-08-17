// ============================================================
// S7 — Concorrência: cache em memória para resolução de vendas
// ============================================================

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

/** @type {Map<string, { expiresAt: number; value: unknown }>} */
const cache = new Map();

function cacheTtlMs() {
  const raw = Number(process.env.S7_COMPETITION_SALES_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}

export function salesHintCacheKey(itemId) {
  return `ml:sales:${String(itemId || "").trim().toUpperCase()}`;
}

export function getSalesHintCached(itemId) {
  const key = salesHintCacheKey(itemId);
  const row = cache.get(key);
  if (!row) return null;
  if (Date.now() > row.expiresAt) {
    cache.delete(key);
    return null;
  }
  return row.value;
}

export function setSalesHintCached(itemId, value) {
  const key = salesHintCacheKey(itemId);
  cache.set(key, { value, expiresAt: Date.now() + cacheTtlMs() });
}

export function clearSalesHintCacheForTests() {
  cache.clear();
}
