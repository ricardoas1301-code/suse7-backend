import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { gatePremiumHandler } from "../../billing/middleware/requirePlanAccess.js";
import { normalizeSkuForDbLookup } from "../../domain/productCatalogCompleteness.js";
import { resolveExecutiveRankingImageUrl } from "../../domain/sales/executiveRankingImageUrl.js";
import { buildVendasListRow, buildVendasSalesItemQOrFilter, chunkIds, enrichVendasListRowsOperationalStatus, fetchVendasSearchOrderIds, normalizeSearchQuery, splitSearchTokens, thumbFromListingRecord, toNum } from "./_vendasSalesRows.js";

function toPositiveInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/**
 * @param {number} page
 * @param {number} pageSize
 * @param {number} total
 */
function buildPaginationMeta(page, pageSize, total) {
  const t = Number.isFinite(total) && total >= 0 ? Math.floor(Number(total)) : 0;
  const total_pages = t === 0 ? 1 : Math.max(1, Math.ceil(t / pageSize));
  const has_previous = page > 1;
  const has_next = page < total_pages;
  return {
    page,
    page_size: pageSize,
    total: t,
    total_pages,
    has_next,
    has_previous,
    truncated_scan: false,
  };
}

function emptySalesPayload(page, pageSize) {
  const pagination = buildPaginationMeta(page, pageSize, 0);
  return {
    ok: true,
    items: [],
    rows: [],
    page,
    page_size: pageSize,
    total: pagination.total,
    total_pages: pagination.total_pages,
    has_next: pagination.has_next,
    has_previous: pagination.has_previous,
    pagination,
  };
}

function isShapeError(error) {
  return (
    String(error?.code ?? "") === "42703" ||
    String(error?.message ?? "").toLowerCase().includes("column") ||
    String(error?.message ?? "").toLowerCase().includes("schema cache")
  );
}

