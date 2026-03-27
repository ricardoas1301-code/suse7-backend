// ======================================================
// API Mercado Livre — pedidos (orders) do vendedor
// Documentação: GET /orders/search?seller= + GET /orders/:id
// Base: api.mercadolibre.com
// ======================================================

const ML_API = "https://api.mercadolibre.com";

/**
 * Extrai id numérico/string de um elemento da lista results (objeto ou primitivo).
 */
function resultToOrderId(entry) {
  if (entry == null) return null;
  if (typeof entry === "number" || typeof entry === "string") return String(entry);
  if (typeof entry === "object" && entry.id != null) return String(entry.id);
  return null;
}

/**
 * Busca página de IDs de pedidos do vendedor.
 * @param {string} accessToken
 * @param {string} sellerId — ml_user_id
 * @param {number} offset
 * @param {number} limit — típico até 50
 */
export async function searchSellerOrdersPage(accessToken, sellerId, offset, limit) {
  const qs = new URLSearchParams({
    seller: String(sellerId),
    offset: String(offset),
    limit: String(limit),
  });

  const url = `${ML_API}/orders/search?${qs.toString()}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.message || json?.error || `ML orders/search HTTP ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }

  const rawResults = Array.isArray(json.results) ? json.results : [];
  const orderIds = rawResults.map(resultToOrderId).filter(Boolean);
  const paging = json.paging || { total: 0, offset: 0, limit };

  return { orderIds, paging, raw: json };
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
