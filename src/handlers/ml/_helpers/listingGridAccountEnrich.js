// ======================================================
// Enriquecimento de conta na grid GET /api/ml/listings
// Mesma fonte de resolução que /api/sales (Vendas).
// ======================================================

import {
  externalListingIdKeyVariants,
  listingGridJoinKey,
  normalizeMarketplaceSlug,
} from "./listingGridJoinKeys.js";
import { ML_MARKETPLACE_SLUG } from "./mlMarketplace.js";

export const MARKETPLACE_ACCOUNT_FALLBACK_LABEL = "Conta Mercado Livre";

/** @type {readonly string[]} */
const MARKETPLACE_ACCOUNT_SELECT_VARIANTS = [
  "id,user_id,account_alias,ml_nickname,external_seller_id,seller_company_id,logo_url,avatar_url",
  "id,user_id,account_alias,ml_nickname,external_seller_id,seller_company_id",
  "id,user_id,account_alias,ml_nickname,external_seller_id",
  "id,user_id,account_alias,ml_nickname",
  "id,user_id,account_alias",
  "id,user_id",
];

/**
 * @param {unknown} error
 */
function isShapeError(error) {
  return (
    String(error?.code ?? "") === "42703" ||
    String(error?.message ?? "").toLowerCase().includes("column") ||
    String(error?.message ?? "").toLowerCase().includes("schema cache")
  );
}

/**
 * @param {unknown} id
 */
export function normalizeMarketplaceAccountId(id) {
  const s = String(id ?? "").trim();
  return s ? s.toLowerCase() : "";
}

/**
 * @param {Record<string, unknown> | null | undefined} accountRow
 * @param {{ allowFallback?: boolean }} [opts]
 * @returns {string | null}
 */
export function resolveMarketplaceAccountDisplayName(accountRow, opts = {}) {
  const allowFallback = opts.allowFallback !== false;
  if (!accountRow || typeof accountRow !== "object") {
    return allowFallback ? MARKETPLACE_ACCOUNT_FALLBACK_LABEL : null;
  }

  const pick = (key) => {
    const v = accountRow[key];
    return v != null && String(v).trim() !== "" ? String(v).trim() : null;
  };

  const fromFields =
    pick("account_alias") ??
    pick("alias") ??
    pick("name") ??
    pick("account_name") ??
    pick("official_name") ??
    pick("ml_nickname") ??
    pick("nickname") ??
    pick("company_trade_name") ??
    pick("trade_name") ??
    pick("company_name");

  if (fromFields) return fromFields;

  const mlUser = pick("ml_user_id") ?? pick("external_seller_id");
  if (mlUser) return `ML ${mlUser}`;

  return allowFallback ? MARKETPLACE_ACCOUNT_FALLBACK_LABEL : null;
}

/**
 * @param {Record<string, unknown> | null | undefined} accountRow
 * @returns {{ alias: string; logoUrl: string | null; userId: string | null }}
 */
export function marketplaceAccountMetaFromRow(accountRow) {
  const alias = resolveMarketplaceAccountDisplayName(accountRow, { allowFallback: true });
  const pickUrl = (key) => {
    const v = accountRow?.[key];
    return v != null && String(v).trim() !== "" ? String(v).trim() : null;
  };
  return {
    alias: alias ?? MARKETPLACE_ACCOUNT_FALLBACK_LABEL,
    logoUrl:
      pickUrl("account_logo_url") ??
      pickUrl("logo_url") ??
      pickUrl("avatar_url") ??
      pickUrl("ml_picture_url") ??
      null,
    userId:
      accountRow?.user_id != null && String(accountRow.user_id).trim() !== ""
        ? String(accountRow.user_id).trim()
        : null,
  };
}

/**
 * @type {Map<string, { alias: string; logoUrl: string | null; userId: string | null }>}
 */
export function createEmptyAccountMetaMap() {
  return new Map();
}

/**
 * @param {Map<string, { alias: string; logoUrl: string | null; userId: string | null }>} map
 * @param {unknown} accountId
 * @param {{ alias: string; logoUrl: string | null; userId: string | null }} meta
 */
