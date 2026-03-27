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
 * SKU exibido / derivado: mantém lógica legado (custom field ou atributo SELLER_SKU).
 */
function extractSellerSku(item) {
  if (item?.seller_custom_field != null && String(item.seller_custom_field).trim() !== "") {
    return String(item.seller_custom_field);
  }
  const attrs = item?.attributes;
  if (!Array.isArray(attrs)) return null;
  const sku = attrs.find((a) => a?.id === "SELLER_SKU" || a?.name === "SKU");
  if (sku?.value_name) return String(sku.value_name);
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
 * @param {{ log?: (msg: string, extra?: object) => void }} [opts]
 */
export async function persistMercadoLibreListing(supabase, userId, item, description, opts = {}) {
  const log = opts.log || (() => {});
  const nowIso = new Date().toISOString();
  const listingRow = mapMlItemToListingRow(userId, item, nowIso);

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

  const { error: delP } = await supabase.from("marketplace_listing_pictures").delete().eq("listing_id", listingId);
  if (delP) log("delete_pictures_warn", { delP });

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
  const attrs = Array.isArray(item.attributes) ? item.attributes : [];
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
  // Fotos (ordem = índice no array pictures do ML)
  // ------------------------------------------------------------------
  const pics = Array.isArray(item.pictures) ? item.pictures : [];
  if (pics.length > 0) {
    const rows = pics.map((p, idx) => ({
      listing_id: listingId,
      external_picture_id: p.id != null ? String(p.id) : null,
      url: p.url ?? null,
      secure_url: p.secure_url ?? null,
      position: idx,
      raw_json: p,
    }));
    const { error: pErr } = await supabase.from("marketplace_listing_pictures").insert(rows);
    if (pErr) log("insert_pictures_warn", { pErr });
  }

  // ------------------------------------------------------------------
  // Variações (campos extras permanecem em raw_json)
  // ------------------------------------------------------------------
  const vars = Array.isArray(item.variations) ? item.variations : [];
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
  const sh = item.shipping;
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
      item,
      description: description ?? null,
      imported_at: nowIso,
      marketplace: ML_MARKETPLACE_SLUG,
    },
  });
  if (snapErr) log("insert_snapshot_warn", { snapErr });

  return { listingId, external_listing_id: listingRow.external_listing_id };
}