/** @param {unknown} v */
function parseMillis(v) {
  if (v == null || String(v).trim() === "") return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/**
 * Ordenação canônica da listagem /vendas (linhas = sales_order_items).
 * 1) date_created_marketplace DESC (null por último)
 * 2) sales_orders.created_at DESC
 * 3) sales_order_items.created_at DESC
 * 4) id da linha (estabilidade)
 * @param {Record<string, unknown>[]} items
 * @param {Map<string, Record<string, unknown>>} ordersById
 */
function sortSalesOrderItemsForVendasList(items, ordersById) {
  if (!Array.isArray(items) || items.length <= 1) return;

  items.sort((a, b) => {
    const oa = ordersById.get(String(a?.sales_order_id ?? ""));
    const ob = ordersById.get(String(b?.sales_order_id ?? ""));
    const ma = parseMillis(oa?.date_created_marketplace);
    const mb = parseMillis(ob?.date_created_marketplace);
    if (ma !== mb) {
      if (ma == null) return 1;
      if (mb == null) return -1;
      if (mb !== ma) return mb - ma;
    }
    const oca = parseMillis(oa?.created_at);
    const ocb = parseMillis(ob?.created_at);
    if (oca !== ocb) {
      if (oca == null) return 1;
      if (ocb == null) return -1;
      if (ocb !== oca) return ocb - oca;
    }
    const ia = parseMillis(a?.created_at);
    const ib = parseMillis(b?.created_at);
    if (ia !== ib) {
      if (ia == null) return 1;
      if (ib == null) return -1;
      return ib - ia;
    }
    const ida = String(a?.id ?? "");
    const idb = String(b?.id ?? "");
    return idb.localeCompare(ida);
  });
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string[]} orderIds
 */
async function fetchOrdersById(supabase, userId, orderIds) {
  /** @type {Map<string, Record<string, unknown>>} */
  const map = new Map();
  const chunks = chunkIds(orderIds, 150);
  for (const chunk of chunks) {
    if (chunk.length === 0) continue;
    const { data, error } = await supabase
      .from("sales_orders")
      .select(
        "id,user_id,marketplace,marketplace_account_id,seller_company_id,external_order_id,order_status,date_created_marketplace,date_closed_marketplace,paid_at,raw_json,created_at",
      )
      .eq("user_id", userId)
      .in("id", chunk);
    if (error) throw error;
    for (const row of data || []) {
      if (row?.id) map.set(String(row.id), row);
    }
  }
  return map;
}

/**
 * @param {Map<string, Record<string, unknown>>} listingsMap
 * @param {string} mkt
 * @param {string} ext
 * @param {string} accountIdGuess
 */
function pickListingForVendasLine(listingsMap, mkt, ext, accountIdGuess) {
  if (!mkt || !ext || !listingsMap?.get) return null;
  const a = accountIdGuess != null && String(accountIdGuess).trim() !== "" ? String(accountIdGuess).trim() : "";
  if (a) {
    const scoped = listingsMap.get(`${mkt}::${a}::${ext}`);
    if (scoped) return scoped;
  }
  return listingsMap.get(`${mkt}::__none__::${ext}`) ?? listingsMap.get(`${mkt}::__legacy__::${ext}`) ?? null;
}

/**
 * Anúncios por (marketplace + conta) para não misturar listing de outra marketplace_account.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ marketplace: string; accountId: string | null; externalListingIds: string[] }[]} buckets
 */
async function fetchListingsForVendasBuckets(supabase, userId, buckets) {
  /** @type {Map<string, Record<string, unknown>>} */
  const map = new Map();
  for (const b of buckets) {
    const ids = (b.externalListingIds || []).filter(Boolean);
    const chunks = chunkIds(ids, 150);
    for (const chunk of chunks) {
      if (chunk.length === 0 || !b.marketplace) continue;

      const selectWithAcc =
        "id,marketplace,marketplace_account_id,external_listing_id,title,thumbnail,pictures,seller_sku,product_id,raw_json";
      const selectLegacy =
        "id,marketplace,external_listing_id,title,thumbnail,pictures,seller_sku,product_id,raw_json";

      /** @type {Record<string, unknown>[] | null} */
      let rows = null;
      for (const sel of [selectWithAcc, selectLegacy]) {
        const withAcc = sel.includes("marketplace_account_id");
        let q = supabase
          .from("marketplace_listings")
          .select(sel)
          .eq("user_id", userId)
          .eq("marketplace", b.marketplace)
          .in("external_listing_id", chunk);
        if (withAcc && b.accountId) {
          q = q.eq("marketplace_account_id", b.accountId);
        }
        const { data, error } = await q;
        if (error) {
          if (isShapeError(error)) continue;
          throw error;
        }
        rows = data || [];
        break;
      }
      for (const row of rows || []) {
        const ext = row?.external_listing_id != null ? String(row.external_listing_id) : "";
        if (!ext) continue;
        const withAccCol = row && "marketplace_account_id" in row;
        const rowAcc =
          withAccCol && row?.marketplace_account_id != null && String(row.marketplace_account_id).trim() !== ""
            ? String(row.marketplace_account_id).trim()
            : "__none__";
        map.set(`${b.marketplace}::${rowAcc}::${ext}`, row);
        map.set(`${b.marketplace}::__legacy__::${ext}`, row);
      }
    }
  }
  return map;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string[]} productIds
 */
async function fetchProductsById(supabase, userId, productIds) {
  /** @type {Map<string, Record<string, unknown>>} */
  const map = new Map();
  const chunks = chunkIds(productIds, 150);
  const selectVariants = [
    "id,product_name,sku,normalized_sku,cost_price,operational_cost,packaging_cost,product_images,product_image_links,format,product_variants",
    "id,product_name,sku,normalized_sku,cost_price,operational_cost,packaging_cost,product_images",
  ];
  for (const chunk of chunks) {
    if (chunk.length === 0) continue;
    /** @type {Record<string, unknown>[] | null} */
    let rows = null;
    /** @type {unknown} */
    let lastError = null;
    for (const sel of selectVariants) {
      const { data, error } = await supabase.from("products").select(sel).eq("user_id", userId).in("id", chunk);
      if (error) {
        lastError = error;
        if (isShapeError(error)) continue;
        throw error;
      }
      rows = data || [];
      break;
    }
    if (!rows && lastError) throw /** @type {Error} */ (lastError);
    for (const row of rows || []) {
      if (row?.id) map.set(String(row.id), row);
    }
  }
  return map;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string[]} norms
 */
async function fetchProductsByNormalizedSku(supabase, userId, norms) {
  /** @type {Map<string, Record<string, unknown>>} */
  const map = new Map();
  const uniq = [...new Set(norms.map((n) => normalizeSkuForDbLookup(String(n || ""))).filter(Boolean))];
  const chunks = chunkIds(uniq, 150);
  const selectVariants = [
    "id,product_name,sku,normalized_sku,cost_price,operational_cost,packaging_cost,product_images,product_image_links,format,product_variants",
    "id,product_name,sku,normalized_sku,cost_price,operational_cost,packaging_cost,product_images",
  ];
  for (const chunk of chunks) {
    if (chunk.length === 0) continue;
    /** @type {Record<string, unknown>[] | null} */
    let rows = null;
    /** @type {unknown} */
    let lastError = null;
    for (const sel of selectVariants) {
      const { data, error } = await supabase.from("products").select(sel).eq("user_id", userId).in("normalized_sku", chunk);
      if (error) {
        lastError = error;
        if (isShapeError(error)) continue;
        throw error;
      }
      rows = data || [];
      break;
    }
    if (!rows && lastError) throw /** @type {Error} */ (lastError);
    for (const row of rows || []) {
      const nk =
        row?.normalized_sku != null && String(row.normalized_sku).trim() !== ""
          ? normalizeSkuForDbLookup(String(row.normalized_sku))
          : row?.sku != null
            ? normalizeSkuForDbLookup(String(row.sku))
            : "";
      if (nk && !map.has(nk)) map.set(nk, row);
    }
  }
  return map;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string[]} accountIds
 */
async function fetchMarketplaceAccounts(supabase, userId, accountIds) {
  /** @type {Map<string, Record<string, unknown>>} */
  const map = new Map();
  const chunks = chunkIds(accountIds, 150);
  const selectVariants = [
    "id,account_alias,ml_nickname,external_seller_id,seller_company_id,logo_url,avatar_url",
    "id,account_alias,ml_nickname,external_seller_id,seller_company_id,logo_url",
    "id,account_alias,ml_nickname,external_seller_id,seller_company_id",
    "id,account_alias,ml_nickname,external_seller_id",
  ];
  for (const chunk of chunks) {
    if (chunk.length === 0) continue;
    /** @type {Record<string, unknown>[] | null} */
    let rows = null;
    for (const sel of selectVariants) {
      const { data, error } = await supabase.from("marketplace_accounts").select(sel).eq("user_id", userId).in("id", chunk);
      if (!error) {
        rows = data ?? [];
        break;
      }
      if (!isShapeError(error)) break;
    }
    for (const row of rows || []) {
      if (row?.id) map.set(String(row.id), row);
    }
  }
  return map;
}

/**
 * Logos da empresa (Perfil da Empresa / seller_companies) para coluna Conta em /vendas.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string[]} companyIds
 */
async function fetchSellerCompaniesById(supabase, userId, companyIds) {
  /** @type {Map<string, Record<string, unknown>>} */
  const map = new Map();
  const uniq = [...new Set((companyIds || []).filter(Boolean).map(String))];
  const chunks = chunkIds(uniq, 150);
  const selectVariants = [
    "id,logo_url,trade_name,company_name,default_tax_rate",
    "id,logo_url,default_tax_rate",
    "id,logo_url,trade_name,company_name",
    "id,logo_url",
    "id",
  ];
  for (const chunk of chunks) {
    if (chunk.length === 0) continue;
    /** @type {Record<string, unknown>[] | null} */
    let rows = null;
    for (const sel of selectVariants) {
      const { data, error } = await supabase.from("seller_companies").select(sel).eq("user_id", userId).in("id", chunk);
      if (!error) {
        rows = data ?? [];
        break;
      }
      if (!isShapeError(error)) break;
    }
    for (const row of rows || []) {
      if (row?.id) map.set(String(row.id), row);
    }
  }
  return map;
}

function buyerCompositeKey(marketplace, marketplaceAccountId, externalCustomerId) {
  return `${String(marketplace)}::${String(marketplaceAccountId)}::${String(externalCustomerId)}`;
}

/**
 * Batch lookup marketplace_customers por (marketplace, conta, buyer id ML).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ marketplace: string; marketplace_account_id: string; external_customer_id: string }[]} triples
 */
async function fetchMarketplaceCustomersBatch(supabase, userId, triples) {
  /** @type {Map<string, Record<string, unknown>>} */
  const map = new Map();
  const uniq = [];
  const seen = new Set();
  for (const t of triples) {
    if (!t.marketplace || !t.marketplace_account_id || !t.external_customer_id) continue;
    const k = buyerCompositeKey(t.marketplace, t.marketplace_account_id, t.external_customer_id);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(t);
  }
  const chunkSize = 12;
  for (let i = 0; i < uniq.length; i += chunkSize) {
    const chunk = uniq.slice(i, i + chunkSize);
    const orExpr = chunk
      .map((t) => {
        const ext = String(t.external_customer_id).replace(/[^a-zA-Z0-9._-]/g, "");
        const mkt = String(t.marketplace).replace(/[^a-zA-Z0-9_-]/g, "");
        return `and(marketplace.eq.${mkt},marketplace_account_id.eq.${t.marketplace_account_id},external_customer_id.eq.${ext})`;
      })
      .join(",");
    const { data, error } = await supabase
      .from("marketplace_customers")
      .select("marketplace, marketplace_account_id, external_customer_id, name")
      .eq("user_id", userId)
      .or(orExpr);
    if (error) {
      if (isShapeError(error)) return map;
      throw error;
    }
    for (const row of data || []) {
      const mk = buyerCompositeKey(row.marketplace, row.marketplace_account_id, row.external_customer_id);
      map.set(mk, row);
    }
  }
  return map;
}

/**
 * @param {Record<string, unknown>[]} items
 * @param {Map<string, Record<string, unknown>>} ordersById
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 */
export async function buildVendasUiRowsFromOrderItems(supabase, userId, itemRows) {
  const orderIds = [...new Set(itemRows.map((r) => r?.sales_order_id).filter(Boolean).map(String))];
  const ordersById = await fetchOrdersById(supabase, userId, orderIds);
  return hydrateAndBuildRows(itemRows, ordersById, supabase, userId);
}

/**
 * Hidratação enxuta para executive-summary (rankings): listings + produtos apenas.
 * Evita batch de compradores/contas/empresas da listagem completa /vendas.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown>[]} itemRows
 * @param {Map<string, Record<string, unknown>>} ordersById
 */
export async function hydrateExecutiveSummaryRankingRows(supabase, userId, itemRows, ordersById) {
  /** @type {Map<string, { marketplace: string; accountId: string | null; ids: Set<string> }>} */
  const listingBuckets = new Map();

  for (const it of itemRows) {
    const mkt = it.marketplace != null ? String(it.marketplace) : "";
    const ext = it.external_listing_id != null ? String(it.external_listing_id).trim() : "";
    const oid = it.sales_order_id != null ? String(it.sales_order_id) : "";
    const ord = oid ? ordersById.get(oid) : null;
    const accGuess =
      it.marketplace_account_id != null && String(it.marketplace_account_id).trim() !== ""
        ? String(it.marketplace_account_id).trim()
        : ord?.marketplace_account_id != null && String(ord.marketplace_account_id).trim() !== ""
          ? String(ord.marketplace_account_id).trim()
          : "";
    if (mkt && ext) {
      const bk = `${mkt}::${accGuess || "__none__"}`;
      if (!listingBuckets.has(bk)) {
        listingBuckets.set(bk, { marketplace: mkt, accountId: accGuess || null, ids: new Set() });
      }
      listingBuckets.get(bk).ids.add(ext);
    }
  }

  const listingBucketList = [...listingBuckets.values()].map((v) => ({
    marketplace: v.marketplace,
    accountId: v.accountId,
    externalListingIds: [...v.ids],
  }));

  const listingsMap = await fetchListingsForVendasBuckets(supabase, userId, listingBucketList);

  /** @type {string[]} */
  const productIds = [];
  for (const l of listingsMap.values()) {
    if (l?.product_id) productIds.push(String(l.product_id));
  }

  let productsById = await fetchProductsById(supabase, userId, productIds);

  /** @type {string[]} */
  const normCandidates = [];
  for (const it of itemRows) {
    const mkt = it.marketplace != null ? String(it.marketplace) : "";
    const ext = it.external_listing_id != null ? String(it.external_listing_id).trim() : "";
    const listing = mkt && ext ? listingsMap.get(`${mkt}::${ext}`) : null;
    const linkedPid = listing?.product_id != null ? String(listing.product_id) : null;
    if (linkedPid && productsById.has(linkedPid)) continue;
    const skuTry =
      it.sku_snapshot != null && String(it.sku_snapshot).trim() !== ""
        ? String(it.sku_snapshot).trim()
        : listing?.seller_sku != null && String(listing.seller_sku).trim() !== ""
          ? String(listing.seller_sku).trim()
          : "";
    const nk = skuTry ? normalizeSkuForDbLookup(skuTry) : "";
    if (nk) normCandidates.push(nk);
  }

  const productsByNorm = await fetchProductsByNormalizedSku(supabase, userId, normCandidates);
  for (const p of productsByNorm.values()) {
    if (p?.id) productsById.set(String(p.id), p);
  }

  return itemRows.map((it) => {
    const oid = it.sales_order_id != null ? String(it.sales_order_id) : "";
    const order = oid ? ordersById.get(oid) ?? null : null;
    const mkt = it.marketplace != null ? String(it.marketplace) : "";
    const ext = it.external_listing_id != null ? String(it.external_listing_id).trim() : "";
    const accGuess =
      it.marketplace_account_id != null && String(it.marketplace_account_id).trim() !== ""
        ? String(it.marketplace_account_id).trim()
        : order?.marketplace_account_id != null && String(order.marketplace_account_id).trim() !== ""
          ? String(order.marketplace_account_id).trim()
          : "";
    const listing = mkt && ext ? pickListingForVendasLine(listingsMap, mkt, ext, accGuess) : null;

    let product = null;
    if (listing?.product_id) {
      const pid = String(listing.product_id);
      product = productsById.get(pid) ?? null;
    }
    if (!product) {
      const skuTry =
        it.sku_snapshot != null && String(it.sku_snapshot).trim() !== ""
          ? String(it.sku_snapshot).trim()
          : listing?.seller_sku != null && String(listing.seller_sku).trim() !== ""
            ? String(listing.seller_sku).trim()
            : "";
      const nk = skuTry ? normalizeSkuForDbLookup(skuTry) : "";
      if (nk) product = productsByNorm.get(nk) ?? null;
    }

    const row = buildVendasListRow({
      item: it,
      order,
      listing,
      product,
      account: null,
      customer: null,
      sellerCompany: null,
    });

    const thumb = resolveExecutiveRankingImageUrl({ item: it, row, listing, product });
    const listingThumb = listing ? thumbFromListingRecord(listing) : null;
    const resolved =
      thumb ??
      listingThumb ??
      (row.listing_thumbnail_url != null ? String(row.listing_thumbnail_url) : null) ??
      (row.product_thumbnail_url != null ? String(row.product_thumbnail_url) : null);

    if (resolved) {
      row.product_thumbnail_url = resolved;
      row.listing_thumbnail_url = resolved;
      if (!row.product_image_url) row.product_image_url = resolved;
    }

    return row;
  });
}

async function hydrateAndBuildRows(items, ordersById, supabase, userId) {
  /** @type {Map<string, { marketplace: string; accountId: string | null; ids: Set<string> }>} */
  const listingBuckets = new Map();
  /** @type {string[]} */
  const accountIdCandidates = [];
  /** @type {{ marketplace: string; marketplace_account_id: string; external_customer_id: string }[]} */
  const buyerTriples = [];

  for (const it of items) {
    const mkt = it.marketplace != null ? String(it.marketplace) : "";
    const ext = it.external_listing_id != null ? String(it.external_listing_id).trim() : "";
    const oid = it.sales_order_id != null ? String(it.sales_order_id) : "";
    const ord = oid ? ordersById.get(oid) : null;
    const accGuess =
      it.marketplace_account_id != null && String(it.marketplace_account_id).trim() !== ""
        ? String(it.marketplace_account_id).trim()
        : ord?.marketplace_account_id != null && String(ord.marketplace_account_id).trim() !== ""
          ? String(ord.marketplace_account_id).trim()
          : "";
    if (mkt && ext) {
      const bk = `${mkt}::${accGuess || "__none__"}`;
      if (!listingBuckets.has(bk)) {
        listingBuckets.set(bk, { marketplace: mkt, accountId: accGuess || null, ids: new Set() });
      }
      listingBuckets.get(bk).ids.add(ext);
    }
    if (it.marketplace_account_id) accountIdCandidates.push(String(it.marketplace_account_id));
    if (ord?.marketplace_account_id) accountIdCandidates.push(String(ord.marketplace_account_id));

    const raw = ord?.raw_json && typeof ord.raw_json === "object" ? /** @type {Record<string, unknown>} */ (ord.raw_json) : null;
    const buyer = raw?.buyer && typeof raw.buyer === "object" ? /** @type {Record<string, unknown>} */ (raw.buyer) : null;
    const extBid = buyer?.id != null ? String(buyer.id).trim() : "";
    const mktIt =
      it.marketplace != null && String(it.marketplace).trim() !== ""
        ? String(it.marketplace).trim()
        : ord?.marketplace != null && String(ord.marketplace).trim() !== ""
          ? String(ord.marketplace).trim()
          : "";
    const accIt =
      it.marketplace_account_id != null && String(it.marketplace_account_id).trim() !== ""
        ? String(it.marketplace_account_id).trim()
        : ord?.marketplace_account_id != null && String(ord.marketplace_account_id).trim() !== ""
          ? String(ord.marketplace_account_id).trim()
          : "";
    if (extBid && mktIt && accIt) {
      buyerTriples.push({
        marketplace: mktIt,
        marketplace_account_id: accIt,
        external_customer_id: extBid,
      });
    }
  }

  const listingBucketList = [...listingBuckets.values()].map((v) => ({
    marketplace: v.marketplace,
    accountId: v.accountId,
    externalListingIds: [...v.ids],
  }));

  const [listingsMap, customersMap] = await Promise.all([
    fetchListingsForVendasBuckets(supabase, userId, listingBucketList),
    fetchMarketplaceCustomersBatch(supabase, userId, buyerTriples),
  ]);

  /** @type {string[]} */
  const productIds = [];
  for (const l of listingsMap.values()) {
    if (l?.product_id) productIds.push(String(l.product_id));
  }

  let productsById = await fetchProductsById(supabase, userId, productIds);

  /** @type {string[]} */
  const normCandidates = [];
  for (const it of items) {
    const mkt = it.marketplace != null ? String(it.marketplace) : "";
    const ext = it.external_listing_id != null ? String(it.external_listing_id).trim() : "";
    const listing = mkt && ext ? listingsMap.get(`${mkt}::${ext}`) : null;
    const linkedPid = listing?.product_id != null ? String(listing.product_id) : null;
    if (linkedPid && productsById.has(linkedPid)) continue;
    const skuTry =
      it.sku_snapshot != null && String(it.sku_snapshot).trim() !== ""
        ? String(it.sku_snapshot).trim()
        : it.sku != null && String(it.sku).trim() !== ""
          ? String(it.sku).trim()
          : listing?.seller_sku != null && String(listing.seller_sku).trim() !== ""
            ? String(listing.seller_sku).trim()
            : "";
    const nk = skuTry ? normalizeSkuForDbLookup(skuTry) : "";
    if (nk) normCandidates.push(nk);
  }

  const productsByNorm = await fetchProductsByNormalizedSku(supabase, userId, normCandidates);
  for (const p of productsByNorm.values()) {
    if (p?.id) productsById.set(String(p.id), p);
  }

  const accountsMap = await fetchMarketplaceAccounts(supabase, userId, accountIdCandidates);

  /** @type {string[]} */
  const sellerCompanyIds = [];
  for (const acc of accountsMap.values()) {
    const sc = acc?.seller_company_id;
    if (sc != null && String(sc).trim() !== "") sellerCompanyIds.push(String(sc).trim());
  }
  const companiesMap = await fetchSellerCompaniesById(supabase, userId, sellerCompanyIds);

  const rows = items.map((it) => {
    const oid = it.sales_order_id != null ? String(it.sales_order_id) : "";
    const order = oid ? ordersById.get(oid) ?? null : null;
    const mkt = it.marketplace != null ? String(it.marketplace) : "";
    const ext = it.external_listing_id != null ? String(it.external_listing_id).trim() : "";
    const accGuess =
      it.marketplace_account_id != null && String(it.marketplace_account_id).trim() !== ""
        ? String(it.marketplace_account_id).trim()
        : order?.marketplace_account_id != null && String(order.marketplace_account_id).trim() !== ""
          ? String(order.marketplace_account_id).trim()
          : "";
    const listing = mkt && ext ? pickListingForVendasLine(listingsMap, mkt, ext, accGuess) : null;

    let product = null;
    if (listing?.product_id) {
      const pid = String(listing.product_id);
      product = productsById.get(pid) ?? null;
    }
    if (!product) {
      const skuTry =
        it.sku_snapshot != null && String(it.sku_snapshot).trim() !== ""
          ? String(it.sku_snapshot).trim()
          : it.sku != null && String(it.sku).trim() !== ""
            ? String(it.sku).trim()
            : listing?.seller_sku != null && String(listing.seller_sku).trim() !== ""
              ? String(listing.seller_sku).trim()
              : "";
      const nk = skuTry ? normalizeSkuForDbLookup(skuTry) : "";
      if (nk) product = productsByNorm.get(nk) ?? null;
    }

    const accId =
      it.marketplace_account_id != null && String(it.marketplace_account_id).trim() !== ""
        ? String(it.marketplace_account_id).trim()
        : order?.marketplace_account_id != null && String(order.marketplace_account_id).trim() !== ""
          ? String(order.marketplace_account_id).trim()
          : null;
    const account = accId ? accountsMap.get(accId) ?? null : null;
    const sellerCompanyId =
      account?.seller_company_id != null && String(account.seller_company_id).trim() !== ""
        ? String(account.seller_company_id).trim()
        : null;
    const sellerCompany = sellerCompanyId ? companiesMap.get(sellerCompanyId) ?? null : null;

    const orderRaw =
      order?.raw_json && typeof order.raw_json === "object" ? /** @type {Record<string, unknown>} */ (order.raw_json) : null;
    const buyerObj =
      orderRaw?.buyer && typeof orderRaw.buyer === "object"
        ? /** @type {Record<string, unknown>} */ (orderRaw.buyer)
        : null;
    const extBid = buyerObj?.id != null ? String(buyerObj.id).trim() : "";
    const mktIt =
      it.marketplace != null && String(it.marketplace).trim() !== ""
        ? String(it.marketplace).trim()
        : order?.marketplace != null && String(order.marketplace).trim() !== ""
          ? String(order.marketplace).trim()
          : "";
    const accIt =
      it.marketplace_account_id != null && String(it.marketplace_account_id).trim() !== ""
        ? String(it.marketplace_account_id).trim()
        : order?.marketplace_account_id != null && String(order.marketplace_account_id).trim() !== ""
          ? String(order.marketplace_account_id).trim()
          : "";
    const customer =
      extBid && mktIt && accIt ? customersMap.get(buyerCompositeKey(mktIt, accIt, extBid)) ?? null : null;

    return buildVendasListRow({ item: it, order, listing, product, account, customer, sellerCompany });
  });

  return enrichVendasListRowsOperationalStatus(userId, items, ordersById, rows);
}

async function legacySalesOrdersList(supabase, userId, page, pageSize) {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const selectVariants = [
    {
      table: "sales_orders",
      select: "id,user_id,marketplace,marketplace_account_id,seller_company_id,external_order_id,date_created_marketplace,total_amount,updated_at,created_at",
      orderBy: "date_created_marketplace",
    },
    {
      table: "sales_orders",
      select: "*",
      orderBy: "created_at",
    },
    {
      table: "sales",
      select: "*",
      orderBy: "created_at",
    },
  ];

  let rows = [];
  let total = 0;
  let usedTable = null;
  for (const v of selectVariants) {
    let q = supabase
      .from(v.table)
      .select(v.select, { count: "exact" })
      .eq("user_id", userId)
      .order(v.orderBy, { ascending: false });
    if (v.orderBy === "date_created_marketplace") {
      q = q.order("created_at", { ascending: false });
    }
    const { data, error, count } = await q.range(from, to);
    if (!error) {
      rows = Array.isArray(data) ? data : [];
      total = Number.isFinite(count) ? count : rows.length;
      usedTable = v.table;
      break;
    }
    if (!isShapeError(error)) {
      console.error("[Suse7][API][sales-list] legacy_failed", {
        message: error?.message,
        code: error?.code,
        table: v.table,
      });
      return { rows: [], total: 0, usedTable: null };
    }
  }
  return { rows, total, usedTable };
}

export default async function handleSalesList(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const page = toPositiveInt(req.query?.page, 1);
  const pageSize = Math.min(200, toPositiveInt(req.query?.page_size, 50));
  const marketplace =
    req.query?.marketplace != null && String(req.query.marketplace).trim() !== ""
      ? String(req.query.marketplace).trim()
      : null;
  const marketplaceAccountId =
    req.query?.marketplace_account_id != null && String(req.query.marketplace_account_id).trim() !== ""
      ? String(req.query.marketplace_account_id).trim()
      : null;
  const qRaw = req.query?.q != null && String(req.query.q).trim() !== "" ? String(req.query.q).trim() : null;
  const qNormalized = qRaw ? normalizeSearchQuery(qRaw) : null;

  const auth = await requireAuthUser(req);
  if (auth.error) {
    if (auth.error.code === "CONFIG_ERROR") {
      return res.status(200).json(emptySalesPayload(page, pageSize));
    }
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  if (await gatePremiumHandler(res, supabase, user.id, { module: "vendas" })) return;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  try {
    const ITEM_ORDER_EMBED =
      "*,sales_orders!inner(id,date_created_marketplace,date_closed_marketplace,paid_at,created_at,user_id)";

    /** Pedidos cujo raw_json / código / nome em marketplace_customers casa com a busca (complementa filtros na linha). */
    let orderIdsForSearch = [];
    if (qNormalized) {
      orderIdsForSearch = await fetchVendasSearchOrderIds(supabase, user.id, qNormalized, 800);
    }

    /**
     * @param {*} qb
     * @param {{
     *   userId: string;
     *   marketplace: string | null;
     *   marketplaceAccountId: string | null;
     *   qNormalized: string | null;
     *   orderIdsForSearch: string[];
     * }} f
     */
    function applySalesItemListFilters(qb, f) {
      let q = qb.eq("user_id", f.userId);
      if (f.marketplace) q = q.eq("marketplace", f.marketplace);
      if (f.marketplaceAccountId) q = q.eq("marketplace_account_id", f.marketplaceAccountId);
      if (f.qNormalized) {
        const tokens = splitSearchTokens(f.qNormalized);
        if (tokens.length > 0) {
          const orExpr = buildVendasSalesItemQOrFilter(
            tokens,
            Array.isArray(f.orderIdsForSearch) ? f.orderIdsForSearch : [],
          );
          if (orExpr) q = q.or(orExpr);
        }
      }
      return q;
    }

    const filterCtx = { userId: user.id, marketplace, marketplaceAccountId, qNormalized, orderIdsForSearch };

    /** @type {Record<string, unknown>[]} */
    let itemRows = [];
    let total = 0;
    /** @type {'rpc_v1' | 'postgrest_embed' | 'postgrest_plain'} */
    let listSource = "rpc_v1";
    let fallbackUsed = false;
    /** @type {string | null} */
    let rpcErrorMsg = null;
    let rpcRowsCount = 0;
    let rpcTotalCount = 0;

    /**
     * RPC pode não aplicar marketplace/conta como o PostgREST — com qualquer filtro explícito
     * de canal ou conta, listamos via embed (fonte de verdade = colunas em sales_order_items).
     */
    const skipRpcForListFilters =
      (marketplace != null && String(marketplace).trim() !== "") ||
      (marketplaceAccountId != null && String(marketplaceAccountId).trim() !== "") ||
      (qNormalized != null && qNormalized !== "");
    const rpcRes = skipRpcForListFilters
      ? { data: null, error: { message: "skip_rpc_marketplace_or_account_filter" } }
      : await supabase.rpc("s7_sales_order_items_page_v1", {
          p_user_id: user.id,
          p_marketplace: marketplace,
          p_q: qNormalized,
          p_limit: pageSize,
          p_offset: from,
        });

    let usePostgrestInstead =
      skipRpcForListFilters ||
      Boolean(rpcRes.error) ||
      rpcRes.data == null ||
      typeof rpcRes.data !== "object";

    if (rpcRes.error) {
      rpcErrorMsg = String(rpcRes.error.message ?? rpcRes.error);
      console.warn("[S7][sales-list] s7_sales_order_items_page_v1_fallback", {
        message: rpcRes.error.message,
        code: rpcRes.error.code,
      });
    }

    if (!usePostgrestInstead) {
      const payload = /** @type {{ total?: unknown; ids?: unknown }} */ (rpcRes.data);
      rpcTotalCount = Number(payload.total ?? 0);
      const rawIds = payload.ids;
      const ids = Array.isArray(rawIds) ? rawIds.map((x) => String(x)) : [];
      rpcRowsCount = ids.length;

      const noListFilters = !marketplace && !marketplaceAccountId && !qNormalized;
      if (noListFilters && rpcTotalCount === 0 && ids.length === 0) {
        const { count: baseItemCount, error: baseErr } = await supabase
          .from("sales_order_items")
          .select("*", { count: "exact", head: true })
          .eq("user_id", user.id);
        const bc = Number(baseItemCount ?? 0);
        if (!baseErr && bc > 0) {
          console.warn("[S7_VENDAS_RPC_ZERO_SUSPECT_FALLBACK]", {
            user_id: user.id,
            base_sales_order_items_count: bc,
            rpc_total: rpcTotalCount,
            hint: "RPC retornou vazio com usuário tendo linhas em sales_order_items — usando PostgREST até RPC alinhado.",
          });
          usePostgrestInstead = true;
          fallbackUsed = true;
        }
      }

      if (!usePostgrestInstead) {
        total = rpcTotalCount;
        if (ids.length === 0) {
          itemRows = [];
        } else {
          const { data: fetched, error: fe } = await supabase.from("sales_order_items").select("*").in("id", ids);
          if (fe) throw fe;
          const byId = new Map((fetched || []).map((r) => [String(r.id), r]));
          itemRows = ids.map((id) => byId.get(id)).filter(Boolean);
        }
      }
    }

    if (usePostgrestInstead) {
      fallbackUsed = true;
      listSource = "postgrest_embed";
      let itemsQuery = applySalesItemListFilters(
        supabase.from("sales_order_items").select(ITEM_ORDER_EMBED, { count: "exact" }),
        filterCtx,
      );

      let r1 = await itemsQuery
        .order("date_created_marketplace", { ascending: false, nullsFirst: false, foreignTable: "sales_orders" })
        .order("created_at", { ascending: false, nullsFirst: false, foreignTable: "sales_orders" })
        .order("created_at", { ascending: false, nullsFirst: false })
        .order("id", { ascending: false })
        .range(from, to);

      /** @type {unknown} */
      let items = r1.data;
      let itemErr = r1.error;
      let count = r1.count;

      const msg1 = String(itemErr?.message ?? "").toLowerCase();
      const missingRelation =
        itemErr?.code === "42P01" ||
        msg1.includes("does not exist") ||
        msg1.includes("schema cache") ||
        msg1.includes("could not find the table");

      if (itemErr && !missingRelation) {
        listSource = "postgrest_plain";
        const r2 = await applySalesItemListFilters(
          supabase.from("sales_order_items").select("*", { count: "exact" }),
          filterCtx,
        )
          .order("created_at", { ascending: false })
          .range(from, to);
        if (!r2.error) {
          items = r2.data;
          itemErr = r2.error;
          count = r2.count;
        }
      }

      if (itemErr) {
        const msg = String(itemErr?.message ?? "").toLowerCase();
        const missingRelationLegacy =
          itemErr?.code === "42P01" ||
          msg.includes("does not exist") ||
          msg.includes("schema cache") ||
          msg.includes("could not find the table");

        console.error("[Suse7][API][sales-list] items_query_failed", {
          message: itemErr?.message,
          code: itemErr?.code,
          missingRelation: missingRelationLegacy,
        });

        if (missingRelationLegacy) {
          const legacy = await legacySalesOrdersList(supabase, user.id, page, pageSize);
          if (!legacy.usedTable) {
            return res.status(200).json(emptySalesPayload(page, pageSize));
          }
          const legPag = buildPaginationMeta(page, pageSize, legacy.total);
          return res.status(200).json({
            ok: true,
            items: legacy.rows,
            rows: legacy.rows,
            page: legPag.page,
            page_size: legPag.page_size,
            total: legPag.total,
            total_pages: legPag.total_pages,
            has_next: legPag.has_next,
            has_previous: legPag.has_previous,
            pagination: legPag,
            source_table: legacy.usedTable,
          });
        }

        return res.status(200).json(emptySalesPayload(page, pageSize));
      }

      itemRows = Array.isArray(items)
        ? items.map((row) => {
            if (!row || typeof row !== "object") return /** @type {Record<string, unknown>} */ (row);
            const { sales_orders: _nested, ...rest } = /** @type {Record<string, unknown>} */ (row);
            return rest;
          })
        : [];
      total = Number.isFinite(count) ? Number(count) : itemRows.length;
    }

    const orderIds = [...new Set(itemRows.map((r) => r?.sales_order_id).filter(Boolean).map(String))];
    const ordersById = await fetchOrdersById(supabase, user.id, orderIds);
    if (listSource !== "rpc_v1") {
      sortSalesOrderItemsForVendasList(itemRows, ordersById);
    }

    const rows = await hydrateAndBuildRows(itemRows, ordersById, supabase, user.id);

    const distinctAcct = [...new Set(rows.map((r) => r?.marketplace_account_id).filter(Boolean).map(String))];
    console.info("[sales/list] account_join_summary", {
      user_id: user.id,
      row_count: rows.length,
      distinct_marketplace_account_ids: distinctAcct.length,
      marketplace_account_ids: distinctAcct.slice(0, 40),
      filters: { marketplace, marketplace_account_id: marketplaceAccountId },
      list_source: listSource,
    });

    const debugOrder =
      process.env.S7_VENDAS_ORDER_DEBUG === "1" || process.env.NODE_ENV !== "production";
    if (debugOrder) {
      const first = rows[0];
      const last = rows.length ? rows[rows.length - 1] : null;
      console.info("[S7_VENDAS_ORDER_DEBUG]", {
        list_source: listSource,
        user_id: user.id,
        page,
        limit: pageSize,
        offset: from,
        filters: { marketplace, marketplace_account_id: marketplaceAccountId, q: qRaw },
        rpc_rows_count: rpcRowsCount,
        rpc_total_count: rpcTotalCount,
        fallback_used: fallbackUsed,
        rpc_error: rpcErrorMsg,
        first_row_date_created_marketplace: first?.date_created_marketplace ?? null,
        last_row_date_created_marketplace: last?.date_created_marketplace ?? null,
        first_row_marketplace_account_id: first?.marketplace_account_id ?? null,
        last_row_marketplace_account_id: last?.marketplace_account_id ?? null,
        total_rows: rows.length,
        pagination_total: total,
      });
    }

    if (process.env.NODE_ENV !== "production") {
      const first = rows[0];
      console.log("[S7][sales-list-debug]", {
        list_source: listSource,
        totalRows: rows.length,
        paginationTotal: total,
        keyExample: first
          ? {
              item_id: first.item_id,
              sale_item_id: first.sale_item_id,
              external_order_id: first.external_order_id,
              external_order_item_id: first.external_order_item_id,
            }
          : null,
        productFields: first
          ? {
              product_display_title: first.product_display_title,
              sku_display: first.sku_display,
              has_listing_id: Boolean(first.listing_id_display),
              product_image_url: first.product_image_url,
              product_thumbnail_url: first.product_thumbnail_url,
              needs_product_completion: first.needs_product_completion,
              buyer_display_name: first.buyer_display_name,
            }
          : null,
        moneySample: first
          ? {
              gross: toNum(itemRows[0]?.gross_amount),
              fee: toNum(itemRows[0]?.fee_amount),
              net: toNum(itemRows[0]?.net_amount),
            }
          : null,
      });
    }

    const pag = buildPaginationMeta(page, pageSize, total);
    return res.status(200).json({
      ok: true,
      items: rows,
      rows,
      page: pag.page,
      page_size: pag.page_size,
      total: pag.total,
      total_pages: pag.total_pages,
      has_next: pag.has_next,
      has_previous: pag.has_previous,
      pagination: pag,
      source_table: listSource === "rpc_v1" ? "sales_order_items+rpc_v1" : "sales_order_items",
      list_source: listSource,
    });
  } catch (error) {
    console.error("[Suse7][API][sales-list] failed", {
      message: error?.message,
      code: error?.code,
      details: error?.details,
    });
    return res.status(200).json(emptySalesPayload(page, pageSize));
  }
}
