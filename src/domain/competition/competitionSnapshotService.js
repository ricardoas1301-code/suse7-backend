// ============================================================
// S7 — Concorrência: serviço de SNAPSHOT (histórico on-demand)
//
// FUTURO (fases seguintes):
// Notificações e alertas quando snapshots diários detectarem mudanças relevantes.
// Rotina diária implementada em competitionDailySnapshotService.js
// (POST /api/jobs/competition-daily-snapshot).
// ============================================================

import { DEFAULT_CURRENCY } from "./competitionNormalizer.js";
import {
  computeEnrichStatus,
  isEnrichResultComplete,
  mergeNonemptyCompetitorPatch,
  mergeSalesHintPreserve,
  summarizeEnrichRawForLog,
} from "./competitionEnrichHelpers.js";
import { insertSnapshots, updateCompetitor } from "./competitionRepository.js";
import { enrichCompetitorForPersist } from "./competitionEnrichPersist.js";
import { completePartialCompetitorViaDiscovery } from "./competitionLinkDiscoveryCompletion.js";
import { findPrimaryListingForProduct } from "./competitionRepository.js";
import { extractListingStatus } from "./competitionSnapshotDiff.js";

function hasSnapshotPersistValue(saved, enrichExtras) {
  const shipping = enrichExtras?.shipping && typeof enrichExtras.shipping === "object" ? enrichExtras.shipping : null;
  const reputation =
    enrichExtras?.reputation && typeof enrichExtras.reputation === "object" ? enrichExtras.reputation : null;
  const enrichMeta = computeEnrichStatus(saved ?? {}, enrichExtras ?? {});
  return Boolean(
    saved?.competitor_listing_id &&
      (saved?.competitor_title || saved?.competitor_permalink) &&
      (saved?.last_seen_price != null ||
        saved?.competitor_thumbnail ||
        enrichExtras?.sales_hint ||
        enrichExtras?.listing_type ||
        enrichMeta.enrich_status === "partial" ||
        (shipping && (shipping.free_shipping === true || shipping.mode || shipping.logistic_type)) ||
        (reputation && (reputation.level_id || reputation.power_seller_status)))
  );
}

/** Grava snapshot inicial no save quando enrich trouxe meta (frete/tipo/reputação/vendas). */
export async function insertEnrichSnapshotOnSave({ supabase, userId, saved, enrichExtras, lastEnrichError = null }) {
  if (!saved?.id || !hasSnapshotPersistValue(saved, enrichExtras)) return null;

  const capturedAt = new Date().toISOString();
  const shipping = enrichExtras?.shipping && Object.keys(enrichExtras.shipping).length ? enrichExtras.shipping : null;
  const reputation =
    enrichExtras?.reputation && Object.keys(enrichExtras.reputation).length ? enrichExtras.reputation : null;
  const enrichMeta = computeEnrichStatus(saved, {
    ...enrichExtras,
    last_enrich_error: lastEnrichError,
  });

  const rows = await insertSnapshots(supabase, [
    {
      user_id: userId,
      competitor_id: saved.id,
      marketplace: saved.marketplace,
      marketplace_account_id: saved.marketplace_account_id ?? null,
      seller_company_id: saved.seller_company_id ?? null,
      product_id: saved.product_id,
      sku: saved.sku ?? null,
      competitor_listing_id: saved.competitor_listing_id,
      competitor_title: saved.competitor_title ?? null,
      competitor_price: saved.last_seen_price ?? null,
      currency: saved.last_seen_currency ?? DEFAULT_CURRENCY,
      competitor_seller_id: saved.competitor_seller_id ?? null,
      competitor_store_name: saved.competitor_store_name ?? null,
      competitor_permalink: saved.competitor_permalink ?? null,
      competitor_thumbnail: saved.competitor_thumbnail ?? null,
      shipping,
      listing_type: enrichExtras?.listing_type ?? null,
      reputation,
      sales_hint: mergeSalesHintPreserve(enrichExtras, enrichExtras?.sales_hint),
      source_strategy: saved.source_strategy ?? null,
      raw_snapshot: {
        context: "save_enrich",
        enrich_status: enrichMeta.enrich_status,
        enrich_missing_fields: enrichMeta.enrich_missing_fields,
        last_enrich_error: enrichMeta.last_enrich_error,
        competitor_pictures: Array.isArray(enrichExtras?.competitor_pictures)
          ? enrichExtras.competitor_pictures
          : null,
        listing_status: saved.competitor_listing_status ?? null,
        sales_hint_meta:
          enrichExtras?.sales_hint_source || enrichExtras?.sales_hint_confidence
            ? {
                source: enrichExtras.sales_hint_source ?? null,
                confidence: enrichExtras.sales_hint_confidence ?? null,
                checked_at: enrichExtras.sales_hint_checked_at ?? null,
              }
            : null,
      },
      captured_at: capturedAt,
    },
  ]);
  return rows[0] ?? null;
}

