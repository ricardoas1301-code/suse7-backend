// ============================================================
// S7 — Concorrência: repository (acesso a dados)
// Concentra TODAS as queries Supabase do módulo de concorrência.
// O handler permanece fino: valida entrada, chama o repository e
// formata a resposta com o contrato único (competitionNormalizer).
//
// Service role bypassa RLS → ownership é SEMPRE filtrado por user_id
// explicitamente aqui (padrão do projeto).
// ============================================================

import { toCompetitorResponse } from "./competitionNormalizer.js";

export const DEFAULT_MARKETPLACE = "mercado_livre";

/** Colunas estáveis do concorrente (alinhadas à migration 20260608154500). */
const COMPETITOR_COLUMNS =
  "id, user_id, marketplace, marketplace_account_id, seller_company_id, product_id, monitored_listing_id, sku, " +
  "competitor_listing_id, competitor_title, competitor_seller_id, competitor_store_name, " +
  "competitor_permalink, competitor_thumbnail, source_strategy, is_active, competitor_listing_status, " +
  "last_seen_price, last_seen_currency, last_captured_at, created_at, updated_at";

/** Produto pertencente ao usuário, ou null. Base da validação de ownership. */
export async function findOwnedProduct(supabase, userId, productId) {
  const { data, error } = await supabase
    .from("products")
    .select("id, sku, product_name")
    .eq("id", productId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/** Resumo do anúncio próprio (preço/vendas) a partir do listing vinculado. */
export function extractOwnListingSummary(listingRow) {
  const raw =
    listingRow?.raw_json && typeof listingRow.raw_json === "object" ? listingRow.raw_json : null;
  if (!raw) {
    return {
      listing_id: listingRow?.external_listing_id ?? null,
      price: null,
      currency: "BRL",
      sales: null,
      listing_type: null,
      listing_type_id: null,
    };
  }
  const priceRaw = raw.price ?? raw.base_price ?? null;
  let price = null;
  if (priceRaw != null) {
    const n = Number(priceRaw);
    if (Number.isFinite(n) && n > 0) price = n.toFixed(2);
  }
  const currency = raw.currency_id != null ? String(raw.currency_id) : "BRL";
  const sold = Number(raw.sold_quantity);
  const sales = Number.isFinite(sold) && sold > 0 ? Math.trunc(sold) : null;
  const listingTypeId =
    raw.listing_type_id != null && String(raw.listing_type_id).trim() !== ""
      ? String(raw.listing_type_id).trim()
      : null;
  return {
    listing_id: listingRow?.external_listing_id ?? raw.id ?? null,
    price,
    currency,
    sales,
    listing_type: listingTypeId,
    listing_type_id: listingTypeId,
  };
}

/** Listings primários (mais recentes) por product_id — batch para lista principal. */
export async function findPrimaryListingsForProducts(supabase, userId, productIds) {
  const ids = [...new Set((Array.isArray(productIds) ? productIds : []).map(String).filter(Boolean))];
  const map = new Map();
  if (!ids.length) return map;

  const { data, error } = await supabase
    .from("marketplace_listings")
    .select("product_id, external_listing_id, raw_json, api_last_seen_at")
    .eq("user_id", userId)
    .in("product_id", ids)
    .order("api_last_seen_at", { ascending: false });
  if (error) throw error;

  for (const row of data || []) {
    const key = String(row.product_id);
    if (!map.has(key)) map.set(key, row);
  }
  return map;
}

/**
 * Lista produtos do usuário com a contagem de concorrentes ATIVOS e uma projeção
 * compacta dos concorrentes (para preencher as colunas da lista principal sem N+1).
 * image_url fica null nesta fase (capa é resolvida no front via signed URL).
 */
export async function listProductsWithCompetitorCounts(supabase, userId) {
  const { data: products, error: pErr } = await supabase
    .from("products")
    .select("id, sku, product_name")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (pErr) throw pErr;

  const productIds = (products || []).map((p) => p.id).filter(Boolean);

  const [compsRes, listingsMap] = await Promise.all([
    supabase
      .from("competition_competitors")
      .select(COMPETITOR_COLUMNS)
      .eq("user_id", userId)
      .eq("is_active", true)
      .order("created_at", { ascending: true }),
    findPrimaryListingsForProducts(supabase, userId, productIds),
  ]);

  if (compsRes.error) throw compsRes.error;
  const comps = compsRes.data || [];

  let snapshotMeta = new Map();
  try {
    snapshotMeta = await findLatestSnapshotMetaForCompetitors(
      supabase,
      userId,
      comps.map((r) => r.id).filter(Boolean)
    );
  } catch (metaErr) {
    console.error("[competition] snapshot meta indisponível; lista segue sem enrich de snapshot", {
      message: metaErr?.message,
      code: metaErr?.code,
    });
  }

  const byProduct = new Map();
  for (const row of comps) {
    const key = String(row.product_id);
    if (!byProduct.has(key)) byProduct.set(key, []);
    const meta = snapshotMeta.get(row.id) ?? {};
    byProduct.get(key).push(
      toCompetitorResponse(row, {
        sales_hint: meta.sales_hint ?? null,
        shipping: meta.shipping ?? null,
        listing_type: meta.listing_type ?? null,
        reputation: meta.reputation ?? null,
        snapshot_thumbnail: meta.competitor_thumbnail ?? null,
        snapshot_store_name: meta.competitor_store_name ?? null,
        snapshot_price: meta.competitor_price ?? null,
        snapshot_title: meta.competitor_title ?? null,
        snapshot_captured_at: meta.captured_at ?? null,
        listing_status: meta.listing_status ?? null,
        competitor_pictures: meta.competitor_pictures ?? null,
      })
    );
  }

  return (products || []).map((p) => {
    const competitors = byProduct.get(String(p.id)) || [];
    const listingRow = listingsMap.get(String(p.id)) ?? null;
    const ownListing = extractOwnListingSummary(listingRow);
    return {
      product_id: p.id,
      sku: p.sku ?? null,
      product_name: p.product_name ?? null,
      image_url: null,
      marketplace: DEFAULT_MARKETPLACE,
      competitors_count: competitors.length,
      has_competitors: competitors.length > 0,
      competitors,
      own_listing: ownListing,
    };
  });
}

/** Contagem de concorrentes ATIVOS de um produto (usada para o limite funcional). */
export async function countActiveCompetitors(supabase, userId, productId) {
  const { count, error } = await supabase
    .from("competition_competitors")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("product_id", productId)
    .eq("is_active", true);
  if (error) throw error;
  return typeof count === "number" ? count : 0;
}

/**
 * Anúncio do seller vinculado ao produto (mais recente), base do contexto de descoberta:
 * catalog_product_id / catalog_listing / category_id / título / atributos (raw_json) e conta.
 * Retorna null quando o produto ainda não tem anúncio vinculado (descoberta cai para busca por nome).
 */
export async function findPrimaryListingForProduct(supabase, userId, productId) {
  const { data, error } = await supabase
    .from("marketplace_listings")
    .select(
      "id, external_listing_id, marketplace, marketplace_account_id, seller_company_id, category_id, catalog_listing, catalog_product_id, title, raw_json"
    )
    .eq("user_id", userId)
    .eq("product_id", productId)
    .order("api_last_seen_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return Array.isArray(data) && data.length ? data[0] : null;
}

/** Concorrentes ativos de um produto (ordem estável de cadastro). */
export async function listActiveCompetitors(supabase, userId, productId) {
  const { data, error } = await supabase
    .from("competition_competitors")
    .select(COMPETITOR_COLUMNS)
    .eq("user_id", userId)
    .eq("product_id", productId)
    .eq("is_active", true)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

/** Concorrente por id (qualquer status) restrito ao dono. Usado no DELETE/ownership. */
export async function findCompetitorById(supabase, userId, competitorId) {
  const { data, error } = await supabase
    .from("competition_competitors")
    .select(COMPETITOR_COLUMNS)
    .eq("id", competitorId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * Localiza concorrente já existente pelo "anúncio concorrente" dentro do produto,
 * priorizando o ativo. Suporta o caminho de reativação sem violar o unique parcial.
 */
export async function findCompetitorByListing(supabase, userId, { marketplace, productId, competitorListingId, monitoredListingId = null }) {
  let query = supabase
    .from("competition_competitors")
    .select(COMPETITOR_COLUMNS)
    .eq("user_id", userId)
    .eq("marketplace", marketplace)
    .eq("competitor_listing_id", competitorListingId);

  if (monitoredListingId) {
    query = query.eq("monitored_listing_id", monitoredListingId);
  } else {
    query = query.eq("product_id", productId);
  }

  const { data, error } = await query
    .order("is_active", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return Array.isArray(data) && data.length ? data[0] : null;
}

function listingIdDigits(listingId) {
  const s = listingId != null ? String(listingId).trim().toUpperCase().replace(/-/g, "") : "";
  const m = s.match(/^ML[ABCU](\d{6,})$/);
  return m?.[1] ?? null;
}

/**
 * Dedup: mesmo item_id (variantes MLB/MLB-) ou permalink com os mesmos dígitos MLB.
 */
export async function findCompetitorForProductDedup(
  supabase,
  userId,
  { marketplace, productId, competitorListingId, competitorPermalink, monitoredListingId = null }
) {
  const direct = await findCompetitorByListing(supabase, userId, {
    marketplace,
    productId,
    competitorListingId,
    monitoredListingId,
  });
  if (direct) return direct;

  const digits = listingIdDigits(competitorListingId);
  const permalinkDigits =
    competitorPermalink != null
      ? String(competitorPermalink).match(/ML[ABCU]-?(\d{6,})/i)?.[1] ?? null
      : null;
  const matchDigits = digits || permalinkDigits;
  if (!matchDigits) return null;

  let query = supabase
    .from("competition_competitors")
    .select(COMPETITOR_COLUMNS)
    .eq("user_id", userId)
    .eq("marketplace", marketplace);

  if (monitoredListingId) {
    query = query.eq("monitored_listing_id", monitoredListingId);
  } else {
    query = query.eq("product_id", productId);
  }

  const { data, error } = await query
    .order("is_active", { ascending: false })
    .order("updated_at", { ascending: false });
  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  return (
    rows.find((r) => {
      if (listingIdDigits(r.competitor_listing_id) === matchDigits) return true;
      const pl = String(r.competitor_permalink || "");
      return pl.includes(matchDigits);
    }) ?? null
  );
}

/** Insere novo concorrente (trigger do banco impõe limite de 9 ativos). */
export async function insertCompetitor(supabase, row) {
  const { data, error } = await supabase
    .from("competition_competitors")
    .insert(row)
    .select(COMPETITOR_COLUMNS)
    .single();
  if (error) throw error;
  return data;
}

/** Atualiza concorrente do dono (usado na reativação e no merge de dados principais). */
export async function updateCompetitor(supabase, userId, competitorId, patch) {
  const { data, error } = await supabase
    .from("competition_competitors")
    .update(patch)
    .eq("id", competitorId)
    .eq("user_id", userId)
    .select(COMPETITOR_COLUMNS)
    .single();
  if (error) throw error;
  return data;
}

/** Soft-delete: is_active = false. Nunca apaga fisicamente (preserva snapshots). */
export async function deactivateCompetitor(supabase, userId, competitorId) {
  const { data, error } = await supabase
    .from("competition_competitors")
    .update({ is_active: false })
    .eq("id", competitorId)
    .eq("user_id", userId)
    .select(COMPETITOR_COLUMNS)
    .single();
  if (error) throw error;
  return data;
}

/**
 * Insere snapshots de concorrência (append-only). NUNCA atualiza/apaga histórico.
 * Recebe linhas já normalizadas (preço como string numeric-safe).
 */
/** Metadados do snapshot mais recente por concorrente (vendas, frete, tipo, reputação). */
const SNAPSHOT_META_COLUMNS =
  "competitor_id, sales_hint, shipping, listing_type, reputation, competitor_thumbnail, competitor_store_name, competitor_price, competitor_title, captured_at";

export async function findLatestSnapshotMetaForCompetitors(supabase, userId, competitorIds) {
  const ids = Array.isArray(competitorIds) ? competitorIds.filter(Boolean) : [];
  if (ids.length === 0) return new Map();
  let data = null;
  let error = null;
  ({ data, error } = await supabase
    .from("competition_snapshots")
    .select(`${SNAPSHOT_META_COLUMNS}, raw_snapshot`)
    .eq("user_id", userId)
    .in("competitor_id", ids)
    .order("captured_at", { ascending: false }));
  if (error) {
    console.warn("[competition] snapshot meta com raw_snapshot falhou; fallback sem galeria", {
      message: error.message,
      code: error.code,
    });
    ({ data, error } = await supabase
      .from("competition_snapshots")
      .select(SNAPSHOT_META_COLUMNS)
      .eq("user_id", userId)
      .in("competitor_id", ids)
      .order("captured_at", { ascending: false }));
  }
  if (error) throw error;
  const map = new Map();
  for (const row of data || []) {
    if (!row?.competitor_id || map.has(row.competitor_id)) continue;
    let salesHint = null;
    if (row.sales_hint != null && Number.isFinite(Number(row.sales_hint)) && Number(row.sales_hint) > 0) {
      salesHint = Math.trunc(Number(row.sales_hint));
    }
    map.set(row.competitor_id, {
      sales_hint: salesHint,
      shipping: row.shipping ?? null,
      listing_type: row.listing_type ?? null,
      reputation: row.reputation ?? null,
      competitor_thumbnail: row.competitor_thumbnail ?? null,
      competitor_store_name: row.competitor_store_name ?? null,
      competitor_price: row.competitor_price != null ? String(row.competitor_price) : null,
      competitor_title: row.competitor_title ?? null,
      captured_at: row.captured_at ?? null,
      listing_status:
        row.raw_snapshot &&
        typeof row.raw_snapshot === "object" &&
        row.raw_snapshot.listing_status != null
          ? String(row.raw_snapshot.listing_status).trim()
          : null,
      competitor_pictures:
        row.raw_snapshot &&
        typeof row.raw_snapshot === "object" &&
        Array.isArray(row.raw_snapshot.competitor_pictures)
          ? row.raw_snapshot.competitor_pictures
          : null,
    });
  }
  return map;
}

/** @deprecated use findLatestSnapshotMetaForCompetitors */
export async function findLatestSalesHintsForCompetitors(supabase, userId, competitorIds) {
  const meta = await findLatestSnapshotMetaForCompetitors(supabase, userId, competitorIds);
  const map = new Map();
  for (const [id, v] of meta.entries()) {
    if (v?.sales_hint != null) map.set(id, v.sales_hint);
  }
  return map;
}

export async function insertSnapshots(supabase, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const { data, error } = await supabase
    .from("competition_snapshots")
    .insert(rows)
    .select("id, competitor_id, competitor_listing_id, competitor_price, currency, sales_hint, captured_at");
  if (error) throw error;
  return data || [];
}

const SNAPSHOT_DIFF_COLUMNS =
  "competitor_id, competitor_price, currency, competitor_thumbnail, competitor_permalink, competitor_title, " +
  "shipping, listing_type, reputation, sales_hint, raw_snapshot, captured_at";

/** Snapshot mais recente por concorrente (inclui raw_snapshot para diff da rotina diária). */
export async function findLatestSnapshotRowsForCompetitors(supabase, userId, competitorIds) {
  const ids = Array.isArray(competitorIds) ? competitorIds.filter(Boolean) : [];
  const map = new Map();
  if (ids.length === 0) return map;

  const { data, error } = await supabase
    .from("competition_snapshots")
    .select(SNAPSHOT_DIFF_COLUMNS)
    .eq("user_id", userId)
    .in("competitor_id", ids)
    .order("captured_at", { ascending: false });
  if (error) throw error;

  for (const row of data || []) {
    if (!row?.competitor_id || map.has(row.competitor_id)) continue;
    map.set(row.competitor_id, row);
  }
  return map;
}

/**
 * Concorrentes ativos ainda não atualizados no dia civil BRT (rotina diária).
 * Ordem: quem nunca foi capturado ou está mais defasado primeiro.
 */
export async function listActiveCompetitorsDueForDailyRefresh(supabase, { dayStartIso, limit = 25 }) {
  const cutoff = dayStartIso != null ? String(dayStartIso).trim() : "";
  if (!cutoff) throw new Error("dayStartIso obrigatório");

  const safeLimit = Math.min(Math.max(Math.trunc(Number(limit) || 25), 1), 500);

  const { data, error } = await supabase
    .from("competition_competitors")
    .select(COMPETITOR_COLUMNS)
    .eq("is_active", true)
    .or(`last_captured_at.is.null,last_captured_at.lt.${cutoff}`)
    .order("last_captured_at", { ascending: true, nullsFirst: true })
    .order("id", { ascending: true })
    .limit(safeLimit);
  if (error) throw error;
  return data || [];
}

/** Quantos concorrentes ativos ainda faltam atualizar no dia civil BRT. */
export async function countActiveCompetitorsDueForDailyRefresh(supabase, dayStartIso) {
  const cutoff = dayStartIso != null ? String(dayStartIso).trim() : "";
  if (!cutoff) throw new Error("dayStartIso obrigatório");

  const { count, error } = await supabase
    .from("competition_competitors")
    .select("id", { count: "exact", head: true })
    .eq("is_active", true)
    .or(`last_captured_at.is.null,last_captured_at.lt.${cutoff}`);
  if (error) throw error;
  return typeof count === "number" ? count : 0;
}

/** Total de concorrentes ativos (base para skipped_today). */
export async function countActiveCompetitorsTotal(supabase) {
  const { count, error } = await supabase
    .from("competition_competitors")
    .select("id", { count: "exact", head: true })
    .eq("is_active", true);
  if (error) throw error;
  return typeof count === "number" ? count : 0;
}
