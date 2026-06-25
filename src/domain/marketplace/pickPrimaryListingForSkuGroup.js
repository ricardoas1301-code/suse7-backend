// ======================================================================
// Prioridade de anúncio principal por SKU (S1).
// a) ativo  b) maior venda  c) mais recente  d) primeiro importado
// ======================================================================

/** @param {string | null | undefined} status */
function listingStatusScore(status) {
  const s = String(status || "").trim().toLowerCase();
  if (s === "active") return 300;
  if (s === "paused") return 200;
  if (s === "under_review" || s === "payment_required") return 150;
  if (s === "closed" || s === "inactive") return 50;
  return 100;
}

/** @param {unknown} raw */
function parseIsoMs(raw) {
  if (raw == null || String(raw).trim() === "") return 0;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : 0;
}

/**
 * @typedef {{
 *   listingId: string;
 *   item: Record<string, unknown>;
 *   description: object | null;
 *   extId: string;
 *   resolvedSku: string;
 *   importOrder?: number;
 * }} SkuGroupListingEntry
 */

/**
 * @param {SkuGroupListingEntry[]} entries
 * @returns {SkuGroupListingEntry | null}
 */
export function pickPrimaryListingForSkuGroup(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  if (entries.length === 1) return entries[0];

  const scored = entries.map((e, index) => {
    const item = e.item || {};
    const statusScore = listingStatusScore(item.status);
    const sold = Number(item.sold_quantity);
    const soldScore = Number.isFinite(sold) && sold > 0 ? Math.min(sold, 999_999) : 0;
    const updatedMs = parseIsoMs(item.last_updated);
    const createdMs = parseIsoMs(item.date_created);
    const recencyMs = Math.max(updatedMs, createdMs);
    const importOrder = Number.isFinite(e.importOrder) ? Number(e.importOrder) : index;

    return {
      entry: e,
      sortKey: [statusScore, soldScore, recencyMs, -importOrder],
    };
  });

  scored.sort((a, b) => {
    for (let i = 0; i < a.sortKey.length; i += 1) {
      if (b.sortKey[i] !== a.sortKey[i]) return b.sortKey[i] - a.sortKey[i];
    }
    return 0;
  });

  return scored[0]?.entry ?? entries[0];
}
