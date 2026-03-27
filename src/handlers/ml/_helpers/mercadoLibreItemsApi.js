// ======================================================
// Chamadas HTTP à API pública do Mercado Livre (itens / descrição)
// Sem lógica de persistência — apenas fetch + parse JSON.
// ======================================================

const ML_API = "https://api.mercadolibre.com";

/**
 * @param {string} accessToken
 * @param {string} sellerId - ml_user_id do vendedor
 * @param {number} offset
 * @param {number} limit - máx. típico 100
 */
export async function fetchUserItemIdsPage(accessToken, sellerId, offset, limit) {
  const url = `${ML_API}/users/${encodeURIComponent(sellerId)}/items/search?limit=${limit}&offset=${offset}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.message || json?.error || `ML search HTTP ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }

  return {
    results: Array.isArray(json.results) ? json.results : [],
    paging: json.paging || { total: 0, offset: 0, limit },
  };
}

/**
 * Detalhe completo do anúncio (inclui atributos, fotos, variações, shipping).
 */
export async function fetchItem(accessToken, itemId) {
  const url = `${ML_API}/items/${encodeURIComponent(itemId)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.message || json?.error || `ML item HTTP ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }

  return json;
}

/**
 * Descrição (texto). Alguns itens retornam 403/404 — tratar no caller.
 */
export async function fetchItemDescription(accessToken, itemId) {
  const url = `${ML_API}/items/${encodeURIComponent(itemId)}/description`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.message || json?.error || `ML description HTTP ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }

  return json;
}
