// ======================================================================
// Idempotência de criação de forma de pagamento — evita duplicidade por retry
// ======================================================================

const TTL_MS = 15 * 60 * 1000;

/** @type {Map<string, { expiresAt: number; promise?: Promise<unknown>; result?: unknown }>} */
const createCache = new Map();

/**
 * @param {string} userId
 * @param {string | null | undefined} idempotencyKey
 * @param {() => Promise<unknown>} fn
 */
export async function withPaymentMethodCreateIdempotency(userId, idempotencyKey, fn) {
  const key = typeof idempotencyKey === "string" ? idempotencyKey.trim() : "";
  if (!key) return fn();

  const cacheKey = `${userId}:${key}`;
  const now = Date.now();
  const existing = createCache.get(cacheKey);
  if (existing && existing.expiresAt > now) {
    if (existing.promise) return existing.promise;
    if (existing.result !== undefined) return existing.result;
  }

  const promise = fn()
    .then((result) => {
      createCache.set(cacheKey, { result, expiresAt: Date.now() + TTL_MS });
      return result;
    })
    .catch((error) => {
      createCache.delete(cacheKey);
      throw error;
    });

  createCache.set(cacheKey, { promise, expiresAt: now + TTL_MS });
  return promise;
}

/** Expõe limpeza para testes unitários. */
export function resetPaymentMethodCreateIdempotencyCacheForTests() {
  createCache.clear();
}
