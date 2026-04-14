// ======================================================
// GET /api/ml/listings
// Grid de anúncios: consolidação no backend (listingGridAssembler).
// ======================================================

import { requireAuthUser } from "./_helpers/requireAuthUser.js";
import {
  buildListingGridRow,
  ensureListingGridMoneyContract,
  LISTING_GRID_MONEY_CONTRACT_VERSION,
} from "./_helpers/listingGridAssembler.js";
import {
  buildListingCoverInlineTrace,
  firstProductImageUrlFromJoin,
  LISTING_COVER_INLINE_TRACE_IDS,
  normalizeMercadoLibreExternalListingId,
  resolveGalleryImageUrlsForListing,
  resolveMercadoLibreListingCoverImageUrl,
} from "./_helpers/mercadoLibreListingCoverImage.js";
import {
  getListingGridRow,
  putListingGridRowAliases,
} from "./_helpers/listingGridJoinKeys.js";
import { maybeEnrichGridRowsWithLiveListingPrices } from "./_helpers/listingGridLiveFeeEnrich.js";
import { mercadoLivreMoneyShapeDiagnostics } from "./_helpers/mercadoLivreListingMoneyShared.js";
import { mlPriceValidateLogsEnabled } from "./_helpers/mercadoLibreItemsApi.js";
import { fetchAllListingHealthRowsCompat } from "./_helpers/mlHealthSchemaCompat.js";

