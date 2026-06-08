// ======================================================
// API Mercado Livre — pedidos (orders) do vendedor
// Documentação: GET /orders/search?seller= + GET /orders/:id
// Base: api.mercadolibre.com
//
// Diagnóstico comum: results vazio com HTTP 200 — conferir seller_id (deve ser o
// mesmo user id do token: GET /users/me) e escopos OAuth (read / offline_access).
//
// Retries / timeout / limite de concorrência por conta (rate limit seguro).
// Nunca logar tokens ou Authorization.
// ======================================================

const ML_API = "https://api.mercadolibre.com";
const LOG_PREFIX = "[ml/orders]";

/** @type {{ rateLimitCount: number; retryCount: number; timeoutCount: number }} */
let drainRequestMetrics = { rateLimitCount: 0, retryCount: 0, timeoutCount: 0 };

export function resetMlDrainRequestMetrics() {
  drainRequestMetrics = { rateLimitCount: 0, retryCount: 0, timeoutCount: 0 };
}

export function snapshotMlDrainRequestMetrics() {
  return { ...drainRequestMetrics };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveMlTimeoutMs() {
  return Math.min(
    120000,
    Math.max(3000, parseInt(process.env.ML_REQUEST_TIMEOUT_MS || "28000", 10) || 28000)
  );
}

function resolveMlMaxRetries() {
  return Math.min(8, Math.max(0, parseInt(process.env.ML_REQUEST_MAX_RETRIES || "4", 10) || 4));
}

function resolvePerAccountConcurrency() {
  return Math.min(
    10,
    Math.max(1, parseInt(process.env.ML_SYNC_MAX_CONCURRENT_REQUESTS_PER_ACCOUNT || "3", 10) || 3)
  );
}

/** @type {Map<string, (fn: () => Promise<any>) => Promise<any>>} */
const accountSemaphores = new Map();

/**
 * @param {string} accountKey
 */
function getAccountLimiter(accountKey) {
  const key = accountKey && String(accountKey).trim() !== "" ? String(accountKey).trim() : "__global__";
  let limiter = accountSemaphores.get(key);
  if (!limiter) {
    const limit = resolvePerAccountConcurrency();
    let active = 0;
    /** @type {{ fn: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }[]} */
    const queue = [];
    const pump = () => {
      while (active < limit && queue.length > 0) {
        const job = queue.shift();
        if (!job) break;
        active += 1;
        Promise.resolve()
          .then(() => job.fn())
          .then(job.resolve, job.reject)
          .finally(() => {
            active -= 1;
            pump();
          });
      }
    };
    limiter = (fn) =>
      new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        pump();
      });
    accountSemaphores.set(key, limiter);
  }
  return limiter;
}

/**
 * @param {string} url
 */
function scrubMlUrlForLog(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "(bad_url)";
  }
}

/**
 * @param {string} accessToken
 * @param {string} url
 * @param {{ op: string; marketplaceAccountId?: string | null; sellerId?: string | null }} logCtx
 */