function putAccountMeta(map, accountId, meta) {
  const key = normalizeMarketplaceAccountId(accountId);
  if (!key) return;
  map.set(key, meta);
}

/**
 * @param {Map<string, { alias: string; logoUrl: string | null; userId: string | null }>} map
 * @param {unknown} accountId
 */
function getAccountMeta(map, accountId) {
  const key = normalizeMarketplaceAccountId(accountId);
  return key ? map.get(key) : undefined;
}

/**
 * Carrega todas as contas do usuário (select tolerante a schema DEV).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 */
export async function loadMarketplaceAccountMetaMap(supabase, userId) {
  const map = createEmptyAccountMetaMap();
  for (const selectExpr of MARKETPLACE_ACCOUNT_SELECT_VARIANTS) {
    const { data, error } = await supabase
      .from("marketplace_accounts")
      .select(selectExpr)
      .eq("user_id", userId);
    if (!error) {
      for (const ar of data || []) {
        const id = ar?.id != null ? String(ar.id).trim() : "";
        if (!id) continue;
        putAccountMeta(map, id, marketplaceAccountMetaFromRow(/** @type {Record<string, unknown>} */ (ar)));
      }
      return map;
    }
    if (!isShapeError(error)) {
      console.error("[Suse7][API][ml-listings] marketplace_accounts_load_failed", {
        message: error.message,
        code: error.code,
        selectExpr,
      });
      return map;
    }
  }
  console.error("[Suse7][API][ml-listings] marketplace_accounts_load_failed_all_variants", {
    userId,
  });
  return map;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string[]} accountIds
 * @param {Map<string, { alias: string; logoUrl: string | null; userId: string | null }>} accountById
 */
export async function hydrateMarketplaceAccountMetaByIds(supabase, userId, accountIds, accountById) {
  const missing = [
    ...new Set(
      (accountIds || [])
        .map((id) => normalizeMarketplaceAccountId(id))
        .filter((id) => id && !accountById.has(id))
    ),
  ];
  if (missing.length === 0) return;

  const CHUNK = 150;
  for (let i = 0; i < missing.length; i += CHUNK) {
    const chunk = missing.slice(i, i + CHUNK);
    /** @type {Record<string, unknown>[] | null} */
    let rows = null;
    let lastError = null;

    for (const selectExpr of MARKETPLACE_ACCOUNT_SELECT_VARIANTS) {
      const { data, error } = await supabase
        .from("marketplace_accounts")
        .select(selectExpr)
        .eq("user_id", userId)
        .in("id", chunk);
      if (!error) {
        rows = data ?? [];
        lastError = null;
        break;
      }
      lastError = error;
      if (!isShapeError(error)) break;
    }

    if (lastError && !rows) {
      console.error("[Suse7][API][ml-listings] marketplace_accounts_missing_ids_failed", {
        message: lastError.message,
        code: lastError.code,
        count: chunk.length,
      });
      continue;
    }

    const found = new Set();
    for (const ar of rows || []) {
      const id = ar?.id != null ? String(ar.id).trim() : "";
      if (!id) continue;
      found.add(normalizeMarketplaceAccountId(id));
      const rowUserId =
        ar?.user_id != null && String(ar.user_id).trim() !== "" ? String(ar.user_id).trim() : null;
      if (rowUserId && rowUserId !== userId) {
        console.warn("[Suse7][API][ml-listings] marketplace_account_wrong_user", {
          marketplace_account_id: id,
          account_user_id: rowUserId,
          request_user_id: userId,
        });
        continue;
      }
      putAccountMeta(accountById, id, marketplaceAccountMetaFromRow(/** @type {Record<string, unknown>} */ (ar)));
    }

    for (const id of chunk) {
      if (!found.has(id)) {
        console.warn("[Suse7][API][ml-listings] marketplace_account_not_found", {
          marketplace_account_id: id,
          request_user_id: userId,
        });
        putAccountMeta(accountById, id, {
          alias: MARKETPLACE_ACCOUNT_FALLBACK_LABEL,
          logoUrl: null,
          userId: null,
        });
      }
    }
  }
}