export default async function handleMlListingsList(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;

  try {
    const { data, error } = await supabase
      .from("marketplace_listings")
      .select(
        "id, title, marketplace, price, base_price, original_price, available_quantity, sold_quantity, status, external_listing_id, permalink, health, api_last_seen_at, currency_id, pictures_count, variations_count, seller_sku, seller_custom_field, listing_type_id, raw_json, product_id, financial_analysis_blocked, needs_attention, attention_reason, products(catalog_completeness, product_images, product_name, sku, cost_price, operational_cost, packaging_cost)"
      )
      .eq("user_id", user.id)
      .order("api_last_seen_at", { ascending: false });

    if (error) {
      console.error("[ml/listings] query_error", error);
      return res.status(500).json({ ok: false, error: "Erro ao listar anúncios" });
    }

    const listings = (data ?? []).map((row) => {
      const { products: prodRel, ...rest } = row;
      const product_catalog_completeness =
        prodRel && typeof prodRel === "object" && !Array.isArray(prodRel)
          ? /** @type {{ catalog_completeness?: string }} */ (prodRel).catalog_completeness ?? null
          : Array.isArray(prodRel) && prodRel[0]
            ? /** @type {{ catalog_completeness?: string }} */ (prodRel[0]).catalog_completeness ?? null
            : null;
      const product_cover_url = firstProductImageUrlFromJoin(prodRel);
      const pr =
        prodRel && typeof prodRel === "object" && !Array.isArray(prodRel)
          ? /** @type {Record<string, unknown>} */ (prodRel)
          : Array.isArray(prodRel) && prodRel[0] && typeof prodRel[0] === "object"
            ? /** @type {Record<string, unknown>} */ (prodRel[0])
            : null;
      const product_cost_row =
        pr != null
          ? {
              cost_price: pr.cost_price,
              operational_cost: pr.operational_cost,
              packaging_cost: pr.packaging_cost,
            }
          : null;
      const product_name =
        pr != null && pr.product_name != null && String(pr.product_name).trim() !== ""
          ? String(pr.product_name).trim()
          : null;
      const product_sku =
        pr != null && pr.sku != null && String(pr.sku).trim() !== "" ? String(pr.sku).trim() : null;
      return {
        ...rest,
        product_catalog_completeness,
        product_cover_url,
        product_cost_row,
        product_name,
        product_sku,
      };
    });
    const listingIds = listings.map((l) => l.id).filter(Boolean);

    const healthLoad = await fetchAllListingHealthRowsCompat(supabase, user.id);
    const healthRows = healthLoad.data;
    if (healthRows == null) {
      console.error("[ml/listings] health_query_error", healthLoad.error ?? "unknown");
      return res.status(500).json({ ok: false, error: "Erro ao carregar saúde dos anúncios" });
    }

    /** @type {Map<string, Record<string, unknown>>} */
    const healthByKey = new Map();
    for (const h of healthRows || []) {
      putListingGridRowAliases(healthByKey, h.marketplace, h, (r) => r.external_listing_id);
    }

    /** @type {Map<string, Array<{ secure_url?: unknown; url?: unknown; position?: unknown; raw_json?: unknown }>>} */
    const pictureRowsByListingId = new Map();
    if (listingIds.length > 0) {
      const { data: picRows, error: picErr } = await supabase
        .from("marketplace_listing_pictures")
        .select("listing_id, secure_url, url, position, raw_json")
        .in("listing_id", listingIds)
        .order("position", { ascending: true });

      if (picErr) {
        console.error("[ml/listings] pictures_query_error", picErr);
      } else {
        for (const p of picRows || []) {
          const lid = p.listing_id;
          if (lid == null || lid === "") continue;
          const key = String(lid);
          if (!pictureRowsByListingId.has(key)) pictureRowsByListingId.set(key, []);
          pictureRowsByListingId.get(key)?.push(p);
        }
      }
    }

    const { data: metricsRows, error: metErr } = await supabase
      .from("listing_sales_metrics")
      .select(
        "marketplace, external_listing_id, qty_sold_total, gross_revenue_total, net_revenue_total, commission_amount_total, shipping_share_total, orders_count, last_sale_at"
      )
      .eq("user_id", user.id);

    if (metErr) {
      console.error("[ml/listings] metrics_query_error", metErr);
      return res.status(500).json({ ok: false, error: "Erro ao carregar métricas de vendas" });
    }

    /** @type {Map<string, Record<string, unknown>>} */
    const metricsByKey = new Map();
    for (const m of metricsRows || []) {
      putListingGridRowAliases(metricsByKey, m.marketplace, m, (r) => r.external_listing_id);
    }

    const { data: profileTaxRow } = await supabase
      .from("profiles")
      .select("imposto_percentual")
      .eq("id", user.id)
      .maybeSingle();
    const sellerTaxPct =
      profileTaxRow?.imposto_percentual != null && String(profileTaxRow.imposto_percentual).trim() !== ""
        ? String(profileTaxRow.imposto_percentual).trim()
        : null;

    const gridRows = listings.map((l) => {
      const met = getListingGridRow(metricsByKey, l.marketplace, l.external_listing_id);
      const hlth = getListingGridRow(healthByKey, l.marketplace, l.external_listing_id);
      const pictureRows =
        l.id != null && l.id !== "" ? pictureRowsByListingId.get(String(l.id)) ?? [] : [];
      /** @type {{ product_cover_url?: string | null }} */
      const lx = l;
      const cover_thumbnail_url = resolveMercadoLibreListingCoverImageUrl({
        listing: /** @type {Record<string, unknown>} */ (l),
        pictureRows,
        productMainImageUrl: lx.product_cover_url ?? null,
      });
      /** @type {Record<string, unknown>} */
      const row = /** @type {Record<string, unknown>} */ (
        buildListingGridRow(String(l.marketplace), l, met, hlth, cover_thumbnail_url, { sellerTaxPct })
      );
      const gallery = resolveGalleryImageUrlsForListing(pictureRows, l.raw_json, 12);
      /** Se o resolver não devolveu HTTP válido mas a galeria tem URL, usa a 1ª (mesma ordem da capa). */
      if (
        (row.cover_thumbnail_url == null || String(row.cover_thumbnail_url).trim() === "") &&
        gallery.urls.length > 0
      ) {
        row.cover_thumbnail_url = gallery.urls[0];
        row.cover_image_url = gallery.urls[0];
      }
      row.gallery_image_urls = gallery.urls;
      row.gallery_image_source = gallery.source;
      const norm = normalizeMercadoLibreExternalListingId(l.external_listing_id);
      if (LISTING_COVER_INLINE_TRACE_IDS.has(norm)) {
        row._listing_cover_trace = buildListingCoverInlineTrace(
          /** @type {Record<string, unknown>} */ (l),
          lx.product_cover_url ?? null,
          row.cover_thumbnail_url ?? cover_thumbnail_url,
          pictureRows
        );
      }
      return row;
    });

    await maybeEnrichGridRowsWithLiveListingPrices({
      userId: user.id,
      listings: /** @type {Record<string, unknown>[]} */ (listings),
      gridRows: /** @type {Record<string, unknown>[]} */ (gridRows),
      healthByKey,
      metricsByKey,
      sellerTaxPct,
    });

    const listingsOut = gridRows.map((row) =>
      ensureListingGridMoneyContract(/** @type {Record<string, unknown>} */ (row))
    );

    if (mlPriceValidateLogsEnabled() && listingsOut.length > 0) {
      const cap = Math.min(5, listingsOut.length);
      console.info("[ML_PRICE_VALIDATE][listings_payload_prices]", {
        sample_count: cap,
        rows: listingsOut.slice(0, cap).map((r) => ({
          external_listing_id: r.external_listing_id ?? null,
          price_brl: r.price_brl ?? null,
          list_or_original_price_brl: r.list_or_original_price_brl ?? null,
          promotional_price_brl: r.promotional_price_brl ?? null,
        })),
      });
    }

    const debugExt = String(process.env.ML_LISTINGS_GRID_DEBUG_EXT_ID ?? "4473596489").trim();
    const debugOn =
      process.env.ML_LISTINGS_GRID_DEBUG === "1" ||
      (debugExt !== "" &&
        listingsOut.some((r) => String(r.external_listing_id ?? "").includes(debugExt)));
    if (debugOn) {
      const probeIdx = listings.findIndex((row) =>
        String(row.external_listing_id ?? "").includes(debugExt)
      );
      const probeListing = probeIdx >= 0 ? /** @type {Record<string, unknown>} */ (listings[probeIdx]) : null;
      const probeHealth =
        probeListing != null
          ? getListingGridRow(
              healthByKey,
              probeListing.marketplace,
              probeListing.external_listing_id
            )
          : null;
      const moneyDiag =
        probeListing != null
          ? mercadoLivreMoneyShapeDiagnostics(
              probeListing,
              /** @type {Record<string, unknown> | null | undefined} */ (probeHealth)
            )
          : null;
      const probe = listingsOut.find((r) => String(r.external_listing_id ?? "").includes(debugExt));
      if (probe) {
        const np = /** @type {Record<string, unknown> | null} */ (
          probe.net_proceeds && typeof probe.net_proceeds === "object" ? probe.net_proceeds : null
        );
        console.info("[ML_LISTINGS_GRID_ROW_PRE_RESPONSE]", {
          listing_grid_contract_version: LISTING_GRID_MONEY_CONTRACT_VERSION,
          external_listing_id: probe.external_listing_id,
          health_raw_json_loaded: Boolean(
            probeHealth &&
              typeof probeHealth === "object" &&
              "raw_json" in probeHealth &&
              probeHealth.raw_json != null
          ),
          ...moneyDiag,
          net_proceeds: probe.net_proceeds,
          insufficient_reason_final: np?.insufficient_reason ?? null,
          source_final: np?.source ?? null,
          net_proceeds_amount_final: np?.net_proceeds_amount ?? null,
          pricing_context: probe.pricing_context,
          net_receive_brl: probe.net_receive_brl,
          gross_revenue_brl: probe.gross_revenue_brl,
          legacy_imported_orders_metrics: probe.legacy_imported_orders_metrics,
        });
      } else if (process.env.ML_LISTINGS_GRID_DEBUG === "1") {
        console.info("[ML_LISTINGS_GRID_ROW_PRE_RESPONSE]", {
          listing_grid_contract_version: LISTING_GRID_MONEY_CONTRACT_VERSION,
          note: `nenhuma linha com external_listing_id contendo ${debugExt}`,
          total: listingsOut.length,
        });
      }
    }

    return res.status(200).json({
      ok: true,
      listing_grid_contract_version: LISTING_GRID_MONEY_CONTRACT_VERSION,
      /** Contrato explícito de preço/repasse — ver `docs/SUSE7_PRICING_PROTOCOL_V1.md`. */
      pricing_protocol: "suse7-pricing-v1",
      /**
       * Pricing: `listing_price_brl`, `promotion_active`, `promotional_price_brl`, `effective_sale_price_brl`.
       * Payout: `marketplace_payout_amount` + `marketplace_payout_source`. Espelhos: `net_receive_brl`, `price_brl` (legado).
       * Totais importados: `legacy_imported_orders_metrics` / gross_* (agregado, não unitário).
       */
      listings: listingsOut,
    });
  } catch (err) {
    console.error("[ml/listings] fatal", err);
    return res.status(500).json({ ok: false, error: "Erro interno" });
  }
}