async function mlFetchJsonAuthenticated(accessToken, url, logCtx) {
  const timeoutMs = resolveMlTimeoutMs();
  const maxRetries = resolveMlMaxRetries();
  let attempt = 0;

  while (true) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      const json = await res.json().catch(() => ({}));

      if (res.status === 429) {
        drainRequestMetrics.rateLimitCount += 1;
        console.info("[S7][ml-rate-limit-hit]", {
          op: logCtx.op,
          path: scrubMlUrlForLog(url),
          status: res.status,
          attempt,
          marketplaceAccountId: logCtx.marketplaceAccountId ?? null,
          sellerId: logCtx.sellerId ?? null,
        });
      }

      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < maxRetries) {
        drainRequestMetrics.retryCount += 1;
        const ra = res.headers.get("retry-after");
        let backoffMs = Math.min(60000, 500 * 2 ** attempt);
        if (ra != null && String(ra).trim() !== "") {
          const sec = Number(ra);
          if (Number.isFinite(sec)) backoffMs = Math.min(60000, Math.max(500, sec * 1000));
        }
        console.info("[S7][ml-request-retry]", {
          op: logCtx.op,
          path: scrubMlUrlForLog(url),
          status: res.status,
          attempt: attempt + 1,
          backoffMs,
          marketplaceAccountId: logCtx.marketplaceAccountId ?? null,
        });
        attempt += 1;
        await sleep(backoffMs);
        continue;
      }

      if (!res.ok) {
        const err = new Error(json?.message || json?.error || `ML HTTP ${res.status}`);
        err.status = res.status;
        err.body = json;
        throw err;
      }

      return json;
    } catch (e) {
      clearTimeout(timer);
      const aborted = e && typeof e === "object" && /** @type {Error & { name?: string }} */ (e).name === "AbortError";
      if (aborted) {
        drainRequestMetrics.timeoutCount += 1;
        console.info("[S7][ml-request-timeout]", {
          op: logCtx.op,
          path: scrubMlUrlForLog(url),
          timeoutMs,
          attempt,
          marketplaceAccountId: logCtx.marketplaceAccountId ?? null,
        });
        if (attempt < maxRetries) {
          drainRequestMetrics.retryCount += 1;
          console.info("[S7][ml-request-retry]", {
            reason: "timeout",
            op: logCtx.op,
            path: scrubMlUrlForLog(url),
            attempt: attempt + 1,
            marketplaceAccountId: logCtx.marketplaceAccountId ?? null,
          });
          attempt += 1;
          await sleep(Math.min(20000, 800 * 2 ** attempt));
          continue;
        }
      }

      const msg = e && typeof e === "object" && "message" in e ? String(/** @type {{ message?: string }} */ (e).message) : String(e);
      const networkRetry =
        !aborted &&
        attempt < maxRetries &&
        !(e && typeof e === "object" && "status" in e && typeof /** @type {{ status?: number }} */ (e).status === "number");

      if (networkRetry) {
        drainRequestMetrics.retryCount += 1;
        console.info("[S7][ml-request-retry]", {
          reason: "fetch_error",
          op: logCtx.op,
          path: scrubMlUrlForLog(url),
          attempt: attempt + 1,
          message: msg.slice(0, 200),
          marketplaceAccountId: logCtx.marketplaceAccountId ?? null,
        });
        attempt += 1;
        await sleep(Math.min(20000, 600 * 2 ** attempt));
        continue;
      }

      throw e;
    }
  }
}

/**
 * Perfil do usuário autenticado pelo token (id numérico = vendedor em /orders/search).
 * @param {string} accessToken
 * @param {{ marketplaceAccountId?: string | null }} [ctx]
 */
export async function fetchMercadoLibreUserMe(accessToken, ctx = {}) {
  const accountKey =
    ctx.marketplaceAccountId != null && String(ctx.marketplaceAccountId).trim() !== ""
      ? String(ctx.marketplaceAccountId).trim()
      : "__users_me__";
  const limiter = getAccountLimiter(accountKey);
  return limiter(async () => {
    const url = `${ML_API}/users/me`;
    const json = await mlFetchJsonAuthenticated(accessToken, url, {
      op: "users/me",
      marketplaceAccountId: ctx.marketplaceAccountId ?? null,
    });
    return json;
  });
}

/**
 * Extrai id de pedido de um elemento de `results` (formato ML varia).
 */
function resultToOrderId(entry) {
  if (entry == null) return null;
  if (typeof entry === "number" || typeof entry === "string") return String(entry);
  if (typeof entry === "object") {
    if (entry.id != null) return String(entry.id);
    if (entry.order_id != null) return String(entry.order_id);
  }
  return null;
}

/**
 * Sort explícito em /orders/search (nunca depender do default da API).
 * `date_asc` costuma paginar de forma mais estável em janelas de data.
 * @returns {"date_asc" | "date_desc" | null}
 */
export function resolveMlOrdersSearchSort() {
  if (process.env.ML_ORDERS_SEARCH_NO_SORT === "1") return null;
  const raw = String(process.env.ML_ORDERS_SEARCH_SORT || "date_asc").trim().toLowerCase();
  if (raw === "date_desc" || raw === "date_descending") return "date_desc";
  if (raw === "date_asc" || raw === "date_ascending") return "date_asc";
  return "date_asc";
}

/**
 * Busca página de pedidos do vendedor.
 * @param {string} accessToken
 * @param {string} sellerId — deve ser o id numérico do vendedor (ex.: users/me.id)
 * @param {number} offset
 * @param {number} limit — até 50 é seguro na maioria dos sites
 * @param {{
 *   dateFrom?: string | null;
 *   dateTo?: string | null;
 *   marketplaceAccountId?: string | null;
 *   sort?: "date_asc" | "date_desc" | null;
 * }} [options]
 */