/**
 * Resolve nome pelo ID — nunca retorna null se accountId existir.
 * @param {string | null | undefined} accountId
 * @param {Map<string, { alias: string; logoUrl: string | null; userId: string | null }>} accountById
 */
export function resolveMarketplaceAccountDisplayNameById(accountId, accountById) {
  const id = normalizeMarketplaceAccountId(accountId);
  if (!id) return null;
  const meta = getAccountMeta(accountById, id);
  if (meta?.alias) return meta.alias;
  return MARKETPLACE_ACCOUNT_FALLBACK_LABEL;
}

/**
 * @param {Map<string, string | null> | undefined} map
 * @param {unknown} marketplace
 * @param {unknown} externalListingId
 * @returns {string | null}
 */
function lookupStringByListingKey(map, marketplace, externalListingId) {
  if (!map || typeof map.get !== "function") return null;
  const primary = normalizeMarketplaceSlug(marketplace);
  const mkTry = primary === ML_MARKETPLACE_SLUG ? [primary] : [primary, ML_MARKETPLACE_SLUG];
  for (const mkt of mkTry) {
    for (const v of externalListingIdKeyVariants(externalListingId)) {
      const hit = map.get(listingGridJoinKey(mkt, v));
      if (hit != null && String(hit).trim() !== "") return String(hit).trim();
    }
  }
  return null;
}

/**
 * @param {Record<string, unknown>} row
 * @param {Record<string, unknown> | null | undefined} listing
 * @param {Map<string, { alias: string; logoUrl: string | null; userId: string | null }>} accountById
 * @param {{
 *   accountIdByListingKey?: Map<string, string>;
 *   accountAliasByListingKey?: Map<string, string | null>;
 * } | null | undefined} [orderMaps]
 */
export function applyAccountFieldsToGridRow(row, listing, accountById, orderMaps = null) {
  const listingRef = listing && typeof listing === "object" ? listing : null;
  let accountId =
    row.marketplace_account_id != null && String(row.marketplace_account_id).trim() !== ""
      ? String(row.marketplace_account_id).trim()
      : listingRef?.marketplace_account_id != null && String(listingRef.marketplace_account_id).trim() !== ""
        ? String(listingRef.marketplace_account_id).trim()
        : null;

  if (!accountId && orderMaps?.accountIdByListingKey) {
    const fromVotes = lookupStringByListingKey(
      orderMaps.accountIdByListingKey,
      row.marketplace ?? listingRef?.marketplace,
      row.external_listing_id ?? listingRef?.external_listing_id
    );
    if (fromVotes) accountId = fromVotes;
  }

  if (accountId) row.marketplace_account_id = accountId;

  let displayName = null;
  if (accountId) {
    displayName = resolveMarketplaceAccountDisplayNameById(accountId, accountById);
  }
  if (!displayName && listingRef?.joined_account_alias != null) {
    displayName = String(listingRef.joined_account_alias).trim() || null;
  }
  if (
    !displayName &&
    row.account_alias != null &&
    String(row.account_alias).trim() !== ""
  ) {
    displayName = String(row.account_alias).trim();
  }
  if (!displayName && orderMaps?.accountAliasByListingKey) {
    const fromOrderItems = lookupStringByListingKey(
      orderMaps.accountAliasByListingKey,
      row.marketplace ?? listingRef?.marketplace,
      row.external_listing_id ?? listingRef?.external_listing_id
    );
    if (fromOrderItems) displayName = fromOrderItems;
  }

  if (accountId && !displayName) {
    displayName = MARKETPLACE_ACCOUNT_FALLBACK_LABEL;
  }

  if (displayName) {
    row.account_alias = displayName;
    row.ml_account_alias = displayName;
  }

  const meta = accountId ? getAccountMeta(accountById, accountId) : null;
  if (meta?.logoUrl) {
    row.account_logo_url = meta.logoUrl;
  }

  if (row.product_card_metrics != null && typeof row.product_card_metrics === "object") {
    const pcm = /** @type {Record<string, unknown>} */ (row.product_card_metrics);
    if (displayName) pcm.accountDisplayName = displayName;
  }
}

