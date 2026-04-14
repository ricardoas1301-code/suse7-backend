// ======================================================
// POST /api/ml/backfill-listing-health
// Regrava marketplace_listing_health com taxas do listing_prices + promo via sale_price,
// sem persistência pesada do anúncio (sem visitas/performance nesta chamada).
//
// Body opcional:
// - only_missing_fee: true — só anúncios sem sale_fee_amount no health (ou sem linha health).
//
// Usa GET /items/:id (completo) por anúncio — o multiget pode vir “fino” e falhar em taxa;
// alinha o fluxo ao persist/sync de health existente.
// Após health OK: patchMarketplaceListingScalarsFromMlItem — espelha preço nas colunas da listagem
// (o health já vinha certo; a grid priorizava marketplace_listings desatualizado).
// ======================================================

import { requireAuthUser } from "./_helpers/requireAuthUser.js";
import { getValidMLToken } from "./_helpers/mlToken.js";
import { ML_MARKETPLACE_LISTING_ALIASES, ML_MARKETPLACE_SLUG } from "./_helpers/mlMarketplace.js";
import { fetchItem } from "./_helpers/mercadoLibreItemsApi.js";
import { upsertMarketplaceListingHealthFromMlItem } from "./_helpers/mlListingHealthPersist.js";
import { patchMarketplaceListingScalarsFromMlItem } from "./_helpers/mlListingsPersist.js";
import {
  SNAPSHOT_REASON,
  SNAPSHOT_SOURCE,
} from "./_helpers/listingHealthFinancialSnapshot.js";

const ITEM_CHUNK = 30;
const CONCURRENCY = Math.min(
  8,
  Math.max(1, parseInt(process.env.ML_HEALTH_BACKFILL_CONCURRENCY || "4", 10) || 4)
);
const MAX_LISTINGS = Math.min(
  3000,
  Math.max(50, parseInt(process.env.ML_HEALTH_BACKFILL_MAX || "1500", 10) || 1500)
);

/**
 * Lista external_listing_id priorizando quem não tem tarifa persistida.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {boolean} onlyMissingFee
 */
async function resolveExternalIdsForBackfill(supabase, userId, onlyMissingFee) {
  const { data: listingRows, error: lErr } = await supabase
    .from("marketplace_listings")
    .select("external_listing_id")
    .eq("user_id", userId)
    .in("marketplace", ML_MARKETPLACE_LISTING_ALIASES)
    .limit(MAX_LISTINGS * 2);

  if (lErr) {
    console.error("[ml/backfill-listing-health] listing_query", lErr);
    return { externalIds: [], error: lErr };
  }

  const allExt = [
    ...new Set(
      (listingRows || []).map((r) => String(r.external_listing_id).trim()).filter(Boolean)
    ),
  ];

  if (!onlyMissingFee) {
    return { externalIds: allExt.slice(0, MAX_LISTINGS), error: null };
  }

  const { data: healthRows, error: hErr } = await supabase
    .from("marketplace_listing_health")
    .select("external_listing_id, sale_fee_amount")
    .eq("user_id", userId)
    .in("marketplace", ML_MARKETPLACE_LISTING_ALIASES);

  if (hErr) {
    console.error("[ml/backfill-listing-health] health_query", hErr);
    return { externalIds: [], error: hErr };
  }

  /** @type {Map<string, number | null>} */
  const feeByExt = new Map();
  for (const h of healthRows || []) {
    const id = h.external_listing_id != null ? String(h.external_listing_id).trim() : "";
    if (!id) continue;
    const a = h.sale_fee_amount != null ? Number(h.sale_fee_amount) : NaN;
    feeByExt.set(id, Number.isFinite(a) ? a : null);
  }

  const missing = [];
  for (const id of allExt) {
    const a = feeByExt.get(id);
    if (a == null || !Number.isFinite(a) || a <= 0) missing.push(id);
  }

  return { externalIds: missing.slice(0, MAX_LISTINGS), error: null };
}

export default async function handleMlListingsHealthBackfill(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  const logPrefix = "[ml/backfill-listing-health]";

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    body = {};
  }
  const onlyMissingFee = body.only_missing_fee === true || body.onlyMissingFee === true;

  let accessToken;
  try {
    accessToken = await getValidMLToken(user.id);
  } catch (e) {
    console.error(logPrefix, "token_error", e?.message);
    return res.status(401).json({ ok: false, error: "Token Mercado Livre inválido." });
  }

  try {
    const { externalIds, error: idErr } = await resolveExternalIdsForBackfill(
      supabase,
      user.id,
      onlyMissingFee
    );
    if (idErr) {
      return res.status(500).json({ ok: false, error: "Erro ao listar anúncios para backfill." });
    }

    let items_processed = 0;
    let upsert_failures = 0;
    let fetch_failures = 0;

    for (let i = 0; i < externalIds.length; i += ITEM_CHUNK) {
      const chunk = externalIds.slice(i, i + ITEM_CHUNK);
      for (let j = 0; j < chunk.length; j += CONCURRENCY) {
        const slice = chunk.slice(j, j + CONCURRENCY);
        await Promise.all(
          slice.map(async (extId) => {
            try {
              const item = await fetchItem(accessToken, extId);
              if (!item || typeof item !== "object" || item.id == null) {
                fetch_failures += 1;
                return;
              }
              const healthOk = await upsertMarketplaceListingHealthFromMlItem(
                supabase,
                user.id,
                /** @type {Record<string, unknown>} */ (item),
                {
                  accessToken,
                  skipAuxiliaryApi: true,
                  log: (m, x) => console.log(logPrefix, m, x || {}),
                  marketplace: ML_MARKETPLACE_SLUG,
                  financialSnapshot: {
                    reason: SNAPSHOT_REASON.MANUAL_BACKFILL,
                    source: SNAPSHOT_SOURCE.ML_BACKFILL,
                  },
                }
              );
              if (healthOk) {
                items_processed += 1;
                await patchMarketplaceListingScalarsFromMlItem(
                  supabase,
                  user.id,
                  ML_MARKETPLACE_SLUG,
                  /** @type {Record<string, unknown>} */ (item),
                  extId
                );
              } else upsert_failures += 1;
            } catch (e) {
              fetch_failures += 1;
              console.warn(logPrefix, "item_failed", { extId, message: e?.message });
            }
          })
        );
      }
    }

    return res.status(200).json({
      ok: true,
      message:
        "Indicadores de taxas/frete/promo atualizados a partir do Mercado Livre. Recarregue a listagem de anúncios.",
      summary: {
        only_missing_fee: onlyMissingFee,
        listing_ids: externalIds.length,
        items_processed,
        upsert_failures,
        fetch_failures,
      },
    });
  } catch (err) {
    console.error(logPrefix, "fatal", err);
    return res.status(500).json({ ok: false, error: err?.message || "Erro interno" });
  }
}
