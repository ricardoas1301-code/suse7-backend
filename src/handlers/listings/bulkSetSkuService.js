// ======================================================================
// Serviço: vínculo em massa listing → produto por SKU (catálogo existente).
// - Cada listing_id do payload é resolvido isoladamente (sem “pool” que
//   una candidatos de external_listing_id de tokens diferentes).
// - Lookup de produto: normalizeSkuForDbLookup (alinhado a products.normalized_sku).
// - UPDATE em lote só nos UUIDs internos efetivamente resolvidos.
// ======================================================================

import { ML_MARKETPLACE_LISTING_ALIASES, ML_MARKETPLACE_SLUG } from "../ml/_helpers/mlMarketplace.js";
import { normalizeSkuForDbLookup } from "../../domain/productCatalogCompleteness.js";
import { findProductIdByNormalizedSku } from "../ml/_helpers/mlListingProductLink.js";
import { syncListingHealthProductSnapshot } from "../ml/_helpers/syncListingHealthProductSnapshot.js";

/** @param {Record<string, unknown> | null | undefined} p */
function isListingFinancialBlocked(p) {
  if (!p) return true;
  const catOk = (p.catalog_completeness || "") === "complete";
  const compOk = p.completion_status !== "incomplete";
  const costsOk = p.missing_required_costs !== true;
  return !(catOk && compOk && costsOk);
}

/** @param {string} s */
export function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s || "").trim());
}

/** @param {string} u */
function uuidKey(u) {
  return String(u ?? "").trim().toLowerCase();
}

/**
 * Expande identificadores “curtos” (só dígitos) para candidatos MLB/MLA.
 * @param {string} raw
 * @returns {string[]}
 */
export function expandExternalListingCandidates(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return [];
  const out = new Set([s]);
  if (/^\d+$/.test(s)) {
    out.add(`MLB${s}`);
    out.add(`MLA${s}`);
  }
  return [...out];
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} effectiveSku
 */
function buildItemPayloadForSku(row, effectiveSku) {
  const extId = row.external_listing_id != null ? String(row.external_listing_id).trim() : "";

  /** @type {Record<string, unknown>} */
  const item =
    row.raw_json && typeof row.raw_json === "object" && !Array.isArray(row.raw_json)
      ? { .../** @type {Record<string, unknown>} */ (row.raw_json) }
      : {};

  if (!item.id && extId) {
    item.id = extId;
  }
  item.seller_custom_field = effectiveSku;
  item.seller_sku = effectiveSku;
  if (row.title != null && item.title == null) {
    item.title = row.title;
  }
  if (row.price != null && item.price == null) {
    item.price = row.price;
  }
  return item;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} listingId
 * @param {string} marketplace
 * @param {unknown} externalListingId
 */
async function insertBulkLinkAuditEvent(supabase, userId, listingId, marketplace, externalListingId) {
  try {
    await supabase.from("marketplace_listing_change_events").insert({
      listing_id: listingId,
      user_id: userId,
      marketplace,
      external_listing_id: String(externalListingId ?? "").trim() || "unknown",
      reason: "bulk_set_sku",
      changed_fields: ["bulk_set_sku", "seller_sku", "seller_custom_field", "product_id"],
    });
  } catch (e) {
    console.warn("[listings/bulk-set-sku] audit_insert_skip", { listingId, message: e?.message });
  }
}

/**
 * Resolve **um** token do payload (UUID interno ou id externo ML) sem misturar
 * candidatos de outros tokens.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} token
 * @param {Map<string, Record<string, unknown>>} [uuidRowMap] — opcional: linhas já carregadas por `.in('id', …)`
 */
async function resolveOneListingToken(supabase, userId, token, uuidRowMap) {
  const t = String(token ?? "").trim();
  if (!t) {
    return { ok: false, reason: "empty_token" };
  }

  if (isUuid(t)) {
    const k = uuidKey(t);
    if (uuidRowMap && uuidRowMap.has(k)) {
      return { ok: true, row: uuidRowMap.get(k) };
    }
    const { data, error } = await supabase
      .from("marketplace_listings")
      .select("id, user_id, marketplace, raw_json, external_listing_id, seller_sku, seller_custom_field, title, price, attention_reason")
      .eq("user_id", userId)
      .in("marketplace", ML_MARKETPLACE_LISTING_ALIASES)
      .eq("id", t)
      .maybeSingle();

    if (error) {
      return { ok: false, reason: "query_error", error };
    }
    if (!data) {
      return { ok: false, reason: "not_found" };
    }
    return { ok: true, row: /** @type {Record<string, unknown>} */ (data) };
  }

  const candidates = expandExternalListingCandidates(t);
  if (candidates.length === 0) {
    return { ok: false, reason: "empty_token" };
  }

  const { data, error } = await supabase
    .from("marketplace_listings")
    .select("id, user_id, marketplace, raw_json, external_listing_id, seller_sku, seller_custom_field, title, price, attention_reason")
    .eq("user_id", userId)
    .in("marketplace", ML_MARKETPLACE_LISTING_ALIASES)
    .in("external_listing_id", candidates);

  if (error) {
    return { ok: false, reason: "query_error", error };
  }
  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) {
    return { ok: false, reason: "not_found" };
  }
  if (rows.length > 1) {
    return { ok: false, reason: "ambiguous_external", count: rows.length };
  }
  return { ok: true, row: /** @type {Record<string, unknown>} */ (rows[0]) };
}

