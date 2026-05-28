// ======================================================
// Dev Center — Sellers operacional (Fase 1)
// Agrega profiles, empresas, marketplaces, billing e métricas.
// Listas: dados mascarados (LGPD). Detalhe: mesma política.
// ======================================================

import {
  buildMlConnectionUiPack,
  fetchMlTokenProbeForMlSeller,
  fetchMlTokenProbeForUser,
} from "../../services/marketplace/marketplaceAccountConnectionHealth.js";
import { buildDevCenterSellerSubscriptionUsageBlock } from "./devCenterSellerSubscriptionUsageHelper.js";
import { DEV_CENTER_TOOLBOX_METADATA_KEYS } from "./devCenterToolboxOperationalConstants.js";

/** @param {string | null | undefined} email */
export function maskEmailForApi(email) {
  const s = String(email ?? "").trim().toLowerCase();
  if (!s || !s.includes("@")) return null;
  const [box, dom] = s.split("@");
  if (!dom) return "•••";
  const ob = box.length <= 2 ? `${box.slice(0, 1)}•` : `${box.slice(0, 2)}•••${box.slice(-1)}`;
  return `${ob}@${dom}`;
}

/** @param {string | null | undefined} phone */
export function maskPhoneForApi(phone) {
  const d = String(phone ?? "").replace(/\D/g, "");
  if (d.length <= 4) return d ? "****" : null;
  return `${d.slice(0, 2)}••••${d.slice(-2)}`;
}

/** @param {string | null | undefined} doc */
export function maskDocumentForApi(doc) {
  const d = String(doc ?? "").replace(/\D/g, "");
  if (d.length < 4) return d ? "****" : null;
  return `••••${d.slice(-4)}`;
}

/** @param {string | null | undefined} planKey */
export function formatPlanLabel(planKey) {
  const k = String(planKey ?? "").trim();
  if (!k) return "—";
  return k
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * @param {Record<string, unknown> | null | undefined} sub
 */
export function pickPrimarySubscription(sub) {
  if (!sub || typeof sub !== "object") return null;
  return sub;
}

/**
 * @param {Record<string, unknown>[]} subs
 */
export function resolvePrimarySubscriptionForUser(subs) {
  const list = Array.isArray(subs) ? subs : [];
  const rank = (s) => {
    const st = String(s?.status ?? "").toLowerCase();
    if (st === "active") return 0;
    if (st === "internal_free") return 1;
    if (st === "past_due") return 2;
    if (st === "pending") return 3;
    return 4;
  };
  const sorted = [...list].sort((a, b) => {
    const dr = rank(a) - rank(b);
    if (dr !== 0) return dr;
    const ta = a?.updated_at ? new Date(String(a.updated_at)).getTime() : 0;
    const tb = b?.updated_at ? new Date(String(b.updated_at)).getTime() : 0;
    return tb - ta;
  });
  return sorted[0] ?? null;
}

/**
 * @param {{
 *   subscription?: Record<string, unknown> | null;
 *   accounts?: Record<string, unknown>[];
 *   lastLogin?: string | null;
 *   connectedCount?: number;
 * }} input
 * @returns {"saudavel"|"atencao"|"critico"}
 */
export function computeOperationalHealth(input) {
  const sub = input.subscription;
  const accounts = Array.isArray(input.accounts) ? input.accounts : [];
  const subStatus = sub?.status != null ? String(sub.status).toLowerCase() : "";
  const meta = sub?.metadata && typeof sub.metadata === "object" ? sub.metadata : {};
  const delinquency = meta.delinquency_status != null ? String(meta.delinquency_status).toLowerCase() : "none";
  const renewalStatus =
    meta.renewal_subscription_status != null ? String(meta.renewal_subscription_status).toUpperCase() : "";

  if (subStatus === "canceled" || delinquency === "suspended" || renewalStatus === "SUSPENDED") {
    return "critico";
  }

  const connected = (input.connectedCount ?? 0) > 0;
  if (!connected && accounts.length === 0) return "atencao";

  const tokenIssues = accounts.some((a) => {
    const health = a?.connection_health != null ? String(a.connection_health) : "";
    if (health && health !== "connected" && health !== "syncing") return true;
    const exp = a?.token_expires_at;
    if (exp && new Date(String(exp)).getTime() < Date.now()) return true;
    return false;
  });

  if (subStatus === "past_due" || delinquency === "grace" || renewalStatus === "GRACE_PERIOD" || tokenIssues) {
    return "atencao";
  }

  if (input.lastLogin) {
    const days = (Date.now() - new Date(String(input.lastLogin)).getTime()) / 86400000;
    if (days > 90) return "atencao";
  }

  if (!connected) return "atencao";
  return "saudavel";
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} traceId
 */
async function safeSelectAll(supabase, table, select, traceId) {
  const { data, error } = await supabase.from(table).select(select);
  if (error) {
    console.warn("[dev-center-sellers] select_failed", { table, message: error.message, traceId });
    return [];
  }
  return Array.isArray(data) ? data : [];
}

/**
 * @param {unknown[]} rows
 * @param {string} key
 */
function countByKey(rows, key) {
  /** @type {Map<string, number>} */
  const map = new Map();
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const id = r[key] != null ? String(r[key]) : "";
    if (!id) continue;
    map.set(id, (map.get(id) ?? 0) + 1);
  }
  return map;
}

