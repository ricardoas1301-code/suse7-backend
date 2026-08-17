// ============================================================
// S7 — Concorrência: rotas de anúncios monitorados
// ============================================================

import {
  bulkInsertMonitoredListings,
  deactivateMonitoredListing,
  findListingForMonitoredListing,
  findMonitoredListingOwned,
  listActiveCompetitorsByMonitoredListing,
  listMonitoredListingsWithCompetitors,
  searchListingsForMonitoring,
} from "../../domain/competition/monitoredListingsRepository.js";
import {
  extractOwnListingSummary,
  findLatestSnapshotMetaForCompetitors,
  findOwnedProduct,
} from "../../domain/competition/competitionRepository.js";
import { toCompetitorResponse } from "../../domain/competition/competitionNormalizer.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => UUID_RE.test(String(v || "").trim());

function parseBody(req) {
  return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
}

function parseSearchQuery(req) {
  try {
    const url = new URL(req.url || "", "http://localhost");
    return url.searchParams.get("q") ?? "";
  } catch {
    return "";
  }
}

function parseSearchLimit(req) {
  try {
    const url = new URL(req.url || "", "http://localhost");
    const raw = url.searchParams.get("limit");
    return raw != null ? Number(raw) : 40;
  } catch {
    return 40;
  }
}

async function mapMonitoredCompetitorsForResponse(supabase, userId, monitoredListingId) {
  const rows = await listActiveCompetitorsByMonitoredListing(supabase, userId, monitoredListingId);
  let snapshotMeta = new Map();
  try {
    snapshotMeta = await findLatestSnapshotMetaForCompetitors(
      supabase,
      userId,
      rows.map((r) => r.id).filter(Boolean)
    );
  } catch (metaErr) {
    console.error("[competition] snapshot meta indisponível no GET monitored competitors", {
      monitored_listing_id: monitoredListingId,
      message: metaErr?.message,
      code: metaErr?.code,
    });
  }
  return rows.map((r) => {
    const meta = snapshotMeta.get(r.id) ?? {};
    return toCompetitorResponse(r, {
      sales_hint: meta.sales_hint ?? null,
      shipping: meta.shipping ?? null,
      listing_type: meta.listing_type ?? null,
      reputation: meta.reputation ?? null,
      snapshot_thumbnail: meta.competitor_thumbnail ?? null,
      snapshot_store_name: meta.competitor_store_name ?? null,
      snapshot_price: meta.competitor_price ?? null,
      snapshot_title: meta.competitor_title ?? null,
      competitor_pictures: meta.competitor_pictures ?? null,
      listing_status: meta.listing_status ?? null,
    });
  });
}

export async function handleMonitoredListingsRoute(req, res, path, method, supabase, userId) {
  if (path === "/api/competition/monitored-listings" && method === "GET") {
    const listings = await listMonitoredListingsWithCompetitors(supabase, userId);
    return res.status(200).json({ ok: true, monitored_listings: listings });
  }

  if (path === "/api/competition/listings/search" && method === "GET") {
    const query = parseSearchQuery(req);
    const limit = parseSearchLimit(req);
    const results = await searchListingsForMonitoring(supabase, userId, { query, limit });
    return res.status(200).json({ ok: true, results, total: results.length });
  }

  if (path === "/api/competition/monitored-listings" && method === "POST") {
    let body;
    try {
      body = parseBody(req);
    } catch {
      return res.status(400).json({ ok: false, error: "JSON inválido" });
    }
    const ids = Array.isArray(body?.marketplace_listing_ids)
      ? body.marketplace_listing_ids
      : Array.isArray(body?.listing_ids)
        ? body.listing_ids
        : [];
    if (!ids.length) {
      return res.status(400).json({ ok: false, error: "Informe ao menos um marketplace_listing_id" });
    }
    const result = await bulkInsertMonitoredListings(supabase, userId, ids);
    return res.status(200).json({
      ok: true,
      inserted_count: result.inserted.length,
      skipped_count: result.skipped.length,
      error_count: result.errors.length,
      inserted: result.inserted,
      skipped: result.skipped,
      errors: result.errors,
    });
  }

  const deleteMatch = path.match(/^\/api\/competition\/monitored-listings\/([^/]+)$/);
  if (deleteMatch && method === "DELETE") {
    const monitoredListingId = decodeURIComponent(deleteMatch[1]);
    if (!isUuid(monitoredListingId)) {
      return res.status(400).json({ ok: false, error: "monitored_listing_id inválido" });
    }
    const removed = await deactivateMonitoredListing(supabase, userId, monitoredListingId);
    if (!removed) {
      return res.status(404).json({ ok: false, error: "Anúncio monitorado não encontrado" });
    }
    return res.status(200).json({
      ok: true,
      monitored_listing: removed,
      message: "Anúncio removido do monitoramento.",
    });
  }

  const competitorsMatch = path.match(/^\/api\/competition\/monitored-listings\/([^/]+)\/competitors$/);
  if (competitorsMatch && method === "GET") {
    const monitoredListingId = decodeURIComponent(competitorsMatch[1]);
    if (!isUuid(monitoredListingId)) {
      return res.status(400).json({ ok: false, error: "monitored_listing_id inválido" });
    }
    const monitored = await findMonitoredListingOwned(supabase, userId, monitoredListingId);
    if (!monitored) {
      return res.status(404).json({ ok: false, error: "Anúncio monitorado não encontrado" });
    }

    const product =
      monitored.product_id != null
        ? await findOwnedProduct(supabase, userId, monitored.product_id)
        : null;
    const listingRow = await findListingForMonitoredListing(supabase, userId, monitored);
    const ownListing = extractOwnListingSummary(listingRow);
    const competitors = await mapMonitoredCompetitorsForResponse(supabase, userId, monitoredListingId);

    return res.status(200).json({
      ok: true,
      monitored_listing: {
        monitored_listing_id: monitored.id,
        marketplace_listing_id: monitored.marketplace_listing_id,
        product_id: monitored.product_id ?? null,
        sku: monitored.sku ?? product?.sku ?? null,
        product_name: monitored.product_name ?? product?.product_name ?? monitored.listing_title ?? null,
        external_listing_id: monitored.external_listing_id,
        marketplace_account_id: monitored.marketplace_account_id ?? null,
      },
      product: {
        product_id: monitored.product_id ?? product?.id ?? null,
        sku: monitored.sku ?? product?.sku ?? null,
        product_name: monitored.product_name ?? product?.product_name ?? null,
      },
      own_listing: ownListing,
      competitors,
      competitors_count: competitors.length,
    });
  }

  return null;
}