export async function searchSellerOrdersPage(accessToken, sellerId, offset, limit, options = {}) {
  const qs = new URLSearchParams({
    seller: String(sellerId).trim(),
    offset: String(offset),
    limit: String(limit),
  });
  const sort = options.sort !== undefined ? options.sort : resolveMlOrdersSearchSort();
  if (sort) qs.set("sort", sort);
  const dateFrom =
    options?.dateFrom != null && String(options.dateFrom).trim() !== ""
      ? String(options.dateFrom).trim()
      : null;
  const dateTo =
    options?.dateTo != null && String(options.dateTo).trim() !== ""
      ? String(options.dateTo).trim()
      : null;
  if (dateFrom) qs.set("order.date_created.from", dateFrom);
  if (dateTo) qs.set("order.date_created.to", dateTo);

  const url = `${ML_API}/orders/search?${qs.toString()}`;
  const mpAcct =
    options?.marketplaceAccountId != null && String(options.marketplaceAccountId).trim() !== ""
      ? String(options.marketplaceAccountId).trim()
      : `seller:${String(sellerId).trim()}`;

  console.log(`${LOG_PREFIX} seller=${sellerId}`);
  console.log(`${LOG_PREFIX} request`, {
    path: scrubMlUrlForLog(url),
    offset,
    limit,
    sort: sort ?? "(omit)",
    date_from: dateFrom,
    date_to: dateTo,
  });

  const limiter = getAccountLimiter(mpAcct);
  const json = await limiter(async () =>
    mlFetchJsonAuthenticated(accessToken, url, {
      op: "orders/search",
      marketplaceAccountId: options?.marketplaceAccountId ?? null,
      sellerId: String(sellerId).trim(),
    })
  );

  const paging = json.paging || { total: 0, offset: 0, limit };
  const rawResults = Array.isArray(json.results) ? json.results : [];
  const orderIds = rawResults.map(resultToOrderId).filter(Boolean);

  console.log(`${LOG_PREFIX} total_results_hint=${paging.total ?? "?"}`);
  console.log(`${LOG_PREFIX} orders_returned=${orderIds.length}`);
  console.log(`${LOG_PREFIX} results_array_length=${rawResults.length}`);

  if (process.env.ML_ORDERS_LOG_RAW === "1") {
    try {
      const rawStr = JSON.stringify(json, null, 2);
      const max = 120000;
      console.log(
        `${LOG_PREFIX} raw_response`,
        rawStr.length > max ? `${rawStr.slice(0, max)}\n... [truncated ${rawStr.length - max} chars]` : rawStr
      );
    } catch (e) {
      console.log(`${LOG_PREFIX} raw_response stringify failed`, e?.message);
    }
  }

  if (orderIds.length === 0 && rawResults.length > 0) {
    console.warn(`${LOG_PREFIX} parse_warn results_nonempty_but_no_ids`, {
      firstKeys: rawResults[0] && typeof rawResults[0] === "object" ? Object.keys(rawResults[0]) : [],
    });
  }

  return { orderIds, paging, raw: json };
}

/**
 * Próximo offset para paginação ML: avançar pelo `limit` solicitado quando a página veio cheia;
 * caso contrário esgotou. (Evita depender só de batch.length em respostas estranhas.)
 */
export function nextOrdersSearchOffset(currentOffset, limit, ordersInPage) {
  if (ordersInPage <= 0) return currentOffset;
  if (ordersInPage < limit) return currentOffset + ordersInPage;
  return currentOffset + limit;
}

/**
 * Detalhe completo do pedido (inclui order_items, payments, shipping…).
 * @param {string} accessToken
 * @param {string} orderId
 * @param {{ marketplaceAccountId?: string | null }} [options]
 */
export async function fetchOrderById(accessToken, orderId, options = {}) {
  const url = `${ML_API}/orders/${encodeURIComponent(orderId)}`;
  const mpAcct =
    options?.marketplaceAccountId != null && String(options.marketplaceAccountId).trim() !== ""
      ? String(options.marketplaceAccountId).trim()
      : "__orders_detail__";
  const limiter = getAccountLimiter(mpAcct);
  return limiter(async () =>
    mlFetchJsonAuthenticated(accessToken, url, {
      op: "orders/detail",
      marketplaceAccountId: options?.marketplaceAccountId ?? null,
    })
  );
}

/**
 * Detalhe do envio (custo real do seller costuma vir aqui, não só no GET /orders/:id).
 * @param {string} accessToken
 * @param {string | number} shipmentId
 * @param {{ marketplaceAccountId?: string | null }} [options]
 */
