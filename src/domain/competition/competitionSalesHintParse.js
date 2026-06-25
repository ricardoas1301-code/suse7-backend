// ============================================================
// S7 — Concorrência: extração de quantidade de vendas (ML)
// ============================================================

/** Normaliza inteiro positivo de vendas; null se inválido ou zero. */
export function normalizeSalesHintValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

/** Extrai sold_quantity de corpo JSON do ML (/items, catálogo, etc.). */
export function pickSoldQuantityFromMlBody(body) {
  if (!body || typeof body !== "object") return null;
  return normalizeSalesHintValue(body.sold_quantity);
}

/**
 * Interpreta texto público brasileiro: "324 vendidos", "+10mil vendas", "1.234 vendidos".
 * @param {string} text
 * @returns {number | null}
 */
export function parseSalesCountFromPublicText(text) {
  const src = String(text || "");
  if (!src.trim()) return null;

  const milMatch = src.match(/\+?\s*(\d{1,4})\s*mil\s+vendid/i) || src.match(/\+?\s*(\d{1,4})\s*mil\s+vendas/i);
  if (milMatch) {
    const n = Number(milMatch[1]) * 1000;
    return normalizeSalesHintValue(n);
  }

  const vendidosMatch = src.match(/(\d{1,3}(?:\.\d{3})+|\d+)\s+vendid/i);
  if (vendidosMatch) {
    const digits = vendidosMatch[1].replace(/\./g, "");
    return normalizeSalesHintValue(Number(digits));
  }

  const vendasMatch = src.match(/(\d{1,3}(?:\.\d{3})+|\d+)\s+vendas/i);
  if (vendasMatch) {
    const digits = vendasMatch[1].replace(/\./g, "");
    return normalizeSalesHintValue(Number(digits));
  }

  return null;
}

/**
 * Busca sold_quantity em blobs JSON embutidos no HTML da página pública.
 * @param {string} html
 * @returns {{ value: number | null; pattern: string | null }}
 */
export function pickSoldQuantityFromPublicHtml(html) {
  const src = String(html || "");
  if (!src) return { value: null, pattern: null };

  const jsonPatterns = [
    { re: /"sold_quantity"\s*:\s*(\d+)/i, pattern: "json_sold_quantity" },
    { re: /"quantity_sold"\s*:\s*(\d+)/i, pattern: "json_quantity_sold" },
    { re: /"total_sold"\s*:\s*(\d+)/i, pattern: "json_total_sold" },
    { re: /"past_sales"\s*:\s*"([^"]+)"/i, pattern: "json_past_sales_text" },
  ];

  for (const { re, pattern } of jsonPatterns) {
    const m = src.match(re);
    if (!m) continue;
    if (pattern === "json_past_sales_text") {
      const fromText = parseSalesCountFromPublicText(m[1]);
      if (fromText != null) return { value: fromText, pattern };
      continue;
    }
    const n = normalizeSalesHintValue(Number(m[1]));
    if (n != null) return { value: n, pattern };
  }

  const fromText = parseSalesCountFromPublicText(src);
  if (fromText != null) return { value: fromText, pattern: "html_text_vendidos" };

  return { value: null, pattern: null };
}

/** Página bloqueada por anti-bot do ML (não confiável para scraping). */
export function isMlPublicPageBlocked(html) {
  const src = String(html || "");
  return (
    src.includes("suspicious-traffic-frontend") ||
    src.includes("account-verification-main") ||
    src.includes("gz/account-verification")
  );
}
