// ======================================================
// POST /api/ml/auto-sync-listings
// Auto-sync inteligente: busca itens no ML → compara sync_compare_snapshot;
// só reprocessa (persist completo + health) quando houver mudança relevante.
//
// Por padrão: GET /items/:id por anúncio (preço mais atual que multiget GET /items?ids=).
// Multiget leve (pode trazer price defasado): ML_AUTO_SYNC_USE_MULTIGET=1.
//
// Limite: visitas/taxas no snapshot refletem o último health salvo no banco até
// o próximo persist profundo; evolução: multiget de visits ou job dedicado.
// ======================================================

import { requireAuthUser } from "./_helpers/requireAuthUser.js";
import { getValidMLToken } from "./_helpers/mlToken.js";
import { ML_MARKETPLACE_SLUG } from "./_helpers/mlMarketplace.js";
import {
  enrichItemWithListingPricesFees,
  fetchItem,
  fetchItemsByIds,
  fetchItemsDetailByIds,
  fetchItemDescription,
} from "./_helpers/mercadoLibreItemsApi.js";
import { persistMercadoLibreListing } from "./_helpers/mlListingsPersist.js";
import { extractSellerSku } from "./_helpers/mlItemSkuExtract.js";
import {
  buildListingSyncCompareSnapshot,
  diffListingSnapshotKeys,
  inferNeedsAttention,
  inferPrimarySyncReason,
  listingSnapshotsEqual,
} from "./_helpers/listingSyncSnapshot.js";

const MAX_LISTINGS = Math.min(
  2000,
  Math.max(20, parseInt(process.env.ML_AUTO_SYNC_MAX_LISTINGS || "400", 10) || 400)
);
const PERSIST_CONCURRENCY = Math.min(
  6,
  Math.max(1, parseInt(process.env.ML_AUTO_SYNC_PERSIST_CONCURRENCY || "2", 10) || 2)
);
const ENRICH_CONCURRENCY = Math.min(
  8,
  Math.max(1, parseInt(process.env.ML_AUTO_SYNC_ENRICH_CONCURRENCY || "6", 10) || 6)
);
/** Multiget GET /items?ids= — opt-in; default é um GET /items/:id por ID (preço mais confiável). */
const AUTO_SYNC_USE_MULTIGET = process.env.ML_AUTO_SYNC_USE_MULTIGET === "1";