/**
 * @param {Record<string, unknown> | null | undefined} sub
 */
function subscriptionFlags(sub) {
  const meta = sub?.metadata && typeof sub.metadata === "object" ? sub.metadata : {};
  const delinquency = meta.delinquency_status != null ? String(meta.delinquency_status).toLowerCase() : "none";
  const renewalStatus =
    meta.renewal_subscription_status != null ? String(meta.renewal_subscription_status).toUpperCase() : "";
  const status = sub?.status != null ? String(sub.status).toLowerCase() : "";
  return {
    in_trial: status === "pending" && Boolean(meta.trial_ends_at),
    in_grace: delinquency === "grace" || renewalStatus === "GRACE_PERIOD",
    is_past_due: status === "past_due",
    is_suspended: delinquency === "suspended" || renewalStatus === "SUSPENDED",
    grace_period_ends_at: meta.grace_period_ends_at ?? null,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} traceId
 */
export async function buildDevCenterSellersList(supabase, traceId) {
  const profileSelectVariants = [
    "id, email, nome_loja, nome, cpf_cnpj, telefone, whatsapp, photo_url, created_at, last_login",
    "id, email, nome_loja, cpf_cnpj, created_at, last_login",
  ];

  let profiles = [];
  for (const sel of profileSelectVariants) {
    const { data, error } = await supabase
      .from("profiles")
      .select(sel)
      .order("created_at", { ascending: false })
      .limit(400);
    if (!error) {
      profiles = Array.isArray(data) ? data : [];
      break;
    }
  }


  const [accounts, companies, subscriptions, listingRows, salesRows] = await Promise.all([
    safeSelectAll(
      supabase,
      "marketplace_accounts",
      "user_id, status, marketplace, token_expires_at, ml_sales_last_sync_at",
      traceId,
    ),
    safeSelectAll(supabase, "seller_companies", "user_id, id, company_name, trade_name, document_cnpj", traceId),
    safeSelectAll(
      supabase,
      "billing_subscriptions",
      "user_id, status, plan_key, plan_id, metadata, updated_at, created_at",
      traceId,
    ),
    safeSelectAll(supabase, "marketplace_listings", "user_id", traceId),
    safeSelectAll(supabase, "sales_orders", "user_id, order_date, created_at", traceId),
  ]);

  const accountsByUser = new Map();
  for (const a of accounts) {
    const uid = a.user_id != null ? String(a.user_id) : "";
    if (!uid) continue;
    if (!accountsByUser.has(uid)) accountsByUser.set(uid, []);
    accountsByUser.get(uid).push(a);
  }

  const companiesByUser = countByKey(companies, "user_id");
  const listingsByUser = countByKey(listingRows, "user_id");

  /** @type {Map<string, { total: number; recent30: number }>} */
  const salesByUser = new Map();
  const cutoff30 = Date.now() - 30 * 86400000;
  for (const s of salesRows) {
    const uid = s.user_id != null ? String(s.user_id) : "";
    if (!uid) continue;
    const cur = salesByUser.get(uid) ?? { total: 0, recent30: 0 };
    cur.total += 1;
    const when = s.order_date ?? s.created_at;
    if (when && new Date(String(when)).getTime() >= cutoff30) cur.recent30 += 1;
    salesByUser.set(uid, cur);
  }

  /** @type {Map<string, Record<string, unknown>[]>} */
  const subsByUser = new Map();
  for (const sub of subscriptions) {
    const uid = sub.user_id != null ? String(sub.user_id) : "";
    if (!uid) continue;
    if (!subsByUser.has(uid)) subsByUser.set(uid, []);
    subsByUser.get(uid).push(sub);
  }

  return profiles.map((p) => {
    const uid = String(p.id);
    const userAccounts = accountsByUser.get(uid) ?? [];
    const connectedCount = userAccounts.filter((a) => {
      const st = String(a.status ?? "").toLowerCase();
      return st === "active" || st === "connected" || st === "ok" || st === "";
    }).length;

    const primarySub = resolvePrimarySubscriptionForUser(subsByUser.get(uid) ?? []);
    const flags = subscriptionFlags(primarySub);
    const sales = salesByUser.get(uid) ?? { total: 0, recent30: 0 };

    const integrationActive = connectedCount > 0;
    let integrationStatus = "sem_integracao";
    if (integrationActive) {
      const expired = userAccounts.some(
        (a) => a.token_expires_at && new Date(String(a.token_expires_at)).getTime() < Date.now(),
      );
      integrationStatus = expired ? "atencao" : "ativa";
    }

    const health = computeOperationalHealth({
      subscription: primarySub,
      accounts: userAccounts,
      lastLogin: p.last_login ?? null,
      connectedCount,
    });

    const marketplaces = [...new Set(userAccounts.map((a) => String(a.marketplace || "mercado_livre")))];

    return {
      id: uid,
      nome: p.nome_loja ?? p.nome ?? p.email ?? "—",
      email: maskEmailForApi(p.email) ?? "—",
      telefone: maskPhoneForApi(p.telefone ?? p.whatsapp) ?? null,
      photo_url: p.photo_url ?? null,
      cnpj: p.cpf_cnpj != null ? maskDocumentForApi(String(p.cpf_cnpj).replace(/\D/g, "")) : null,
      plano: formatPlanLabel(primarySub?.plan_key ?? primarySub?.plan_id),
      plan_key: primarySub?.plan_key ?? null,
      subscription_status: primarySub?.status ?? null,
      in_trial: flags.in_trial,
      in_grace: flags.in_grace,
      is_past_due: flags.is_past_due,
      status: integrationActive ? "ativo" : "sem integração",
      integration_status: integrationStatus,
      operational_health: health,
      created_at: p.created_at ?? null,
      last_access_at: p.last_login ?? null,
      connected_accounts: connectedCount,
      companies_count: companiesByUser.get(uid) ?? 0,
      marketplaces,
      listings_count: listingsByUser.get(uid) ?? 0,
      sales_count: sales.total,
      sales_recent_30d: sales.recent30,
    };
  });
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {string} traceId
 */
export async function buildDevCenterSellerDetail(supabase, sellerId, traceId) {
  const profileSelectVariants = [
    "id, email, nome_loja, nome, cpf_cnpj, telefone, whatsapp, photo_url, created_at, last_login",
    "id, email, nome_loja, cpf_cnpj, created_at, last_login",
  ];

  let profile = null;
  for (const sel of profileSelectVariants) {
    const { data, error } = await supabase.from("profiles").select(sel).eq("id", sellerId).maybeSingle();
    if (!error && data) {
      profile = data;
      break;
    }
  }
  if (!profile) return null;

  const [{ data: companies }, { data: accountsRaw }, { data: subs }] = await Promise.all([
    supabase
      .from("seller_companies")
      .select("id, company_name, trade_name, document_cnpj, created_at")
      .eq("user_id", sellerId)
      .order("created_at", { ascending: true }),
    supabase
      .from("marketplace_accounts")
      .select(
        "id, marketplace, seller_company_id, external_seller_id, status, ml_nickname, account_alias, token_expires_at, ml_sales_last_sync_at, created_at",
      )
      .eq("user_id", sellerId)
      .order("created_at", { ascending: false }),
    supabase
      .from("billing_subscriptions")
      .select("id, status, plan_key, plan_id, metadata, current_period_end, created_at, updated_at")
      .eq("user_id", sellerId)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  const [{ count: listingsCount }, { count: salesCount }, { data: recentSales }] = await Promise.all([
    supabase.from("marketplace_listings").select("id", { count: "exact", head: true }).eq("user_id", sellerId),
    supabase.from("sales_orders").select("id", { count: "exact", head: true }).eq("user_id", sellerId),
    supabase
      .from("sales_orders")
      .select("id, order_date, created_at, total_amount, status")
      .eq("user_id", sellerId)
      .order("order_date", { ascending: false, nullsFirst: false })
      .limit(5),
  ]);

  const cutoff30 = Date.now() - 30 * 86400000;
  const { count: salesRecent30 } = await supabase
    .from("sales_orders")
    .select("id", { count: "exact", head: true })
    .eq("user_id", sellerId)
    .gte("order_date", new Date(cutoff30).toISOString());

  const primarySub = resolvePrimarySubscriptionForUser(subs ?? []);
  const flags = subscriptionFlags(primarySub);
  const primarySubMeta =
    primarySub?.metadata && typeof primarySub.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (primarySub.metadata)
      : {};
  const usageBlock = primarySub
    ? await buildDevCenterSellerSubscriptionUsageBlock(supabase, sellerId, primarySub)
    : null;

  const accounts = await Promise.all(
    (accountsRaw ?? []).map(async (row) => {
      const ext = row?.external_seller_id != null ? String(row.external_seller_id).trim() : "";
      const tokenProbe = ext
        ? await fetchMlTokenProbeForMlSeller(supabase, sellerId, String(row.marketplace || "mercado_livre"), ext, String(row.id))
        : await fetchMlTokenProbeForUser(supabase, sellerId, String(row.marketplace || "mercado_livre"));
      const pack = buildMlConnectionUiPack(row, tokenProbe, false);
      return {
        id: String(row.id),
        marketplace: row.marketplace ?? "mercado_livre",
        nickname: row.ml_nickname ?? row.account_alias ?? row.external_seller_id ?? null,
        status: row.status ?? "unknown",
        connection_health: pack.connection_health,
        connection_badge_label: pack.connection_badge_label,
        token_expires_at: row.token_expires_at ?? null,
        last_sync_at: row.ml_sales_last_sync_at ?? null,
        seller_company_id: row.seller_company_id ?? null,
      };
    }),
  );

  const connectedCount = accounts.filter((a) => {
    const st = String(a.status ?? "").toLowerCase();
    return st === "active" || st === "connected" || a.connection_health === "connected";
  }).length;

  const health = computeOperationalHealth({
    subscription: primarySub,
    accounts,
    lastLogin: profile.last_login ?? null,
    connectedCount,
  });

  /** @type {{ id: string; kind: string; label: string; at: string }[]} */
  const recent_events = [];
  if (profile.last_login) {
    recent_events.push({
      id: "evt-login",
      kind: "access",
      label: "Último acesso à plataforma",
      at: String(profile.last_login),
    });
  }
  if (primarySub?.updated_at) {
    recent_events.push({
      id: "evt-sub",
      kind: "billing",
      label: `Assinatura atualizada (${String(primarySub.status ?? "—")})`,
      at: String(primarySub.updated_at),
    });
  }
  for (const acc of accounts) {
    if (acc.last_sync_at) {
      recent_events.push({
        id: `evt-sync-${acc.id}`,
        kind: "sync",
        label: `Sincronização ${acc.marketplace}`,
        at: String(acc.last_sync_at),
      });
    }
  }
  recent_events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return {
    seller: {
      id: sellerId,
      nome: profile.nome_loja ?? profile.nome ?? profile.email ?? "—",
      email: maskEmailForApi(profile.email) ?? "—",
      telefone: maskPhoneForApi(profile.telefone ?? profile.whatsapp) ?? null,
      photo_url: profile.photo_url ?? null,
      created_at: profile.created_at ?? null,
      last_access_at: profile.last_login ?? null,
      operational_health: health,
      status: connectedCount > 0 ? "ativo" : "sem integração",
    },
    identity: {
      document_masked: profile.cpf_cnpj != null ? maskDocumentForApi(String(profile.cpf_cnpj).replace(/\D/g, "")) : null,
      companies_count: (companies ?? []).length,
    },
    companies: (companies ?? []).map((c) => ({
      id: String(c.id),
      company_name: c.company_name ?? null,
      trade_name: c.trade_name ?? null,
      document_masked: c.document_cnpj != null ? maskDocumentForApi(String(c.document_cnpj).replace(/\D/g, "")) : null,
      created_at: c.created_at ?? null,
    })),
    marketplaces: accounts,
    subscription: primarySub
      ? {
          id: String(primarySub.id),
          plan_key: primarySub.plan_key ?? null,
          plan_label: formatPlanLabel(primarySub.plan_key ?? primarySub.plan_id),
          status: primarySub.status ?? null,
          current_period_end: primarySub.current_period_end ?? null,
          trial_ends_at: primarySubMeta[DEV_CENTER_TOOLBOX_METADATA_KEYS.TRIAL_ENDS_AT] ?? null,
          extra_days_total: Number(primarySubMeta[DEV_CENTER_TOOLBOX_METADATA_KEYS.EXTRA_DAYS_TOTAL]) || 0,
          extra_sales_bonus: Number(primarySubMeta[DEV_CENTER_TOOLBOX_METADATA_KEYS.EXTRA_SALES_BONUS]) || 0,
          usage: usageBlock,
          usage_current: usageBlock?.current ?? null,
          usage_limit: usageBlock?.limit ?? null,
          usage_percent: usageBlock?.percent ?? null,
          ...flags,
        }
      : null,
    metrics: {
      listings_count: typeof listingsCount === "number" ? listingsCount : 0,
      sales_count: typeof salesCount === "number" ? salesCount : 0,
      sales_recent_30d: typeof salesRecent30 === "number" ? salesRecent30 : 0,
      connected_accounts: connectedCount,
    },
    recent_sales: (recentSales ?? []).map((s) => ({
      id: String(s.id),
      order_date: s.order_date ?? s.created_at ?? null,
      total_amount: s.total_amount ?? null,
      status: s.status ?? null,
    })),
    recent_events: recent_events.slice(0, 12),
    future_actions: {
      impersonate: { available: false, label: "Entrar como seller" },
      suspend: { available: false, label: "Suspender conta" },
      reset_integration: { available: false, label: "Resetar integração" },
      resend_onboarding: { available: false, label: "Reenviar onboarding" },
    },
  };
}