function pickSalesHint(raw) {
  const v = raw?.sales_hint;
  return Number.isFinite(Number(v)) && Number(v) > 0 ? Math.trunc(Number(v)) : null;
}

export async function captureCompetitorsSnapshot({
  supabase,
  accessToken,
  userId,
  product,
  competitors,
  listingRow = null,
  ownSellerId = null,
}) {
  const list = Array.isArray(competitors) ? competitors.filter((c) => c?.competitor_listing_id) : [];
  if (list.length === 0) {
    return { captured_count: 0, failed_count: 0, snapshots: [], competitors: [] };
  }

  let listingRowResolved = listingRow;
  if (!listingRowResolved && product?.id) {
    try {
      listingRowResolved = await findPrimaryListingForProduct(supabase, userId, product.id);
    } catch {
      listingRowResolved = null;
    }
  }

  const capturedAt = new Date().toISOString();
  const rows = [];
  const touchOps = [];
  let failed = 0;

  for (const comp of list) {
    const listingId = String(comp.competitor_listing_id);

    let normalized = {
      marketplace: comp.marketplace,
      competitor_listing_id: listingId,
      competitor_title: comp.competitor_title ?? null,
      competitor_seller_id: comp.competitor_seller_id ?? null,
      competitor_store_name: comp.competitor_store_name ?? null,
      competitor_permalink: comp.competitor_permalink ?? null,
      competitor_thumbnail: comp.competitor_thumbnail ?? null,
      last_seen_price: comp.last_seen_price ?? null,
      last_seen_currency: comp.last_seen_currency ?? DEFAULT_CURRENCY,
      source_strategy: comp.source_strategy ?? null,
    };

    let enrichExtras = {
      sales_hint: null,
      shipping: {},
      listing_type: null,
      reputation: {},
    };

    const enrichResult = await enrichCompetitorForPersist(accessToken, normalized, {
      sourceStrategy: comp.source_strategy ?? "ml_snapshot",
      forceFullEnrich: true,
    });
    normalized = enrichResult.normalized;
    enrichExtras = enrichResult.enrichExtras;

    if (!isEnrichResultComplete(normalized, enrichExtras) && product?.id) {
      const completion = await completePartialCompetitorViaDiscovery({
        accessToken,
        userId,
        product,
        listingRow: listingRowResolved,
        ownSellerId,
        ownListingId: listingRowResolved?.external_listing_id ?? null,
        normalized,
        enrichExtras,
        competitorId: comp.id,
        rawUrl: comp.competitor_permalink,
      });
      if (completion.matched) {
        normalized = completion.normalized;
        enrichExtras = completion.enrichExtras;
      }
    }

    const enrichPatch = {
      competitor_title: normalized.competitor_title,
      competitor_seller_id: normalized.competitor_seller_id,
      competitor_store_name: normalized.competitor_store_name,
      competitor_permalink: normalized.competitor_permalink,
      competitor_thumbnail: normalized.competitor_thumbnail,
      last_seen_price: normalized.last_seen_price,
      last_seen_currency: normalized.last_seen_currency,
    };

    const price = enrichPatch.last_seen_price != null ? enrichPatch.last_seen_price : null;
    const currency = enrichPatch.last_seen_currency || comp.last_seen_currency || DEFAULT_CURRENCY;
    const salesHint = pickSalesHint({ sales_hint: enrichExtras.sales_hint });

    if (!listingId) {
      failed += 1;
      continue;
    }

    const enrichMeta = computeEnrichStatus(normalized, enrichExtras);
    const listingStatus = normalized.competitor_listing_status ?? extractListingStatus(enrichResult.enrichedRaw);

    console.info("[COMPETITION_SAVE_PATCH]", {
      listing_id: listingId,
      context: "snapshot",
      enrich_status: enrichMeta.enrich_status,
      ...summarizeEnrichRawForLog({
        competitor_title: enrichPatch.competitor_title,
        competitor_price: price,
        competitor_thumbnail: enrichPatch.competitor_thumbnail,
        competitor_store_name: enrichPatch.competitor_store_name,
        competitor_permalink: enrichPatch.competitor_permalink,
        listing_type: enrichExtras.listing_type,
        shipping: enrichExtras.shipping,
        sales_hint: enrichExtras.sales_hint,
        reputation: enrichExtras.reputation,
      }),
    });

    rows.push({
      user_id: userId,
      competitor_id: comp.id,
      marketplace: comp.marketplace,
      marketplace_account_id: comp.marketplace_account_id ?? null,
      seller_company_id: comp.seller_company_id ?? null,
      product_id: comp.product_id,
      sku: comp.sku ?? null,
      competitor_listing_id: listingId,
      competitor_title: enrichPatch.competitor_title ?? comp.competitor_title ?? null,
      competitor_price: price,
      currency,
      competitor_seller_id: enrichPatch.competitor_seller_id ?? comp.competitor_seller_id ?? null,
      competitor_store_name: enrichPatch.competitor_store_name ?? comp.competitor_store_name ?? null,
      competitor_permalink: enrichPatch.competitor_permalink ?? comp.competitor_permalink ?? null,
      competitor_thumbnail: enrichPatch.competitor_thumbnail ?? comp.competitor_thumbnail ?? null,
      shipping:
        enrichExtras.shipping && Object.keys(enrichExtras.shipping).length ? enrichExtras.shipping : null,
      listing_type: enrichExtras.listing_type ?? null,
      reputation:
        enrichExtras.reputation && Object.keys(enrichExtras.reputation).length ? enrichExtras.reputation : null,
      sales_hint: salesHint,
      source_strategy: comp.source_strategy ?? null,
      raw_snapshot: {
        context: "snapshot_update",
        enrich_status: enrichMeta.enrich_status,
        enrich_missing_fields: enrichMeta.enrich_missing_fields,
        competitor_pictures: Array.isArray(enrichExtras?.competitor_pictures)
          ? enrichExtras.competitor_pictures
          : null,
        listing_status: normalized.competitor_listing_status ?? extractListingStatus(enrichResult.enrichedRaw),
      },
      captured_at: capturedAt,
    });

    const touchPatch = mergeNonemptyCompetitorPatch(
      {},
      {
        ...enrichPatch,
        last_captured_at: capturedAt,
        ...(price != null ? { last_seen_price: price, last_seen_currency: currency } : {}),
        ...(listingStatus ? { competitor_listing_status: listingStatus } : {}),
      }
    );
    if (
      Object.prototype.hasOwnProperty.call(normalized, "competitor_listing_status") &&
      normalized.competitor_listing_status == null
    ) {
      touchPatch.competitor_listing_status = null;
    }
    touchOps.push({ id: comp.id, patch: touchPatch });
  }

  let inserted = [];
  if (rows.length > 0) {
    inserted = await insertSnapshots(supabase, rows);

    for (const op of touchOps) {
      try {
        const saved = await updateCompetitor(supabase, userId, op.id, op.patch);
        console.info("[COMPETITION_DB_AFTER_SAVE]", {
          listing_id: saved?.competitor_listing_id ?? null,
          context: "snapshot",
          competitor_title: saved?.competitor_title ?? null,
          last_seen_price: saved?.last_seen_price != null ? String(saved.last_seen_price) : null,
          competitor_thumbnail: saved?.competitor_thumbnail ? "yes" : null,
          competitor_store_name: saved?.competitor_store_name ?? null,
        });
      } catch (e) {
        console.warn("[competition_snapshot] touch competitor failed", {
          competitor_id: op.id,
          message: e?.message ? String(e.message) : String(e),
        });
      }
    }
  }

  return { captured_count: rows.length, failed_count: failed, snapshots: inserted };
}