/**
 * @param {{
 *   supabase: import("@supabase/supabase-js").SupabaseClient;
 *   userId: string;
 *   canonicalMarketplace: string;
 *   skuRaw: string;
 *   listingTokens: string[];
 * }} ctx
 */
export async function executeBulkSetSku(ctx) {
  const { supabase, userId, canonicalMarketplace, skuRaw, listingTokens } = ctx;

  const normalizedForLookup = normalizeSkuForDbLookup(skuRaw);
  if (!normalizedForLookup) {
    return {
      ok: false,
      status: 400,
      body: {
        ok: false,
        error: "Informe um SKU válido.",
        total_received: listingTokens.length,
        total_updated: 0,
        total_skipped: listingTokens.length,
        errors: [],
      },
    };
  }

  const productId = await findProductIdByNormalizedSku(supabase, userId, normalizedForLookup);
  if (!productId) {
    return {
      ok: false,
      status: 422,
      body: {
        ok: false,
        error:
          "Não existe produto no seu catálogo com este SKU (incluindo variações). Cadastre o produto ou ajuste o SKU.",
        total_received: listingTokens.length,
        total_updated: 0,
        total_skipped: listingTokens.length,
        normalized_sku: normalizedForLookup,
        sku_literal: skuRaw,
        errors: [],
      },
    };
  }

  const { data: productRow, error: prodErr } = await supabase
    .from("products")
    .select("catalog_completeness, completion_status, missing_required_costs")
    .eq("id", productId)
    .eq("user_id", userId)
    .maybeSingle();

  if (prodErr || !productRow) {
    console.error("[listings/bulk-set-sku] product_load", prodErr);
    return {
      ok: false,
      status: 500,
      body: { ok: false, error: "Erro ao carregar dados do produto para vínculo.", errors: [] },
    };
  }

  const financialBlocked = isListingFinancialBlocked(productRow);

  /** UUIDs distintos do payload — um SELECT em lote só para estes ids (sem misturar com externos). */
  const uuidSeen = new Set();
  /** @type {string[]} */
  const uuidListForBatch = [];
  for (const tok of listingTokens) {
    const t = String(tok ?? "").trim();
    if (!isUuid(t)) continue;
    const k = uuidKey(t);
    if (uuidSeen.has(k)) continue;
    uuidSeen.add(k);
    uuidListForBatch.push(t);
  }

  /** @type {Map<string, Record<string, unknown>>} */
  const uuidRowMap = new Map();
  if (uuidListForBatch.length > 0) {
    const { data: uuidRows, error: uErr } = await supabase
      .from("marketplace_listings")
      .select("id, user_id, marketplace, raw_json, external_listing_id, seller_sku, seller_custom_field, title, price, attention_reason")
      .eq("user_id", userId)
      .in("marketplace", ML_MARKETPLACE_LISTING_ALIASES)
      .in("id", uuidListForBatch);

    if (uErr) {
      console.error("[listings/bulk-set-sku] uuid_batch_query", uErr);
      return {
        ok: false,
        status: 500,
        body: { ok: false, error: "Erro ao carregar anúncios.", errors: [] },
      };
    }
    for (const r of uuidRows || []) {
      if (r && r.id) uuidRowMap.set(uuidKey(String(r.id)), /** @type {Record<string, unknown>} */ (r));
    }
  }

  /** @type {Record<string, unknown>[]} */
  const uniqueRows = [];
  /** @type {Set<string>} */
  const seenInternalId = new Set();
  /** @type {{ listing_id: string; code: string; message: string }[]} */
  const errors = [];
  /** @type {Map<string, Record<string, unknown> | null>} */
  const rowByToken = new Map();

  for (const token of listingTokens) {
    const res = await resolveOneListingToken(supabase, userId, token, uuidRowMap);
    if (!res.ok || !res.row) {
      rowByToken.set(String(token), null);
      const code =
        res.reason === "ambiguous_external"
          ? "ambiguous_external"
          : res.reason === "query_error"
            ? "query_error"
            : "not_found_or_denied";
      const msg =
        res.reason === "ambiguous_external"
          ? "Mais de um anúncio encontrado para este identificador externo. Use o UUID interno do Suse7."
          : res.reason === "not_found"
            ? "Anúncio não encontrado, não pertence ao usuário ou marketplace incompatível."
            : "Não foi possível resolver o anúncio.";
      errors.push({ listing_id: String(token), code, message: msg });
      continue;
    }

    const row = res.row;
    rowByToken.set(String(token), row);
    const idKey = String(row.id);
    const mkt = row.marketplace != null ? String(row.marketplace).trim().toLowerCase() : "";
    if (mkt && mkt !== ML_MARKETPLACE_SLUG && mkt !== "mercadolivre") {
      rowByToken.set(String(token), null);
      errors.push({
        listing_id: String(token),
        code: "marketplace_mismatch",
        message: "Marketplace do anúncio não suportado nesta operação.",
      });
      continue;
    }

    if (!seenInternalId.has(idKey)) {
      seenInternalId.add(idKey);
      uniqueRows.push(row);
    }
  }

  const totalReceived = listingTokens.length;
  if (uniqueRows.length === 0) {
    return {
      ok: true,
      status: 200,
      body: {
        ok: true,
        total_received: totalReceived,
        total_updated: 0,
        total_skipped: totalReceived,
        errors,
        product_id: productId,
        normalized_sku: normalizedForLookup,
        sku_literal: skuRaw,
      },
    };
  }

  const pendingIso = new Date().toISOString();
  const idsToUpdate = uniqueRows.map((r) => String(r.id));

  const { data: updatedRows, error: updErr } = await supabase
    .from("marketplace_listings")
    .update({
      product_id: productId,
      financial_analysis_blocked: financialBlocked,
      seller_sku: skuRaw,
      seller_custom_field: skuRaw,
      needs_attention: false,
      attention_reason: null,
      updated_at: pendingIso,
    })
    .in("id", idsToUpdate)
    .eq("user_id", userId)
    .select("id");

  if (updErr) {
    console.error("[listings/bulk-set-sku] batch_update_failed", updErr);
    for (const row of uniqueRows) {
      errors.push({
        listing_id: String(row.external_listing_id ?? row.id),
        code: "batch_update_failed",
        message: updErr.message || "Falha ao atualizar anúncios em lote.",
      });
    }
    return {
      ok: false,
      status: 500,
      body: {
        ok: false,
        error: "Falha ao aplicar vínculo em lote.",
        total_received: totalReceived,
        total_updated: 0,
        total_skipped: totalReceived,
        errors,
      },
    };
  }

  const updatedIdSet = new Set((updatedRows || []).map((r) => String(r.id)));
  for (const row of uniqueRows) {
    const lid = String(row.id);
    if (!updatedIdSet.has(lid)) {
      errors.push({
        listing_id: String(row.external_listing_id ?? row.id),
        code: "update_zero_rows",
        message: "Não foi possível atualizar este anúncio (verifique permissões ou estado da linha).",
      });
    }
  }

  const rowsUpdatedCount = updatedIdSet.size;

  let tokensLinked = 0;
  for (const token of listingTokens) {
    const row = rowByToken.get(String(token));
    if (row && updatedIdSet.has(String(row.id))) {
      tokensLinked += 1;
    }
  }

  const totalSkipped = listingTokens.length - tokensLinked;

  const CONCURRENCY = 8;
  for (let i = 0; i < uniqueRows.length; i += CONCURRENCY) {
    const chunk = uniqueRows.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (row) => {
        const lid = String(row.id);
        if (!updatedIdSet.has(lid)) return;

        const item = buildItemPayloadForSku(row, skuRaw);
        const { error: rjErr } = await supabase
          .from("marketplace_listings")
          .update({ raw_json: item, updated_at: new Date().toISOString() })
          .eq("id", lid)
          .eq("user_id", userId);
        if (rjErr) {
          console.warn("[listings/bulk-set-sku] raw_json_update", { listingId: lid, message: rjErr.message });
        }

        if (row.external_listing_id) {
          void syncListingHealthProductSnapshot(
            supabase,
            userId,
            row.marketplace != null ? String(row.marketplace) : ML_MARKETPLACE_SLUG,
            row.external_listing_id,
            { product_id: productId, attention_reason: row.attention_reason },
          );
        }
        void insertBulkLinkAuditEvent(supabase, userId, lid, canonicalMarketplace, row.external_listing_id);
      }),
    );
  }

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      total_received: totalReceived,
      total_updated: rowsUpdatedCount,
      total_skipped: totalSkipped,
      errors,
      product_id: productId,
      normalized_sku: normalizedForLookup,
      sku_literal: skuRaw,
    },
  };
}
