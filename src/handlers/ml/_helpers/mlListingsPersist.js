// ======================================================
// FASE 2 — Persistência completa de anúncios ML → marketplace_*
//
// Estratégia:
// - Principal: upsert por (marketplace, external_listing_id) com colunas normalizadas
//   + espelho de frete + contagens + raw_json completo do item.
// - Filhos (descrição, atributos, fotos, variações, shipping): DELETE por listing_id
//   e INSERT em lote → resync idempotente, sem duplicatas.
// - Snapshots: sempre novo INSERT (histórico de auditoria); payload inclui item + descrição.
// - Multi-marketplace: marketplace fixo em ML_MARKETPLACE_SLUG (constante compartilhada).
// ======================================================

import { ML_MARKETPLACE_SLUG } from "./mlMarketplace.js";
import { extractSellerSku, ATTENTION_REASON_SKU_PENDING_ML } from "./mlItemSkuExtract.js";
import { upsertMarketplaceListingHealthFromMlItem } from "./mlListingHealthPersist.js";
import { SNAPSHOT_REASON, SNAPSHOT_SOURCE } from "./listingHealthFinancialSnapshot.js";
import { buildListingSyncCompareSnapshot } from "./listingSyncSnapshot.js";
import { ensureListingLinkedToProduct } from "./mlListingProductLink.js";
import { extractMlPictureHttpFromObject } from "./mercadoLibreListingCoverImage.js";
import { fetchItem, hydrateMlItemPicturesWithPictureApi } from "./mercadoLibreItemsApi.js";

/**
 * String não vazia ou null (colunas url / secure_url no DB).
 * @param {unknown} v
 */
function mlPictureFieldTrimmedOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * @param {unknown} v
 */
function mlPictureHasUsableHttpUrl(v) {
  const s = mlPictureFieldTrimmedOrNull(v);
  if (!s) return false;
  const lower = s.toLowerCase();
  if (lower.startsWith("//")) return true;
  return lower.startsWith("http://") || lower.startsWith("https://");
}

/**
 * @param {unknown} p
 */
function mlPictureObjectHasUsableUrl(p) {
  return extractMlPictureHttpFromObject(p) != null;
}

/**
 * @param {unknown[]} pics
 */
function mlPicturesArrayHasAnyUsableUrl(pics) {
  if (!Array.isArray(pics)) return false;
  return pics.some(mlPictureObjectHasUsableUrl);
}

/**
 * marketplace_listing_pictures — position = índice no array ML; secure_url preferencial na leitura.
 * @param {unknown} p
 * @param {number} index
 * @param {string} listingId
 */
function mapMlPictureToPictureRow(p, index, listingId) {
  if (!p || typeof p !== "object" || Array.isArray(p)) {
    return {
      listing_id: listingId,
      external_picture_id: null,
      url: null,
      secure_url: null,
      position: index,
      raw_json: p,
    };
  }
  const po = /** @type {Record<string, unknown>} */ (p);
  const extracted = extractMlPictureHttpFromObject(po);
  const urlCol = mlPictureFieldTrimmedOrNull(po.url);
  const secureCol = mlPictureFieldTrimmedOrNull(po.secure_url);
  return {
    listing_id: listingId,
    external_picture_id: po.id != null ? String(po.id) : null,
    url: urlCol ?? null,
    secure_url: secureCol ?? (extracted || null),
    position: index,
    raw_json: p,
  };
}

