// ============================================================
// S7 — Concorrência: anúncios monitorados (repository)
// Cada linha da Página Concorrência = 1 registro ativo aqui.
// ============================================================

import {
  DEFAULT_MARKETPLACE,
  extractOwnListingSummary,
  findLatestSnapshotMetaForCompetitors,
} from "./competitionRepository.js";
import { toCompetitorResponse } from "./competitionNormalizer.js";

const MONITORED_COLUMNS =
  "id, user_id, marketplace, marketplace_account_id, seller_company_id, " +
  "marketplace_listing_id, external_listing_id, product_id, sku, product_name, listing_title, " +
  "is_monitored, created_at, updated_at";

const COMPETITOR_COLUMNS =
  "id, user_id, marketplace, marketplace_account_id, seller_company_id, product_id, monitored_listing_id, sku, " +
  "competitor_listing_id, competitor_title, competitor_seller_id, competitor_store_name, " +
  "competitor_permalink, competitor_thumbnail, source_strategy, is_active, competitor_listing_status, " +
  "last_seen_price, last_seen_currency, last_captured_at, created_at, updated_at";

const LISTING_SEARCH_SELECT =
  "id, title, marketplace, marketplace_account_id, seller_company_id, external_listing_id, " +
  "product_id, seller_sku, status, raw_json, products(sku, product_name)";

