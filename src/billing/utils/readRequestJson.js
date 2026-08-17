// ======================================================================
// Corpo JSON — compat dev-server (req.body) e Vercel/stream
// ======================================================================

import { readRequestBodyBuffer } from "../../infra/readRequestBodyBuffer.js";

/**
 * @param {import("http").IncomingMessage & { body?: unknown; bodyBuffer?: Buffer }} req
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readRequestJson(req) {
  if (req.body != null && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !Array.isArray(req.body)) {
    return /** @type {Record<string, unknown>} */ (req.body);
  }

  const buf = await readRequestBodyBuffer(req);
  const raw = buf.toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed != null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
