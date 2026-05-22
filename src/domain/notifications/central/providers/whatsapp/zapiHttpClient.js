// =============================================================================
// Cliente HTTP Z-API — Fase 3.5C.1 (timeout 5s, sem log de segredo)
// =============================================================================

import { config } from "../../../../../infra/config.js";

const DEFAULT_TIMEOUT_MS = 5000;

function envFlag(key, fallback = "") {
  const live = process.env[key];
  if (live != null && String(live).trim() !== "") return String(live).trim();
  return fallback;
}

/**
 * @returns {{ baseUrl: string; clientToken: string } | null}
 */
export function resolveZapiHttpConfig() {
  const baseUrl = envFlag("S7_ZAPI_BASE_URL", config.s7ZapiBaseUrl).replace(/\/+$/, "");
  const clientToken = envFlag(
    "S7_ZAPI_TOKEN",
    config.s7ZapiToken || config.zapiToken
  );
  if (!baseUrl) return null;
  return { baseUrl, clientToken };
}

/**
 * @param {number} status
 * @param {unknown} body
 */
export function mapZapiHttpError(status, body) {
  if (status === 401) return "AUTH_FAILED";
  if (status === 403) return "FORBIDDEN";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "PROVIDER_UNAVAILABLE";
  if (status === 400 || status === 422) return "INVALID_PAYLOAD";
  if (status >= 400) return "PROVIDER_ERROR";

  const msg =
    body && typeof body === "object" && body != null && "error" in body
      ? String(/** @type {{ error?: unknown }} */ (body).error ?? "")
      : "";
  if (msg.toLowerCase().includes("phone")) return "INVALID_PAYLOAD";
  return "PROVIDER_ERROR";
}

/**
 * @param {string} pathSuffix e.g. /send-text or /status
 * @param {{ method?: string; body?: Record<string, unknown> }} [options]
 */
export async function zapiFetch(pathSuffix, options = {}) {
  const cfg = resolveZapiHttpConfig();
  if (!cfg) {
    return {
      ok: false,
      error_code: "ZAPI_NOT_CONFIGURED",
      http_status: 0,
      duration_ms: 0,
      data: null,
    };
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  const url = `${cfg.baseUrl}${pathSuffix.startsWith("/") ? pathSuffix : `/${pathSuffix}`}`;
  const headers = { "Content-Type": "application/json" };
  if (cfg.clientToken) headers["Client-Token"] = cfg.clientToken;

  try {
    const res = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body != null ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    const duration_ms = Date.now() - started;
    let data = null;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text.slice(0, 200) };
      }
    }

    if (!res.ok) {
      return {
        ok: false,
        error_code: mapZapiHttpError(res.status, data),
        http_status: res.status,
        duration_ms,
        data,
      };
    }

    return { ok: true, http_status: res.status, duration_ms, data, error_code: null };
  } catch (err) {
    const duration_ms = Date.now() - started;
    const isAbort = err && typeof err === "object" && String(err.name) === "AbortError";
    return {
      ok: false,
      error_code: isAbort ? "TIMEOUT" : "PROVIDER_UNAVAILABLE",
      http_status: 0,
      duration_ms,
      data: null,
    };
  } finally {
    clearTimeout(timer);
  }
}