export async function fetchMercadoLivreShipmentById(accessToken, shipmentId, options = {}) {
  const id = shipmentId != null ? String(shipmentId).trim() : "";
  if (!id) throw new Error("shipmentId obrigatório");
  const url = `${ML_API}/shipments/${encodeURIComponent(id)}`;
  const mpAcct =
    options?.marketplaceAccountId != null && String(options.marketplaceAccountId).trim() !== ""
      ? String(options.marketplaceAccountId).trim()
      : "__shipments_detail__";
  const limiter = getAccountLimiter(mpAcct);
  return limiter(async () =>
    mlFetchJsonAuthenticated(accessToken, url, {
      op: "shipments/detail",
      marketplaceAccountId: options?.marketplaceAccountId ?? null,
    })
  );
}

/**
 * Descontos / campanhas / estornos do pedido.
 * @param {string} accessToken
 * @param {string | number} orderId
 * @param {{ marketplaceAccountId?: string | null }} [options]
 */
/**
 * Métricas Product Ads do anúncio em um dia (atribuição agregada por data).
 * @param {string} accessToken
 * @param {string} itemId — MLB…
 * @param {string} dateYmd — YYYY-MM-DD
 * @param {{ marketplaceAccountId?: string | null; siteId?: string | null }} [options]
 */
export async function fetchMercadoLivreProductAdsItemDayMetrics(
  accessToken,
  itemId,
  dateYmd,
  options = {},
) {
  const id = itemId != null ? String(itemId).trim() : "";
  const day = dateYmd != null ? String(dateYmd).trim() : "";
  if (!id || !day) return null;

  const site = options.siteId != null && String(options.siteId).trim() !== "" ? String(options.siteId).trim() : "MLB";
  const metrics =
    "advertising_items_quantity,organic_items_quantity,direct_items_quantity,indirect_items_quantity,units_quantity";
  const url = `${ML_API}/advertising/${encodeURIComponent(site)}/product_ads/ads/${encodeURIComponent(id)}?date_from=${encodeURIComponent(day)}&date_to=${encodeURIComponent(day)}&metrics=${metrics}`;
  const mpAcct =
    options?.marketplaceAccountId != null && String(options.marketplaceAccountId).trim() !== ""
      ? String(options.marketplaceAccountId).trim()
      : "__product_ads_item__";
  const limiter = getAccountLimiter(mpAcct);
  try {
    return await limiter(async () => {
      const timeoutMs = resolveMlTimeoutMs();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
            "api-version": "2",
          },
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) return null;
        const json = await res.json().catch(() => null);
        return json && typeof json === "object" ? json : null;
      } catch {
        clearTimeout(timer);
        return null;
      }
    });
  } catch {
    return null;
  }
}

export async function fetchMercadoLivreOrderDiscountsById(accessToken, orderId, options = {}) {
  const id = orderId != null ? String(orderId).trim() : "";
  if (!id) throw new Error("orderId obrigatório");
  const url = `${ML_API}/orders/${encodeURIComponent(id)}/discounts`;
  const mpAcct =
    options?.marketplaceAccountId != null && String(options.marketplaceAccountId).trim() !== ""
      ? String(options.marketplaceAccountId).trim()
      : "__orders_discounts__";
  const limiter = getAccountLimiter(mpAcct);
  return limiter(async () =>
    mlFetchJsonAuthenticated(accessToken, url, {
      op: "orders/discounts",
      marketplaceAccountId: options?.marketplaceAccountId ?? null,
    })
  );
}

/**
 * Perfil público do usuário ML (comprador/vendedor) — costuma trazer `thumbnail` quando o GET /orders/:id não manda foto no objeto buyer.
 * @param {string} accessToken
 * @param {string} userId — id numérico ML
 * @param {{ marketplaceAccountId?: string | null }} [options]
 */
export async function fetchMercadoLibreUserById(accessToken, userId, options = {}) {
  const id = userId != null && String(userId).trim() !== "" ? String(userId).trim() : "";
  if (!id) throw new Error("userId obrigatório");
  const url = `${ML_API}/users/${encodeURIComponent(id)}`;
  const mpAcct =
    options?.marketplaceAccountId != null && String(options.marketplaceAccountId).trim() !== ""
      ? String(options.marketplaceAccountId).trim()
      : "__users_public__";
  const limiter = getAccountLimiter(mpAcct);
  return limiter(async () =>
    mlFetchJsonAuthenticated(accessToken, url, {
      op: "users/public",
      marketplaceAccountId: options?.marketplaceAccountId ?? null,
    })
  );
}