/** @deprecated use hydrateMarketplaceAccountMetaByIds */
export async function ensureAccountsInMap(supabase, userId, accountIds, accountById) {
  await hydrateMarketplaceAccountMetaByIds(supabase, userId, accountIds, accountById);
}

/**
 * @param {Record<string, unknown>[]} gridRows
 * @param {Record<string, unknown>[]} listings
 * @param {Map<string, { alias: string; logoUrl: string | null; userId: string | null }>} accountById
 * @param {{
 *   accountIdByListingKey?: Map<string, string>;
 *   accountAliasByListingKey?: Map<string, string | null>;
 * } | null | undefined} [orderMaps]
 */
export function applyAccountFieldsToAllGridRows(gridRows, listings, accountById, orderMaps = null) {
  if (!Array.isArray(gridRows)) return;
  for (let i = 0; i < gridRows.length; i++) {
    const row = gridRows[i];
    if (!row || typeof row !== "object") continue;
    const listing =
      Array.isArray(listings) && listings[i] && typeof listings[i] === "object"
        ? /** @type {Record<string, unknown>} */ (listings[i])
        : null;
    applyAccountFieldsToGridRow(
      /** @type {Record<string, unknown>} */ (row),
      listing,
      accountById,
      orderMaps
    );
  }
}

/**
 * Última etapa antes do JSON — hidrata IDs faltantes e aplica alias nos campos finais.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown>[]} gridRows
 * @param {Record<string, unknown>[]} listings
 * @param {Map<string, { alias: string; logoUrl: string | null; userId: string | null }>} accountById
 * @param {{
 *   accountIdByListingKey?: Map<string, string>;
 *   accountAliasByListingKey?: Map<string, string | null>;
 * } | null | undefined} [orderMaps]
 */
export async function finalizeListingGridAccountFields(
  supabase,
  userId,
  gridRows,
  listings,
  accountById,
  orderMaps = null
) {
  const ids = [
    ...new Set(
      (gridRows || [])
        .map((r) =>
          r?.marketplace_account_id != null && String(r.marketplace_account_id).trim() !== ""
            ? String(r.marketplace_account_id).trim()
            : ""
        )
        .filter(Boolean)
    ),
  ];

  await hydrateMarketplaceAccountMetaByIds(supabase, userId, ids, accountById);
  applyAccountFieldsToAllGridRows(gridRows, listings, accountById, orderMaps);

  for (const row of gridRows || []) {
    if (!row || typeof row !== "object") continue;
    const accountId =
      row.marketplace_account_id != null && String(row.marketplace_account_id).trim() !== ""
        ? String(row.marketplace_account_id).trim()
        : null;
    if (!accountId) continue;

    const alias =
      row.account_alias != null && String(row.account_alias).trim() !== ""
        ? String(row.account_alias).trim()
        : null;
    const pcm =
      row.product_card_metrics != null && typeof row.product_card_metrics === "object"
        ? /** @type {Record<string, unknown>} */ (row.product_card_metrics)
        : null;
    const pcmAlias =
      pcm?.accountDisplayName != null && String(pcm.accountDisplayName).trim() !== ""
        ? String(pcm.accountDisplayName).trim()
        : null;

    if (!alias || !pcmAlias) {
      const meta = getAccountMeta(accountById, accountId);
      console.warn("[Suse7][API][ml-listings] account_display_name_unresolved", {
        external_listing_id: row.external_listing_id ?? null,
        marketplace_account_id: accountId,
        reason: !meta
          ? "account_id_not_in_map_after_hydrate"
          : meta.alias === MARKETPLACE_ACCOUNT_FALLBACK_LABEL
            ? "account_row_without_name_fields_using_fallback"
            : "apply_account_fields_incomplete",
        account_in_map: Boolean(meta),
        resolved_alias: meta?.alias ?? null,
      });
      const forced = resolveMarketplaceAccountDisplayNameById(accountId, accountById);
      row.account_alias = forced;
      row.ml_account_alias = forced;
      if (pcm) pcm.accountDisplayName = forced;
      else if (row.product_card_metrics == null) {
        row.product_card_metrics = { accountDisplayName: forced };
      }
    }
  }
}
