// ======================================================
// API Mercado Livre — pedidos (orders) do vendedor
// Documentação: GET /orders/search?seller= + GET /orders/:id
// Base: api.mercadolibre.com
//
// Diagnóstico comum: results vazio com HTTP 200 — conferir seller_id (deve ser o
// mesmo user id do token: GET /users/me) e escopos OAuth (read / offline_access).
// ======================================================

const ML_API = "https://api.mercadolibre.com";
const LOG_PREFIX = "[ml/orders]";

/**
 * Perfil do usuário autenticado pelo token (id numérico = vendedor em /orders/search).
 */
export async function fetchMercadoLibreUserMe(accessToken) {
  const url = `${ML_API}/users/me`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.message || json?.error || `ML users/me HTTP ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
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
 * Busca página de pedidos do vendedor.
 * - Sem filtros de data/status (amplitude total permitida pela API).
 * - sort=date_desc: documentação (vendedor — ordenação por data).
 * - Não enviamos display= na URL: "display" no JSON é metadado da resposta, não query.
 *
 * @param {string} accessToken
 * @param {string} sellerId — deve ser o id numérico do vendedor (ex.: users/me.id)
 * @param {number} offset
 * @param {number} limit — até 50 é seguro na maioria dos sites
 */
export async function searchSellerOrdersPage(accessToken, sellerId, offset, limit) {
  const qs = new URLSearchParams({
    seller: String(sellerId).trim(),
    offset: String(offset),
    limit: String(limit),
  });
  if (process.env.ML_ORDERS_SEARCH_NO_SORT !== "1") {
    qs.set("sort", "date_desc");
  }

  const url = `${ML_API}/orders/search?${qs.toString()}`;

  console.log(`${LOG_PREFIX} seller=${sellerId}`);
  console.log(`${LOG_PREFIX} request`, {
    url,
    offset,
    limit,
    sort: process.env.ML_ORDERS_SEARCH_NO_SORT === "1" ? "(omit)" : "date_desc",
  });

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const json = await res.json().catch(() => ({}));

  const paging = json.paging || { total: 0, offset: 0, limit };
  const rawResults = Array.isArray(json.results) ? json.results : [];
  const orderIds = rawResults.map(resultToOrderId).filter(Boolean);

  console.log(`${LOG_PREFIX} http_status=${res.status}`);
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

  if (!res.ok) {
    const err = new Error(json?.message || json?.error || `ML orders/search HTTP ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
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
 */
export async function fetchOrderById(accessToken, orderId) {
  const url = `${ML_API}/orders/${encodeURIComponent(orderId)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.message || json?.error || `ML orders/${orderId} HTTP ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }

  return json;
}
