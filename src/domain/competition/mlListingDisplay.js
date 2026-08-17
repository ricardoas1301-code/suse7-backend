// ============================================================
// S7 — Concorrência: permalink e título derivados de URLs ML.
// Fallback visual quando a API não entrega título (403 em /items).
// ============================================================

const ML_ID_IN_PATH = /ML([ABCU])-?(\d{6,})/i;

/** Slug legível → título (ex.: "mesa-passadeira-dpassar" → "Mesa Passadeira Dpassar"). */
function humanizeSlug(slug) {
  const s = String(slug || "")
    .replace(/\.[a-z]{2,4}$/i, "")
    // Remove apenas sufixos técnicos (ex.: -AB12CD34), preservando palavras reais.
    .replace(/-(?=[A-Z0-9]{6,}$)(?=.*\d)[A-Z0-9]+$/i, "")
    .replace(/_/g, "-")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s || s.length < 2) return null;
  return s
    .split(" ")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : ""))
    .join(" ")
    .slice(0, 500);
}

/**
 * Extrai título legível do slug da URL/permalink ML.
 * @param {string | null | undefined} urlInput
 * @returns {string | null}
 */
export function titleFromMercadoLivrePermalink(urlInput) {
  const raw = urlInput != null ? String(urlInput).trim() : "";
  if (!raw) return null;
  try {
    const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    const path = decodeURIComponent(u.pathname);

    // produto.mercadolivre.com.br/MLB-1234567890-mesa-passadeira-...
    let m = path.match(/ML[ABCU]-?\d{6,}-(.+)/i);
    if (m?.[1]) return humanizeSlug(m[1]);

    // www.mercadolivre.com.br/mesa-passadeira-.../p/MLB123
    m = path.match(/^\/([^/]+)\/p\/ML[ABCU]/i);
    if (m?.[1] && !ML_ID_IN_PATH.test(m[1])) return humanizeSlug(m[1]);

    // Segmentos com hífen que não são só o ID MLB
    const segments = path.split("/").filter(Boolean);
    for (const seg of segments) {
      if (/^p$/i.test(seg)) continue;
      if (ML_ID_IN_PATH.test(seg) && !seg.includes("-", 4)) continue;
      if (seg.includes("-") && seg.length > 4 && !/^ML[ABCU]\d+$/i.test(seg)) {
        const t = humanizeSlug(seg);
        if (t) return t;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Monta permalink canônico a partir do listing_id quando a API não envia URL.
 * @param {string | null | undefined} listingId
 * @param {string | null | undefined} [permalinkHint]
 * @returns {string | null}
 */
export function buildMercadoLivreItemPermalink(listingId, permalinkHint = null) {
  const hint = permalinkHint != null ? String(permalinkHint).trim() : "";
  if (hint.startsWith("http")) return hint;

  const id = listingId != null ? String(listingId).trim() : "";
  if (!id) return null;
  const m = id.match(/ML([ABCU])(\d{6,})/i);
  if (!m) return null;
  return `https://produto.mercadolivre.com.br/ML${m[1].toUpperCase()}-${m[2]}`;
}

/**
 * Aceita aliases de permalink no payload (front/discover).
 * @param {Record<string, unknown> | null | undefined} src
 * @returns {string | null}
 */
export function pickPermalinkFromPayload(src) {
  if (!src || typeof src !== "object") return null;
  for (const key of ["competitor_permalink", "permalink", "url", "item_permalink"]) {
    const v = src[key];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return null;
}

/**
 * Preenche permalink/título faltantes para exibição e persistência.
 * @param {Record<string, unknown> | null | undefined} row
 * @returns {{ competitor_permalink: string | null; competitor_title: string | null }}
 */
export function applyListingDisplayFallbacks(row) {
  const r = row && typeof row === "object" ? row : {};
  const listingId = r.competitor_listing_id != null ? String(r.competitor_listing_id).trim() : "";
  let permalink =
    r.competitor_permalink != null && String(r.competitor_permalink).trim() !== ""
      ? String(r.competitor_permalink).trim()
      : null;
  if (!permalink && listingId) permalink = buildMercadoLivreItemPermalink(listingId);

  let title =
    r.competitor_title != null && String(r.competitor_title).trim() !== ""
      ? String(r.competitor_title).trim()
      : null;
  if (!title && permalink) title = titleFromMercadoLivrePermalink(permalink);

  return { competitor_permalink: permalink, competitor_title: title };
}

/**
 * Classifica a fonte principal do enrich para logs.
 * @param {string | null | undefined} via
 * @returns {'api' | 'catalog' | 'url_slug' | 'minimal'}
 */
/** Extrai product_id de catálogo de URLs `/p/MLB…`. */
export function extractCatalogProductIdFromPermalink(urlInput) {
  const raw = urlInput != null ? String(urlInput).trim() : "";
  if (!raw) return null;
  try {
    const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    const m = u.pathname.match(/\/p\/(ML[ABCU]\d{6,})/i);
    return m?.[1] ? m[1].toUpperCase() : null;
  } catch {
    const m = raw.match(/\/p\/(ML[ABCU]\d{6,})/i);
    return m?.[1] ? m[1].toUpperCase() : null;
  }
}

export function resolveEnrichSourceLabel(via) {
  const v = String(via || "").toLowerCase();
  if (!v || v === "listing_id_only") return "minimal";
  if (v.includes("url_slug")) return "url_slug";
  if (v.includes("catalog")) return "catalog";
  if (v.includes("items_api") || v.includes("items_multiget") || v === "items_api") return "api";
  if (v.includes("minimal")) return "minimal";
  return "api";
}