/** @param {unknown} v */
function toFiniteNumber(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** @param {unknown} v */
function toInt(v) {
  const n = toFiniteNumber(v);
  if (n == null) return null;
  return Math.trunc(n);
}

/** @param {unknown} v */
function toText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * Extrai saúde numérica quando a API envia número ou objeto aninhado.
 * Não inventa valor se o payload não trouxer sinal claro.
 */
function extractHealth(item) {
  if (item == null) return null;
  const h = item.health;
  if (typeof h === "number" && Number.isFinite(h)) return h;
  if (h && typeof h === "object") {
    const inner = toFiniteNumber(h.health ?? h.score);
    if (inner != null) return inner <= 1 ? inner * 100 : inner;
  }
  return null;
}

/**
 * Texto de garantia: warranty direto ou sale_terms (WARRANTY / “garantia”).
 */
function extractWarrantyText(item) {
  const w = item?.warranty;
  if (w != null && String(w).trim() !== "") return String(w);

  const terms = item?.sale_terms;
  if (!Array.isArray(terms)) return null;

  for (const t of terms) {
    const id = String(t?.id || "").toUpperCase();
    const name = String(t?.name || "").toLowerCase();
    if (id.includes("WARRANTY") || name.includes("garantia")) {
      const vn = t?.value_name ?? t?.value_struct?.number ?? t?.value_struct?.unit;
      if (vn != null) return String(vn);
    }
  }
  return null;
}

/**
 * Tags do item como JSONB (array preservado; string vira [string]).
 */
function extractTagsJsonb(item) {
  const tags = item?.tags;
  if (tags == null) return null;
  if (Array.isArray(tags)) return tags;
  if (typeof tags === "object") return tags;
  return [tags];
}

/**
 * Campos de frete espelhados na tabela principal (consultas / BI sem join).
 */
function extractShippingMirror(item) {
  const sh = item?.shipping;
  if (!sh || typeof sh !== "object") {
    return {
      shipping_mode: null,
      shipping_free: null,
      shipping_local_pick_up: null,
      shipping_logistic_type: null,
    };
  }
  return {
    shipping_mode: sh.mode != null ? String(sh.mode) : null,
    shipping_free: sh.free_shipping === undefined ? null : Boolean(sh.free_shipping),
    shipping_local_pick_up: sh.local_pick_up === undefined ? null : Boolean(sh.local_pick_up),
    shipping_logistic_type: sh.logistic_type != null ? String(sh.logistic_type) : null,
  };
}

/**
 * Monta linha principal marketplace_listings a partir do JSON do item ML (GET /items/:id).
 */
export function mapMlItemToListingRow(userId, item, nowIso) {
  const id = item?.id != null ? String(item.id) : null;
  if (!id) throw new Error("Item ML sem id");

  const pics = Array.isArray(item.pictures) ? item.pictures : [];
  const vars = Array.isArray(item.variations) ? item.variations : [];
  const ship = extractShippingMirror(item);

  return {
    user_id: userId,
    marketplace: ML_MARKETPLACE_SLUG,
    external_listing_id: id,
    site_id: item.site_id != null ? String(item.site_id) : null,
    title: item.title ?? null,
    subtitle: item.subtitle ?? null,
    category_id: item.category_id != null ? String(item.category_id) : null,
    domain_id: item.domain_id != null ? String(item.domain_id) : null,
    listing_type_id: item.listing_type_id != null ? String(item.listing_type_id) : null,
    status: item.status != null ? String(item.status) : null,
    permalink: item.permalink ?? null,
    price: toFiniteNumber(item.price),
    base_price: toFiniteNumber(item.base_price),
    original_price: toFiniteNumber(item.original_price),
    currency_id: item.currency_id != null ? String(item.currency_id) : null,
    available_quantity: toInt(item.available_quantity),
    sold_quantity: toInt(item.sold_quantity),
    buying_mode: item.buying_mode != null ? String(item.buying_mode) : null,
    condition: item.condition != null ? String(item.condition) : null,
    seller_sku: extractSellerSku(item),
    seller_custom_field: toText(item.seller_custom_field),
    catalog_listing: Boolean(item.catalog_listing),
    catalog_product_id: item.catalog_product_id != null ? String(item.catalog_product_id) : null,
    official_store_id:
      item.official_store_id != null ? String(item.official_store_id) : null,
    inventory_id: item.inventory_id != null ? String(item.inventory_id) : null,
    warranty_text: extractWarrantyText(item),
    accepts_mercadopago:
      item.accepts_mercadopago === undefined ? null : Boolean(item.accepts_mercadopago),
    tags: extractTagsJsonb(item),
    pictures_count: pics.length,
    variations_count: vars.length,
    health: extractHealth(item),
    date_created: item.date_created
      ? String(item.date_created)
      : item.start_time
        ? String(item.start_time)
        : null,
    last_updated: item.last_updated ? String(item.last_updated) : null,
    api_imported_at: nowIso,
    api_last_seen_at: nowIso,
    raw_json: item,
    updated_at: nowIso,
    ...ship,
  };
}

/**
 * Espelha preço/tipo do item ML nas colunas de `marketplace_listings` sem persistência completa.
 * Usar após health sync (backfill / refresh existentes) para alinhar grid ao GET /items/:id.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} marketplace
 * @param {Record<string, unknown>} item — GET /items/:id
 * @param {string} [dbExternalListingId] — `external_listing_id` na linha (se difere de `item.id`)
 * @returns {Promise<boolean>}
 */
export async function patchMarketplaceListingScalarsFromMlItem(
  supabase,
  userId,
  marketplace,
  item,
  dbExternalListingId
) {
  if (!supabase || !item || typeof item !== "object") return false;
  const mlId = item.id != null ? String(item.id).trim() : "";
  const dbExt =
    dbExternalListingId != null && String(dbExternalListingId).trim() !== ""
      ? String(dbExternalListingId).trim()
      : "";
  const ids = [...new Set([mlId, dbExt].filter((x) => x !== ""))];
  if (ids.length === 0) return false;

  const nowIso = new Date().toISOString();
  /** @type {Record<string, unknown>} */
  const patch = {
    price: toFiniteNumber(item.price),
    base_price: toFiniteNumber(item.base_price),
    original_price: toFiniteNumber(item.original_price),
    currency_id: item.currency_id != null ? String(item.currency_id) : null,
    listing_type_id: item.listing_type_id != null ? String(item.listing_type_id) : null,
    api_last_seen_at: nowIso,
    updated_at: nowIso,
  };

  const { data, error } = await supabase
    .from("marketplace_listings")
    .update(patch)
    .eq("user_id", userId)
    .eq("marketplace", marketplace)
    .in("external_listing_id", ids)
    .select("id");

  if (error) {
    console.warn("[ml/patch-listing-scalars]", { message: error.message, ids });
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

/**
 * Normaliza resposta GET /items/:id/description para colunas + raw_json completo.
 */
function mapDescriptionRows(description) {
  if (!description || typeof description !== "object") {
    return { plain_text: null, html_text: null, raw_json: {} };
  }

  const plain = description.plain_text != null ? String(description.plain_text) : null;
  let html = description.html_text != null ? String(description.html_text) : null;
  const textField = description.text != null ? String(description.text) : null;
  if (!html && textField && /<[a-z][\s\S]*>/i.test(textField)) {
    html = textField;
  }

  return {
    plain_text: plain,
    html_text: html,
    raw_json: description,
  };
}

/**
 * Persiste item + descrição + filhos + snapshot bruto.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {object} item - resposta GET /items/:id (payload completo)
 * @param {object|null} description - resposta GET /items/:id/description ou null se indisponível
 * @param {{
 *   log?: (msg: string, extra?: object) => void;
 *   accessToken?: string;
 *   syncReason?: string;
 *   skipProductLink?: boolean;
 *   touchAutoSyncAt?: boolean;
 *   needsAttention?: boolean | null;
 *   trace?: { at: string; event: string; [k: string]: unknown }[];
 * }} [opts]
 */
export async function persistMercadoLibreListing(supabase, userId, item, description, opts = {}) {
  const log = opts.log || (() => {});
  const nowIso = new Date().toISOString();

  let workingItem =
    item && typeof item === "object"
      ? /** @type {Record<string, unknown>} */ (item)
      : /** @type {Record<string, unknown>} */ ({});

  // Multiget GET /items?ids=… costuma trazer pictures só com id (sem secure_url/url).
  // Um GET /items/:id retorna URLs completas — necessário para marketplace_listing_pictures e capa.
  if (
    opts.accessToken &&
    workingItem.id != null &&
    Array.isArray(workingItem.pictures) &&
    workingItem.pictures.length > 0 &&
    !mlPicturesArrayHasAnyUsableUrl(workingItem.pictures)
  ) {
    try {
      const full = await fetchItem(opts.accessToken, String(workingItem.id));
      if (
        full &&
        typeof full === "object" &&
        Array.isArray(full.pictures) &&
        full.pictures.length > 0 &&
        mlPicturesArrayHasAnyUsableUrl(full.pictures)
      ) {
        workingItem = { ...workingItem, pictures: full.pictures };
        log("item_pictures_hydrated_full_item", { external_id: String(workingItem.id) });
      }
    } catch (e) {
      log("item_pictures_hydrate_failed", {
        external_id: String(workingItem.id),
        message: e?.message,
      });
    }
  }

  // Ainda só com `id` em cada picture: API GET /pictures/:id devolve variations com secure_url.
  if (
    opts.accessToken &&
    workingItem.id != null &&
    Array.isArray(workingItem.pictures) &&
    workingItem.pictures.length > 0 &&
    !mlPicturesArrayHasAnyUsableUrl(workingItem.pictures)
  ) {
    try {
      const hydrated = await hydrateMlItemPicturesWithPictureApi(
        opts.accessToken,
        workingItem.pictures,
        (m, x) => log(m, x)
      );
      if (mlPicturesArrayHasAnyUsableUrl(hydrated)) {
        workingItem = { ...workingItem, pictures: hydrated };
        log("item_pictures_hydrated_picture_resources", { external_id: String(workingItem.id) });
      }
    } catch (e) {
      log("item_pictures_picture_api_hydrate_failed", {
        external_id: String(workingItem.id),
        message: e?.message,
      });
    }
  }

  // Multiget / falha intermitente em GET /items/:id pode deixar só { id } em pictures.
  // Reaproveita pictures com URL do último raw_json gravado para não sobrescrever capa/galeria.
  if (
    workingItem.id != null &&
    Array.isArray(workingItem.pictures) &&
    workingItem.pictures.length > 0 &&
    !mlPicturesArrayHasAnyUsableUrl(workingItem.pictures)
  ) {
    const { data: prevListing } = await supabase
      .from("marketplace_listings")
      .select("raw_json")
      .eq("user_id", userId)
      .eq("marketplace", ML_MARKETPLACE_SLUG)
      .eq("external_listing_id", String(workingItem.id))
      .maybeSingle();

    let prevRaw = prevListing?.raw_json;
    if (typeof prevRaw === "string") {
      try {
        prevRaw = JSON.parse(prevRaw);
      } catch {
        prevRaw = null;
      }
    }
    const prevPics =
      prevRaw && typeof prevRaw === "object" && prevRaw !== null && !Array.isArray(prevRaw)
        ? /** @type {Record<string, unknown>} */ (prevRaw).pictures
        : null;
    if (Array.isArray(prevPics) && mlPicturesArrayHasAnyUsableUrl(prevPics)) {
      workingItem = { ...workingItem, pictures: prevPics };
      log("item_pictures_preserved_from_db_raw_json", { external_id: String(workingItem.id) });
    }
  }

  const listingRow = mapMlItemToListingRow(userId, workingItem, nowIso);

  const { data: upserted, error: upErr } = await supabase
    .from("marketplace_listings")
    .upsert(listingRow, { onConflict: "marketplace,external_listing_id" })
    .select("id")
    .single();

  if (upErr) {
    log("persist_listing_upsert_failed", { error: upErr, external_id: listingRow.external_listing_id });
    throw upErr;
  }

  const listingId = upserted.id;

  // ------------------------------------------------------------------
  // Filhos: limpar e reinserir (cada sync substitui o snapshot normalizado)
  // ------------------------------------------------------------------
  const { error: delA } = await supabase
    .from("marketplace_listing_attributes")
    .delete()
    .eq("listing_id", listingId);
  if (delA) log("delete_attributes_warn", { delA });

  const picsForRows = Array.isArray(workingItem.pictures) ? workingItem.pictures : [];
  const picsHaveUsableHttp = mlPicturesArrayHasAnyUsableUrl(picsForRows);
  /** Só substitui linhas de foto quando o payload traz URLs ou lista vazia (ML removeu fotos). */
  const shouldReplacePictureTableRows = picsForRows.length === 0 || picsHaveUsableHttp;
  if (shouldReplacePictureTableRows) {
    const { error: delP } = await supabase.from("marketplace_listing_pictures").delete().eq("listing_id", listingId);
    if (delP) log("delete_pictures_warn", { delP });
  } else {
    log("pictures_table_preserved_no_http_in_payload", {
      external_id: workingItem.id != null ? String(workingItem.id) : null,
      picture_count: picsForRows.length,
    });
  }

  const { error: delV } = await supabase
    .from("marketplace_listing_variations")
    .delete()
    .eq("listing_id", listingId);
  if (delV) log("delete_variations_warn", { delV });

  await supabase.from("marketplace_listing_descriptions").delete().eq("listing_id", listingId);
  await supabase.from("marketplace_listing_shipping").delete().eq("listing_id", listingId);

  // ------------------------------------------------------------------
  // Descrição (falha na descrição não aborta — já tratada no sync antes de persist)
  // ------------------------------------------------------------------
  if (description && typeof description === "object") {
    const mapped = mapDescriptionRows(description);
    const { error: dErr } = await supabase.from("marketplace_listing_descriptions").insert({
      listing_id: listingId,
      plain_text: mapped.plain_text,
      html_text: mapped.html_text,
      raw_json: mapped.raw_json,
    });
    if (dErr) log("insert_description_warn", { dErr });
  }

  // ------------------------------------------------------------------
  // Atributos (cada atributo com raw_json = objeto original da API)
  // ------------------------------------------------------------------
  const attrs = Array.isArray(workingItem.attributes) ? workingItem.attributes : [];
  if (attrs.length > 0) {
    const rows = attrs.map((a) => ({
      listing_id: listingId,
      attribute_id: a.id != null ? String(a.id) : null,
      name: a.name ?? null,
      value_id: a.value_id != null ? String(a.value_id) : null,
      value_name: a.value_name != null ? String(a.value_name) : null,
      value_struct: a.value_struct ?? null,
      values_json: Array.isArray(a.values) ? a.values : null,
      raw_json: a,
    }));
    const { error: aErr } = await supabase.from("marketplace_listing_attributes").insert(rows);
    if (aErr) log("insert_attributes_warn", { aErr });
  }

  // ------------------------------------------------------------------
  // Fotos (ordem = índice no array pictures do ML; secure_url + url normalizados)
  // ------------------------------------------------------------------
  const pics = Array.isArray(workingItem.pictures) ? workingItem.pictures : [];
  if (pics.length > 0 && shouldReplacePictureTableRows) {
    const rows = pics.map((p, idx) => mapMlPictureToPictureRow(p, idx, listingId));
    const { error: pErr } = await supabase.from("marketplace_listing_pictures").insert(rows);
    if (pErr) log("insert_pictures_warn", { pErr });
    const hasHttp = rows.some(
      (r) => mlPictureHasUsableHttpUrl(r.secure_url) || mlPictureHasUsableHttpUrl(r.url)
    );
    if (!hasHttp) {
      log("pictures_no_valid_http_url", {
        external_id: workingItem.id,
        count: rows.length,
      });
    }
  }

  // ------------------------------------------------------------------
  // Variações (campos extras permanecem em raw_json)
  // ------------------------------------------------------------------
  const vars = Array.isArray(workingItem.variations) ? workingItem.variations : [];
  if (vars.length > 0) {
    const rows = vars.map((v, idx) => ({
      listing_id: listingId,
      external_variation_id:
        v.id != null ? String(v.id) : `var-${String(listingId).slice(0, 8)}-${idx}`,
      price: toFiniteNumber(v.price),
      available_quantity: toInt(v.available_quantity),
      sold_quantity: toInt(v.sold_quantity),
      attribute_combinations: Array.isArray(v.attribute_combinations) ? v.attribute_combinations : null,
      picture_ids: Array.isArray(v.picture_ids) ? v.picture_ids : null,
      raw_json: v,
    }));
    const { error: vErr } = await supabase.from("marketplace_listing_variations").insert(rows);
    if (vErr) log("insert_variations_warn", { vErr });
  }

  // ------------------------------------------------------------------
  // Frete (tabela dedicada + já espelhado na principal em mapMlItemToListingRow)
  // ------------------------------------------------------------------
  const sh = workingItem.shipping;
  if (sh && typeof sh === "object") {
    const { error: sErr } = await supabase.from("marketplace_listing_shipping").insert({
      listing_id: listingId,
      mode: sh.mode != null ? String(sh.mode) : null,
      free_shipping: Boolean(sh.free_shipping),
      logistic_type: sh.logistic_type != null ? String(sh.logistic_type) : null,
      local_pick_up: Boolean(sh.local_pick_up),
      raw_json: sh,
    });
    if (sErr) log("insert_shipping_warn", { sErr });
  }

  // ------------------------------------------------------------------
  // Snapshot bruto: item completo da API + descrição (auditoria / reprocessamento)
  // ------------------------------------------------------------------
  const { error: snapErr } = await supabase.from("marketplace_listing_raw_snapshots").insert({
    listing_id: listingId,
    payload: {
      item: workingItem,
      description: description ?? null,
      imported_at: nowIso,
      marketplace: ML_MARKETPLACE_SLUG,
    },
  });
  if (snapErr) log("insert_snapshot_warn", { snapErr });

  await upsertMarketplaceListingHealthFromMlItem(
    supabase,
    userId,
    { ...workingItem, _suse7_listing_uuid: listingId },
    {
    log,
    accessToken: opts.accessToken,
    nowIso,
    marketplace: ML_MARKETPLACE_SLUG,
    financialSnapshot: {
      reason: SNAPSHOT_REASON.IMPORT_SYNC,
      source: SNAPSHOT_SOURCE.ML_HEALTH_SYNC,
    },
    }
  );

  const sellerSku = extractSellerSku(workingItem);
  const hasSellerSku = Boolean(sellerSku);
  const { data: healthRow } = await supabase
    .from("marketplace_listing_health")
    .select(
      "visits, sale_fee_percent, sale_fee_amount, shipping_cost, net_receivable, promotion_price, listing_quality_score, listing_quality_status, shipping_logistic_type"
    )
    .eq("user_id", userId)
    .eq("marketplace", ML_MARKETPLACE_SLUG)
    .eq("external_listing_id", String(listingRow.external_listing_id))
    .maybeSingle();

  const snap = buildListingSyncCompareSnapshot(workingItem, healthRow ?? {}, sellerSku);
  /** @type {Record<string, unknown>} */
  const listingPatch = {
    sync_compare_snapshot: snap,
    last_sync_reason: opts.syncReason != null ? String(opts.syncReason) : "persist",
    updated_at: nowIso,
  };
  if (opts.touchAutoSyncAt) {
    listingPatch.last_auto_sync_at = nowIso;
  }
  if (!hasSellerSku) {
    listingPatch.product_id = null;
    listingPatch.needs_attention = true;
    listingPatch.financial_analysis_blocked = true;
    listingPatch.attention_reason = ATTENTION_REASON_SKU_PENDING_ML;
  } else {
    listingPatch.attention_reason = null;
    listingPatch.needs_attention =
      opts.needsAttention != null ? Boolean(opts.needsAttention) : false;
  }

  const { error: patchErr } = await supabase
    .from("marketplace_listings")
    .update(listingPatch)
    .eq("id", listingId);
  if (patchErr) {
    log("listing_compare_snapshot_warn", { patchErr, listingId });
    const msg = String(patchErr.message || patchErr || "");
    const missingAttention = /attention_reason|column .* does not exist/i.test(msg);
    const errObj = {
      message: patchErr.message,
      code: patchErr.code,
      details: patchErr.details,
      hint: patchErr.hint,
    };
    console.error("[ml/persist-listing] listing_patch_failed", {
      listingId,
      external_listing_id: listingRow.external_listing_id,
      message: patchErr.message,
      code: patchErr.code,
      hint: missingAttention
        ? "Aplique a migration suse7-frontend/supabase/migrations/20260329180000_marketplace_listings_attention_reason.sql (coluna attention_reason)."
        : "Verifique schema marketplace_listings vs. código de persistência.",
    });
    const tr = opts.trace;
    if (Array.isArray(tr)) {
      tr.push({
        at: new Date().toISOString(),
        event: "listing_patch_failed",
        listingId,
        external_listing_id: listingRow.external_listing_id,
        error: errObj,
        migration_hint: missingAttention
          ? "20260329180000_marketplace_listings_attention_reason.sql"
          : null,
      });
    }
  }

  if (!opts.skipProductLink) {
    await ensureListingLinkedToProduct(supabase, userId, listingId, workingItem, description, { log });
  }

  return {
    listingId,
    external_listing_id: listingRow.external_listing_id,
    item: workingItem,
    description: description ?? null,
  };
}