function normalizeSearchTerm(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function pickListingThumbnail(rawJson) {
  const raw = rawJson && typeof rawJson === "object" ? rawJson : null;
  if (!raw) return null;
  const pics = Array.isArray(raw.pictures) ? raw.pictures : [];
  for (const pic of pics) {
    const url = pic?.secure_url ?? pic?.url ?? null;
    if (url != null && String(url).trim() !== "") return String(url).trim();
  }
  const thumb = raw.thumbnail ?? raw.secure_thumbnail ?? null;
  return thumb != null && String(thumb).trim() !== "" ? String(thumb).trim() : null;
}

function resolveAccountLabelFromRawJson(rawJson) {
  const raw = rawJson && typeof rawJson === "object" ? rawJson : null;
  if (!raw) return null;
  const seller = raw.seller && typeof raw.seller === "object" ? raw.seller : null;
  if (seller?.nickname != null && String(seller.nickname).trim() !== "") {
    return String(seller.nickname).trim();
  }
  for (const key of ["seller_nickname", "nickname", "ml_nickname"]) {
    const valor = raw[key];
    if (valor != null && String(valor).trim() !== "") return String(valor).trim();
  }
  return null;
}

function resolveAccountLabel(accountRow, listingRow) {
  if (accountRow && typeof accountRow === "object") {
    if (accountRow.ml_nickname != null && String(accountRow.ml_nickname).trim() !== "") {
      return String(accountRow.ml_nickname).trim();
    }
    if (accountRow.account_alias != null && String(accountRow.account_alias).trim() !== "") {
      return String(accountRow.account_alias).trim();
    }
    if (accountRow.external_seller_id != null && String(accountRow.external_seller_id).trim() !== "") {
      return String(accountRow.external_seller_id).trim();
    }
  }
  const joined = listingRow?.marketplace_accounts;
  if (joined && typeof joined === "object") {
    if (joined.ml_nickname != null && String(joined.ml_nickname).trim() !== "") {
      return String(joined.ml_nickname).trim();
    }
    if (joined.account_alias != null && String(joined.account_alias).trim() !== "") {
      return String(joined.account_alias).trim();
    }
    if (joined.external_seller_id != null && String(joined.external_seller_id).trim() !== "") {
      return String(joined.external_seller_id).trim();
    }
  }
  return resolveAccountLabelFromRawJson(listingRow?.raw_json);
}

function enrichOwnListingWithAccount(ownListing, accountLabel, marketplaceAccountId) {
  const base = ownListing && typeof ownListing === "object" ? { ...ownListing } : {};
  if (accountLabel) {
    base.account_alias = accountLabel;
    base.account_name = accountLabel;
    base.ml_account_alias = accountLabel;
  }
  if (marketplaceAccountId) base.marketplace_account_id = marketplaceAccountId;
  return base;
}

function pickTrimUrl(value) {
  return value != null && String(value).trim() !== "" ? String(value).trim() : null;
}

/** Mesma normalização de thumbs/logos da listagem /vendas. */
function normalizeUiImageUrl(url) {
  const u = pickTrimUrl(url);
  if (!u) return null;
  if (u.startsWith("//")) return `https:${u}`;
  if (/^http:\/\//i.test(u)) {
    const lower = u.toLowerCase();
    if (
      lower.includes("mercadolivre") ||
      lower.includes("mercadolibre") ||
      lower.includes("mlstatic") ||
      lower.includes("mlcdn")
    ) {
      return `https://${u.slice(7)}`;
    }
  }
  return u;
}

/** Mesma prioridade de logo da coluna Conta em /vendas. */
function resolveAccountLogoUrl(accountRow, sellerCompanyRow, listingRow) {
  const joined =
    listingRow?.marketplace_accounts && typeof listingRow.marketplace_accounts === "object"
      ? listingRow.marketplace_accounts
      : null;
  const raw =
    pickTrimUrl(sellerCompanyRow?.logo_url) ??
    pickTrimUrl(sellerCompanyRow?.avatar_url) ??
    pickTrimUrl(accountRow?.logo_url) ??
    pickTrimUrl(accountRow?.avatar_url) ??
    pickTrimUrl(accountRow?.company_logo_url) ??
    pickTrimUrl(accountRow?.ml_picture_url) ??
    pickTrimUrl(joined?.logo_url) ??
    pickTrimUrl(joined?.avatar_url) ??
    null;
  return normalizeUiImageUrl(raw);
}

async function fetchMarketplaceAccountsByUser(supabase, userId) {
  const map = new Map();
  const selectVariants = [
    "id, account_alias, ml_nickname, external_seller_id, seller_company_id, logo_url, avatar_url, ml_picture_url, company_logo_url",
    "id, account_alias, ml_nickname, external_seller_id, seller_company_id, logo_url, avatar_url",
    "id, account_alias, ml_nickname, external_seller_id, seller_company_id, logo_url",
    "id, account_alias, ml_nickname, external_seller_id, seller_company_id",
    "id, account_alias, ml_nickname, external_seller_id",
  ];
  for (const sel of selectVariants) {
    const { data, error } = await supabase.from("marketplace_accounts").select(sel).eq("user_id", userId);
    if (!error) {
      for (const row of data || []) {
        if (row?.id) map.set(String(row.id), row);
      }
      return map;
    }
    const errMsg = String(error?.message ?? "").toLowerCase();
    if (String(error?.code ?? "") !== "42703" && !errMsg.includes("column")) break;
  }
  return map;
}

async function fetchSellerCompaniesById(supabase, userId, companyIds) {
  const map = new Map();
  const uniq = [...new Set((companyIds || []).filter(Boolean).map(String))];
  if (!uniq.length) return map;

  const selectVariants = [
    "id, logo_url, avatar_url",
    "id, logo_url",
    "id",
  ];
  for (const sel of selectVariants) {
    const { data, error } = await supabase
      .from("seller_companies")
      .select(sel)
      .eq("user_id", userId)
      .in("id", uniq);
    if (!error) {
      for (const row of data || []) {
        if (row?.id) map.set(String(row.id), row);
      }
      return map;
    }
    const errMsg = String(error?.message ?? "").toLowerCase();
    if (String(error?.code ?? "") !== "42703" && !errMsg.includes("column")) break;
  }
  return map;
}

/** Anúncio monitorado do usuário, ou null. */
export async function findMonitoredListingOwned(supabase, userId, monitoredListingId) {
  const { data, error } = await supabase
    .from("competition_monitored_listings")
    .select(MONITORED_COLUMNS)
    .eq("id", monitoredListingId)
    .eq("user_id", userId)
    .eq("is_monitored", true)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/** Marketplace listing do usuário (contexto do anúncio monitorado). */
export async function findOwnedMarketplaceListing(supabase, userId, marketplaceListingId) {
  const selectWithAccount = `${LISTING_SEARCH_SELECT}, marketplace_accounts(account_alias, ml_nickname, external_seller_id)`;
  let { data, error } = await supabase
    .from("marketplace_listings")
    .select(selectWithAccount)
    .eq("id", marketplaceListingId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    const errMsg = String(error?.message ?? "").toLowerCase();
    if (errMsg.includes("marketplace_accounts") || String(error?.code ?? "") === "PGRST200") {
      ({ data, error } = await supabase
        .from("marketplace_listings")
        .select(LISTING_SEARCH_SELECT)
        .eq("id", marketplaceListingId)
        .eq("user_id", userId)
        .maybeSingle());
    }
  }
  if (error) throw error;
  return data || null;
}

/** Listing vinculado a um anúncio monitorado (substitui findPrimaryListingForProduct no novo fluxo). */
export async function findListingForMonitoredListing(supabase, userId, monitoredListing) {
  if (!monitoredListing?.marketplace_listing_id) return null;
  const { data, error } = await supabase
    .from("marketplace_listings")
    .select(
      "id, external_listing_id, marketplace, marketplace_account_id, seller_company_id, category_id, " +
        "catalog_listing, catalog_product_id, title, raw_json"
    )
    .eq("id", monitoredListing.marketplace_listing_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/** IDs de anúncios monitorados ativos (filtro da rotina diária). */
export async function listActiveMonitoredListingIds(supabase) {
  const { data, error } = await supabase
    .from("competition_monitored_listings")
    .select("id")
    .eq("is_monitored", true);
  if (error) throw error;
  return (data || []).map((r) => r.id).filter(Boolean);
}

/** Concorrentes ativos de um anúncio monitorado. */
export async function listActiveCompetitorsByMonitoredListing(supabase, userId, monitoredListingId) {
  const { data, error } = await supabase
    .from("competition_competitors")
    .select(COMPETITOR_COLUMNS)
    .eq("user_id", userId)
    .eq("monitored_listing_id", monitoredListingId)
    .eq("is_active", true)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

/** Contagem de concorrentes ativos por anúncio monitorado. */
export async function countActiveCompetitorsByMonitoredListing(supabase, userId, monitoredListingId) {
  const { count, error } = await supabase
    .from("competition_competitors")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("monitored_listing_id", monitoredListingId)
    .eq("is_active", true);
  if (error) throw error;
  return typeof count === "number" ? count : 0;
}

/**
 * Lista principal: anúncios monitorados ativos com concorrentes compactos.
 */
export async function listMonitoredListingsWithCompetitors(supabase, userId) {
  const { data: monitoredRows, error: mErr } = await supabase
    .from("competition_monitored_listings")
    .select(MONITORED_COLUMNS)
    .eq("user_id", userId)
    .eq("is_monitored", true)
    .order("created_at", { ascending: false });
  if (mErr) throw mErr;

  const monitored = monitoredRows || [];
  const monitoredIds = monitored.map((r) => r.id).filter(Boolean);
  if (!monitoredIds.length) return [];

  const listingIds = [...new Set(monitored.map((r) => r.marketplace_listing_id).filter(Boolean))];

  const [compsRes, listingsRes] = await Promise.all([
    supabase
      .from("competition_competitors")
      .select(COMPETITOR_COLUMNS)
      .eq("user_id", userId)
      .eq("is_active", true)
      .in("monitored_listing_id", monitoredIds)
      .order("created_at", { ascending: true }),
    supabase
      .from("marketplace_listings")
      .select(
        "id, external_listing_id, marketplace_account_id, seller_company_id, product_id, seller_sku, title, raw_json, products(sku, product_name), marketplace_accounts(account_alias, ml_nickname, external_seller_id, logo_url, avatar_url)"
      )
      .eq("user_id", userId)
      .in("id", listingIds),
  ]);

  if (compsRes.error) throw compsRes.error;

  let listings = listingsRes.data || [];
  if (listingsRes.error) {
    const fallback = await supabase
      .from("marketplace_listings")
        .select("id, external_listing_id, marketplace_account_id, seller_company_id, product_id, seller_sku, title, raw_json, products(sku, product_name)")
      .eq("user_id", userId)
      .in("id", listingIds);
    if (fallback.error) throw fallback.error;
    listings = fallback.data || [];
  }

  const accountsById = await fetchMarketplaceAccountsByUser(supabase, userId);

  const sellerCompanyIds = [
    ...monitored.map((r) => r.seller_company_id),
    ...[...accountsById.values()].map((r) => r.seller_company_id),
  ].filter(Boolean);
  const companiesById = await fetchSellerCompaniesById(supabase, userId, sellerCompanyIds);

  const listingsById = new Map();
  for (const row of listings) {
    if (row?.id) listingsById.set(String(row.id), row);
  }

  const comps = compsRes.data || [];
  let snapshotMeta = new Map();
  try {
    snapshotMeta = await findLatestSnapshotMetaForCompetitors(
      supabase,
      userId,
      comps.map((r) => r.id).filter(Boolean)
    );
  } catch (metaErr) {
    console.error("[competition] snapshot meta indisponível na lista monitorada", {
      message: metaErr?.message,
      code: metaErr?.code,
    });
  }

  const compsByMonitored = new Map();
  for (const row of comps) {
    const key = String(row.monitored_listing_id);
    if (!compsByMonitored.has(key)) compsByMonitored.set(key, []);
    const meta = snapshotMeta.get(row.id) ?? {};
    compsByMonitored.get(key).push(
      toCompetitorResponse(row, {
        sales_hint: meta.sales_hint ?? null,
        shipping: meta.shipping ?? null,
        listing_type: meta.listing_type ?? null,
        reputation: meta.reputation ?? null,
        snapshot_thumbnail: meta.competitor_thumbnail ?? null,
        snapshot_store_name: meta.competitor_store_name ?? null,
        snapshot_price: meta.competitor_price ?? null,
        snapshot_title: meta.competitor_title ?? null,
        listing_status: meta.listing_status ?? null,
        competitor_pictures: meta.competitor_pictures ?? null,
      })
    );
  }

  return monitored.map((ml) => {
    const listingRow = listingsById.get(String(ml.marketplace_listing_id)) ?? null;
    const effectiveAccountId =
      ml.marketplace_account_id ?? listingRow?.marketplace_account_id ?? null;
    const accountRow =
      effectiveAccountId != null
        ? accountsById.get(String(effectiveAccountId)) ?? null
        : null;
    const sellerCompanyId =
      ml.seller_company_id ?? accountRow?.seller_company_id ?? listingRow?.seller_company_id ?? null;
    const sellerCompanyRow =
      sellerCompanyId != null ? companiesById.get(String(sellerCompanyId)) ?? null : null;
    const accountLabel = resolveAccountLabel(accountRow, listingRow);
    const ownListingBase = extractOwnListingSummary(listingRow);
    const ownListing = enrichOwnListingWithAccount(
      ownListingBase,
      accountLabel,
      effectiveAccountId
    );
    const competitors = compsByMonitored.get(String(ml.id)) || [];
    const displayName =
      String(ml.product_name || "").trim() ||
      String(listingRow?.products?.product_name || "").trim() ||
      String(ml.listing_title || "").trim() ||
      String(listingRow?.title || "").trim() ||
      "Sem nome";

    const listingSku =
      listingRow?.products?.sku != null && String(listingRow.products.sku).trim() !== ""
        ? String(listingRow.products.sku).trim()
        : listingRow?.seller_sku != null && String(listingRow.seller_sku).trim() !== ""
          ? String(listingRow.seller_sku).trim()
          : null;

    return {
      monitored_listing_id: ml.id,
      marketplace_listing_id: ml.marketplace_listing_id,
      product_id: ml.product_id ?? listingRow?.product_id ?? null,
      sku: ml.sku ?? listingSku ?? null,
      product_name: displayName,
      listing_title: ml.listing_title ?? listingRow?.title ?? null,
      external_listing_id: ml.external_listing_id,
      marketplace: ml.marketplace ?? DEFAULT_MARKETPLACE,
      marketplace_account_id: effectiveAccountId,
      account_alias: accountLabel,
      account_label: accountLabel,
      account_logo_url: resolveAccountLogoUrl(accountRow, sellerCompanyRow, listingRow),
      listing_thumbnail: pickListingThumbnail(listingRow?.raw_json),
      image_url: null,
      competitors_count: competitors.length,
      has_competitors: competitors.length > 0,
      competitors,
      own_listing: ownListing,
    };
  });
}

/**
 * Busca anúncios do seller para inclusão no monitoramento.
 * Filtra por título, SKU ou ID do anúncio (MLB…).
 */
export async function searchListingsForMonitoring(supabase, userId, { query = "", limit = 40 } = {}) {
  const q = normalizeSearchTerm(query);
  const safeLimit = Math.min(Math.max(Math.trunc(Number(limit) || 40), 1), 100);

  const { data: alreadyMonitored, error: monErr } = await supabase
    .from("competition_monitored_listings")
    .select("marketplace_listing_id")
    .eq("user_id", userId)
    .eq("is_monitored", true);
  if (monErr) throw monErr;

  const excludedIds = new Set((alreadyMonitored || []).map((r) => String(r.marketplace_listing_id)));

  const selectWithAccount = `${LISTING_SEARCH_SELECT}, marketplace_accounts(account_alias, ml_nickname)`;
  let { data, error } = await supabase
    .from("marketplace_listings")
    .select(selectWithAccount)
    .eq("user_id", userId)
    .order("api_last_seen_at", { ascending: false })
    .limit(500);

  if (error) {
    const errMsg = String(error?.message ?? "").toLowerCase();
    if (errMsg.includes("marketplace_accounts") || String(error?.code ?? "") === "PGRST200") {
      ({ data, error } = await supabase
        .from("marketplace_listings")
        .select(LISTING_SEARCH_SELECT)
        .eq("user_id", userId)
        .order("api_last_seen_at", { ascending: false })
        .limit(500));
    }
  }
  if (error) throw error;

  const digitsOnly = q.replace(/\D/g, "");
  const rows = (data || []).filter((row) => {
    if (!row?.id || excludedIds.has(String(row.id))) return false;
    if (!q) return true;

    const title = normalizeSearchTerm(row.title);
    const externalId = normalizeSearchTerm(row.external_listing_id);
    const sellerSku = normalizeSearchTerm(row.seller_sku);
    const productsJoin = row.products;
    const productSku =
      productsJoin && typeof productsJoin === "object" && !Array.isArray(productsJoin)
        ? normalizeSearchTerm(productsJoin.sku)
        : "";
    const productName =
      productsJoin && typeof productsJoin === "object" && !Array.isArray(productsJoin)
        ? normalizeSearchTerm(productsJoin.product_name)
        : "";

    if (title.includes(q)) return true;
    if (externalId.includes(q)) return true;
    if (sellerSku.includes(q)) return true;
    if (productSku.includes(q)) return true;
    if (productName.includes(q)) return true;
    if (digitsOnly.length >= 4) {
      const extDigits = externalId.replace(/\D/g, "");
      if (extDigits.includes(digitsOnly)) return true;
    }
    return false;
  });

  return rows.slice(0, safeLimit).map((row) => {
    const productsJoin = row.products;
    const sku =
      (productsJoin && typeof productsJoin === "object" && !Array.isArray(productsJoin)
        ? productsJoin.sku
        : null) ??
      row.seller_sku ??
      null;
    const productName =
      productsJoin && typeof productsJoin === "object" && !Array.isArray(productsJoin)
        ? productsJoin.product_name
        : null;
    const accountLabel = resolveAccountLabel(null, row);
    const ownSummary = extractOwnListingSummary(row);
    const soldRaw = Number(row.raw_json?.sold_quantity);
    const salesCount =
      Number.isFinite(soldRaw) && soldRaw >= 0
        ? Math.trunc(soldRaw)
        : ownSummary.sales != null
          ? Math.trunc(Number(ownSummary.sales))
          : 0;

    return {
      marketplace_listing_id: row.id,
      external_listing_id: row.external_listing_id ?? null,
      title: row.title ?? null,
      sku: sku != null ? String(sku) : null,
      product_name: productName != null ? String(productName) : null,
      marketplace: row.marketplace ?? DEFAULT_MARKETPLACE,
      marketplace_account_id: row.marketplace_account_id ?? null,
      account_label: accountLabel,
      listing_thumbnail: pickListingThumbnail(row.raw_json),
      price: ownSummary.price,
      currency: ownSummary.currency ?? "BRL",
      sales_count: salesCount,
      status: row.status ?? null,
      product_id: row.product_id ?? null,
    };
  });
}

/** Inclui anúncios no monitoramento (bulk). */
export async function bulkInsertMonitoredListings(supabase, userId, marketplaceListingIds) {
  const ids = [...new Set((Array.isArray(marketplaceListingIds) ? marketplaceListingIds : []).map(String).filter(Boolean))];
  if (!ids.length) return { inserted: [], skipped: [], errors: [] };

  const inserted = [];
  const skipped = [];
  const errors = [];

  for (const listingId of ids) {
    try {
      const listing = await findOwnedMarketplaceListing(supabase, userId, listingId);
      if (!listing) {
        errors.push({ marketplace_listing_id: listingId, error: "Anúncio não encontrado" });
        continue;
      }

      const externalId = String(listing.external_listing_id || "").trim();
      if (!externalId) {
        errors.push({ marketplace_listing_id: listingId, error: "Anúncio sem ID externo" });
        continue;
      }

      const marketplace = listing.marketplace != null ? String(listing.marketplace).trim() : DEFAULT_MARKETPLACE;
      const productsJoin = listing.products;
      const productSku =
        productsJoin && typeof productsJoin === "object" && !Array.isArray(productsJoin)
          ? productsJoin.sku
          : null;
      const productName =
        productsJoin && typeof productsJoin === "object" && !Array.isArray(productsJoin)
          ? productsJoin.product_name
          : null;

      const { data: existing, error: exErr } = await supabase
        .from("competition_monitored_listings")
        .select("id, is_monitored")
        .eq("user_id", userId)
        .eq("marketplace", marketplace)
        .eq("external_listing_id", externalId)
        .maybeSingle();
      if (exErr) throw exErr;

      if (existing?.is_monitored === true) {
        skipped.push({ marketplace_listing_id: listingId, monitored_listing_id: existing.id });
        continue;
      }

      if (existing && existing.is_monitored !== true) {
        const { data: reactivated, error: reErr } = await supabase
          .from("competition_monitored_listings")
          .update({ is_monitored: true })
          .eq("id", existing.id)
          .eq("user_id", userId)
          .select(MONITORED_COLUMNS)
          .single();
        if (reErr) throw reErr;
        inserted.push(reactivated);
        continue;
      }

      const { data: created, error: insErr } = await supabase
        .from("competition_monitored_listings")
        .insert({
          user_id: userId,
          marketplace,
          marketplace_account_id: listing.marketplace_account_id ?? null,
          seller_company_id: listing.seller_company_id ?? null,
          marketplace_listing_id: listing.id,
          external_listing_id: externalId,
          product_id: listing.product_id ?? null,
          sku: productSku != null ? String(productSku) : listing.seller_sku ?? null,
          product_name: productName != null ? String(productName) : null,
          listing_title: listing.title ?? null,
          is_monitored: true,
        })
        .select(MONITORED_COLUMNS)
        .single();
      if (insErr) throw insErr;
      inserted.push(created);
    } catch (e) {
      errors.push({
        marketplace_listing_id: listingId,
        error: e?.message ?? String(e),
      });
    }
  }

  return { inserted, skipped, errors };
}

/** Remove anúncio do monitoramento (soft-delete). */
export async function deactivateMonitoredListing(supabase, userId, monitoredListingId) {
  const { data, error } = await supabase
    .from("competition_monitored_listings")
    .update({ is_monitored: false })
    .eq("id", monitoredListingId)
    .eq("user_id", userId)
    .select(MONITORED_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}