export default async function handleMlListingsAutoSync(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  const userId = user.id;
  const logPrefix = "[ml/auto-sync-listings]";

  try {
    let accessToken;
    try {
      accessToken = await getValidMLToken(userId);
    } catch (e) {
      console.error(logPrefix, "token_error", { message: e?.message, userId });
      return res.status(401).json({
        ok: false,
        error: "Não foi possível obter token válido do Mercado Livre.",
      });
    }

    const { data: rows, error: qErr } = await supabase
      .from("marketplace_listings")
      .select("id, external_listing_id, sync_compare_snapshot")
      .eq("user_id", userId)
      .eq("marketplace", ML_MARKETPLACE_SLUG)
      .order("api_last_seen_at", { ascending: true })
      .limit(MAX_LISTINGS);

    if (qErr) {
      console.error(logPrefix, "listings_query", qErr);
      return res.status(500).json({ ok: false, error: "Erro ao carregar anúncios" });
    }

    const listings = rows ?? [];
    if (listings.length === 0) {
      return res.status(200).json({
        ok: true,
        message: "Nenhum anúncio para verificar.",
        summary: {
          checked: 0,
          unchanged: 0,
          updated: 0,
          skipped_no_item: 0,
          failed: 0,
        },
      });
    }

    const { data: healthRows, error: hErr } = await supabase
      .from("marketplace_listing_health")
      .select(
        "external_listing_id, visits, sale_fee_percent, sale_fee_amount, shipping_cost, net_receivable, promotion_price, listing_quality_score, listing_quality_status, shipping_logistic_type"
      )
      .eq("user_id", userId)
      .eq("marketplace", ML_MARKETPLACE_SLUG);

    if (hErr) {
      console.error(logPrefix, "health_query", hErr);
      return res.status(500).json({ ok: false, error: "Erro ao carregar saúde dos anúncios" });
    }

    /** @type {Map<string, Record<string, unknown>>} */
    const healthByExt = new Map();
    for (const h of healthRows || []) {
      if (h.external_listing_id) healthByExt.set(String(h.external_listing_id).trim(), h);
    }

    const externalIds = listings.map((l) => String(l.external_listing_id).trim()).filter(Boolean);
    /** @type {Map<string, Record<string, unknown>>} */
    let itemsMap;
    try {
      itemsMap = AUTO_SYNC_USE_MULTIGET
        ? await fetchItemsByIds(accessToken, externalIds)
        : await fetchItemsDetailByIds(accessToken, externalIds, ENRICH_CONCURRENCY);
    } catch (e) {
      console.error(logPrefix, AUTO_SYNC_USE_MULTIGET ? "multiget_failed" : "items_detail_failed", {
        message: e?.message,
      });
      return res.status(502).json({
        ok: false,
        error: e?.message || "Falha ao consultar itens no Mercado Livre.",
      });
    }

    /** @type {Map<string, Record<string, unknown>>} */
    const itemsForCompare = new Map();
    const rowsWithItem = listings.filter((row) => itemsMap.has(String(row.external_listing_id).trim()));
    for (let i = 0; i < rowsWithItem.length; i += ENRICH_CONCURRENCY) {
      const chunk = rowsWithItem.slice(i, i + ENRICH_CONCURRENCY);
      await Promise.all(
        chunk.map(async (row) => {
          const ext = String(row.external_listing_id).trim();
          const item = itemsMap.get(ext);
          if (!item) return;
          const health = healthByExt.get(ext) || {};
          const enriched = await enrichItemWithListingPricesFees(accessToken, item, {
            healthSync: true,
          });
          itemsForCompare.set(ext, enriched);
        })
      );
    }

    /** @type {{ row: object; item: Record<string, unknown>; reason: string; keys: string[]; needsAttention: boolean }[]} */
    const toRefresh = [];

    let skipped_no_item = 0;
    let unchanged = 0;

    for (const row of listings) {
      const ext = String(row.external_listing_id).trim();
      const item = itemsMap.get(ext);
      if (!item) {
        skipped_no_item += 1;
        continue;
      }

      const health = healthByExt.get(ext) || {};
      const itemCompared = itemsForCompare.get(ext) ?? item;
      const sku = extractSellerSku(itemCompared);
      const candidate = buildListingSyncCompareSnapshot(itemCompared, health, sku);
      const prev = row.sync_compare_snapshot && typeof row.sync_compare_snapshot === "object"
        ? row.sync_compare_snapshot
        : {};

      if (listingSnapshotsEqual(prev, candidate)) {
        unchanged += 1;
        continue;
      }

      const keys = diffListingSnapshotKeys(
        /** @type {Record<string, unknown>} */ (prev),
        candidate
      );
      toRefresh.push({
        row,
        item,
        reason: inferPrimarySyncReason(keys),
        keys,
        needsAttention: inferNeedsAttention(keys),
      });
    }

    let updated = 0;
    let failed = 0;
    const failures = [];

    async function refreshOne(entry) {
      const { row, item, reason, keys, needsAttention } = entry;
      const extId = item?.id != null ? String(item.id) : String(row.external_listing_id);
      const ext = String(row.external_listing_id).trim();
      const enriched = itemsForCompare.get(ext) ?? item;

      /**
       * Com multiget, o body vem resumido — segundo GET /items/:id preenche fotos/URLs.
       * Com fetchItemsDetailByIds, `item` já é o GET completo; não duplicar chamada.
       */
      let itemToPersist = enriched && typeof enriched === "object" ? { ...enriched } : item;
      if (AUTO_SYNC_USE_MULTIGET) {
        try {
          const fullItem = await fetchItem(accessToken, extId);
          if (fullItem && typeof fullItem === "object" && fullItem.id != null) {
            itemToPersist = {
              ...itemToPersist,
              ...fullItem,
              pictures:
                Array.isArray(fullItem.pictures) && fullItem.pictures.length > 0
                  ? fullItem.pictures
                  : itemToPersist.pictures,
            };
          }
        } catch (fe) {
          console.warn(logPrefix, "fetch_item_full_fallback", { extId, message: fe?.message });
        }
      }

      let description = null;
      try {
        description = await fetchItemDescription(accessToken, extId);
      } catch (de) {
        console.warn(logPrefix, "description_skip", { extId, message: de?.message });
      }

      try {
        await persistMercadoLibreListing(supabase, userId, itemToPersist, description, {
          log: (m, x) => console.log(logPrefix, m, { external_listing_id: extId, ...x }),
          accessToken,
          syncReason: reason,
          touchAutoSyncAt: true,
          needsAttention,
        });

        await supabase.from("marketplace_listing_change_events").insert({
          listing_id: row.id,
          user_id: userId,
          marketplace: ML_MARKETPLACE_SLUG,
          external_listing_id: String(row.external_listing_id),
          reason,
          changed_fields: keys,
        });

        updated += 1;
      } catch (err) {
        failed += 1;
        failures.push({
          external_listing_id: extId,
          error: err?.message || String(err),
        });
        console.error(logPrefix, "persist_failed", { extId, error: err?.message });
      }
    }

    for (let i = 0; i < toRefresh.length; i += PERSIST_CONCURRENCY) {
      const chunk = toRefresh.slice(i, i + PERSIST_CONCURRENCY);
      await Promise.all(chunk.map((e) => refreshOne(e)));
    }

    const message =
      updated === 0
        ? "Nenhum anúncio precisou de atualização."
        : `${updated} anúncio(s) atualizado(s) com base em mudanças detectadas.`;

    return res.status(200).json({
      ok: true,
      message,
      summary: {
        checked: listings.length,
        unchanged,
        updated,
        skipped_no_item,
        failed,
        candidates: toRefresh.length,
      },
      failures: failures.slice(0, 50),
    });
  } catch (err) {
    console.error(logPrefix, "fatal", err);
    return res.status(500).json({ ok: false, error: err?.message || "Erro interno" });
  }
}
