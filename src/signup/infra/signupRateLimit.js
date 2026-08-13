// =============================================================================
// Rate limit simples em memória — endpoints pré-auth de signup
// =============================================================================

/** @type {Map<string, { count: number; resetAt: number }>} */
const buckets = new Map();

const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_WINDOW = 8;

/**
 * @param {string} key
 * @returns {{ allowed: boolean; retryAfterSec?: number }}
 */
export function checkSignupRateLimit(key) {
  const now = Date.now();
  const norm = String(key || "").trim().toLowerCase() || "unknown";
  let bucket = buckets.get(norm);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(norm, bucket);
  }
  bucket.count += 1;
  if (bucket.count > MAX_PER_WINDOW) {
    return { allowed: false, retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  return { allowed: true };
}

/** @param {import('http').IncomingMessage} req */
export function resolveSignupRateLimitKey(req, email) {
  const forwarded = req.headers?.["x-forwarded-for"];
  const ip = Array.isArray(forwarded)
    ? forwarded[0]
    : String(forwarded || req.socket?.remoteAddress || "local")
        .split(",")[0]
        .trim();
  const em = String(email || "").trim().toLowerCase();
  return `${ip}|${em}`;
}
