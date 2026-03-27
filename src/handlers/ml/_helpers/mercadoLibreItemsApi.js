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

/**
 * Interpreta respostas de visitas (formatos variam entre /visits/items e /items/visits).
 * @param {unknown} json
 * @param {string} itemId
 * @returns {number | null}
 */
function parseVisitsPayload(json, itemId) {
  if (json == null) return null;
  if (typeof json === "object" && !Array.isArray(json)) {
    if (typeof json.total_visits === "number" && Number.isFinite(json.total_visits)) {
      return Math.trunc(json.total_visits);
    }
    const v = json[itemId];
    if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
    if (v && typeof v === "object") {
      if (typeof v.total === "number" && Number.isFinite(v.total)) return Math.trunc(v.total);
      if (typeof v.total_visits === "number" && Number.isFinite(v.total_visits)) {
        return Math.trunc(v.total_visits);
      }
    }
  }
  if (Array.isArray(json)) {
    for (const row of json) {
      if (!row || typeof row !== "object") continue;
      const rid = row.item_id != null ? String(row.item_id) : null;
      if (rid && rid !== itemId) continue;
      const t = row.total_visits ?? row.visits ?? row.total;
      if (typeof t === "number" && Number.isFinite(t)) return Math.trunc(t);
    }
    const first = json[0];
    if (first && typeof first === "object") {
      const t = first.total_visits ?? first.visits ?? first.total;
      if (typeof t === "number" && Number.isFinite(t)) return Math.trunc(t);
    }
  }
  return null;
}

/**
 * Total de visitas do anúncio (Bearer obrigatório). Tenta rotas em uso pelo ML.
 * @param {string} accessToken
 * @param {string} itemId
 * @returns {Promise<{ total: number | null; raw: unknown }>}
 */
export async function fetchItemVisitsTotal(accessToken, itemId) {
  const id = encodeURIComponent(itemId);
  const urls = [`${ML_API}/visits/items?ids=${id}`, `${ML_API}/items/visits?ids=${id}`];
  let lastRaw = null;
  for (const url of urls) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    const json = await res.json().catch(() => ({}));
    lastRaw = json;
    if (!res.ok) continue;
    const total = parseVisitsPayload(json, itemId);
    if (total != null) return { total, raw: json };
  }
  return { total: null, raw: lastRaw };
}

/**
 * Qualidade / experiência: /performance (preferencial) e fallback /health.
 * @param {string} accessToken
 * @param {string} itemId
 */
export async function fetchItemListingPerformance(accessToken, itemId) {
  const id = encodeURIComponent(itemId);
  const paths = [`/items/${id}/performance`, `/item/${id}/performance`, `/items/${id}/health`];
  for (const p of paths) {
    const url = `${ML_API}${p}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json && typeof json === "object" && !Array.isArray(json)) {
      return json;
    }
  }
  return null;
}
