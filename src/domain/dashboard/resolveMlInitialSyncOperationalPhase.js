// ======================================================================
// Fase operacional da sincronização inicial ML — account-aware (CPJ-2 T1).
// ======================================================================

import { ML_MARKETPLACE_SLUG } from "../../handlers/ml/_helpers/mlMarketplace.js";
import { ML_LISTINGS_TYPES } from "../../services/marketplace/createMlInitialSyncJobs.js";
import { isEffectiveSyncSuccess } from "../marketplace/isEffectiveSyncSuccess.js";
import { resolveInitialSyncUniverseStable } from "./initialSyncUniverseStable.js";

const PRODUCTS_JOB_TYPE = "ml_initial_products";
const ACTIVE_JOB_STATUSES = new Set(["pending", "queued", "running", "processing"]);

/**
 * @typedef {"none" | "awaiting_start" | "in_progress"} MlInitialSyncPhase
 * @typedef {{
 *   marketplace_account_id: string;
 *   phase: MlInitialSyncPhase;
 *   status: string;
 *   seller_company_id: string | null;
 *   account_label: string | null;
 *   account_avatar_url: string | null;
 *   store_name: string | null;
 *   store_document_cnpj: string | null;
 *   store_logo_url: string | null;
 *   ml_nickname: string | null;
 *   external_seller_id: string | null;
 * }} MlAccountSyncOperationalState
 */

/**
 * Resolve fase por conta (não agrega jobs de contas distintas).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<{
 *   accounts: MlAccountSyncOperationalState[];
 *   phase: MlInitialSyncPhase;
 *   marketplace_account_id: string | null;
 * }>}
 */
export async function resolveMlInitialSyncOperationalPhase(supabase, userId) {
  const uid = String(userId || "").trim();
  if (!uid) {
    return { accounts: [], phase: "none", marketplace_account_id: null };
  }

  const { data: accounts, error: accErr } = await supabase
    .from("marketplace_accounts")
    .select(
      "id, status, marketplace, ml_nickname, account_alias, external_seller_id, seller_company_id, created_at",
    )
    .eq("user_id", uid)
    .eq("marketplace", ML_MARKETPLACE_SLUG)
    .neq("status", "removed")
    .order("created_at", { ascending: true });

  if (accErr) throw accErr;
  const rows = Array.isArray(accounts) ? accounts : [];
  if (!rows.length) {
    return { accounts: [], phase: "none", marketplace_account_id: null };
  }

  const companyIds = [
    ...new Set(
      rows
        .map((r) => (r?.seller_company_id != null ? String(r.seller_company_id).trim() : ""))
        .filter(Boolean),
    ),
  ];
  /** @type {Map<string, { trade_name?: string | null; company_name?: string | null; logo_url?: string | null; document_cnpj?: string | null }>} */
  const companyById = new Map();
  if (companyIds.length) {
    const { data: cos, error: coErr } = await supabase
      .from("seller_companies")
      .select("id, trade_name, company_name, logo_url, document_cnpj")
      .eq("user_id", uid)
      .in("id", companyIds);
    if (coErr) {
      console.warn("[ml/ot] seller_companies lookup failed", {
        code: coErr.code,
        message: coErr.message,
      });
    }
    for (const c of cos ?? []) {
      if (c?.id) companyById.set(String(c.id), c);
    }
  }

  const accountIds = rows.map((r) => String(r.id)).filter(Boolean);
  let jobRows = [];
  const { data: jobs, error: jobErr } = await supabase
    .from("marketplace_account_sync_jobs")
    .select("marketplace_account_id, job_type, status, metadata")
    .in("marketplace_account_id", accountIds);

  if (jobErr) {
    const msg = String(jobErr.message ?? "").toLowerCase();
    if (String(jobErr.code ?? "") !== "42P01" && !msg.includes("does not exist")) {
      throw jobErr;
    }
  } else {
    jobRows = Array.isArray(jobs) ? jobs : [];
  }

  const universe = await resolveInitialSyncUniverseStable(supabase, uid);

  /** @type {MlAccountSyncOperationalState[]} */
  const perAccount = [];

  for (const row of rows) {
    const accountId = String(row?.id ?? "").trim();
    if (!accountId) continue;
    const status = String(row?.status ?? "").trim().toLowerCase() || "unknown";
    const coId = row?.seller_company_id != null ? String(row.seller_company_id).trim() : "";
    const co = coId ? companyById.get(coId) : null;
    const nick = row?.ml_nickname != null ? String(row.ml_nickname).trim() : "";
    const trade = co?.trade_name != null ? String(co.trade_name).trim() : "";
    const cname = co?.company_name != null ? String(co.company_name).trim() : "";
    // Identidade da LOJA = SSOT seller_companies (não nickname/alias da conta ML).
    const storeName = trade || cname || null;
    const storeDoc =
      co?.document_cnpj != null && String(co.document_cnpj).trim() !== ""
        ? String(co.document_cnpj).replace(/\D/g, "")
        : null;
    const storeLogo =
      co?.logo_url != null && String(co.logo_url).trim() !== ""
        ? String(co.logo_url).trim()
        : null;
    // account_label permanece como nome da loja para compat de consumidores existentes.
    const label = storeName;
    const avatar = storeLogo;

    const accountJobs = jobRows.filter((j) => String(j?.marketplace_account_id ?? "") === accountId);

    /** @type {MlInitialSyncPhase} */
    let phase = "none";

    // Conta sem token saudável / reconexão: ainda é pendência operacional se não removed.
    if (status === "invalid" || status === "expired" || status === "error") {
      phase = "awaiting_start";
    } else if (!accountJobs.length) {
      phase = "awaiting_start";
    } else {
      const hasActiveJob = accountJobs.some((j) =>
        ACTIVE_JOB_STATUSES.has(String(j?.status ?? "").trim().toLowerCase()),
      );
      if (hasActiveJob) {
        phase = "in_progress";
      } else if (!universe.stable) {
        // Universo ainda instável, mas jobs desta conta já pararam → tratar como in_progress leve
        // apenas se ainda faltam etapas canônicas desta conta.
        // Maintenance stub (done+skipped) NÃO conta como sucesso real.
        const listingsDone = accountJobs.some(
          (j) => ML_LISTINGS_TYPES.includes(String(j.job_type)) && isEffectiveSyncSuccess(j),
        );
        const productsDone = accountJobs.some(
          (j) => String(j.job_type) === PRODUCTS_JOB_TYPE && isEffectiveSyncSuccess(j),
        );
        phase = !listingsDone || !productsDone ? "in_progress" : "none";
      } else {
        const listingsDone = accountJobs.some(
          (j) => ML_LISTINGS_TYPES.includes(String(j.job_type)) && isEffectiveSyncSuccess(j),
        );
        const productsDone = accountJobs.some(
          (j) => String(j.job_type) === PRODUCTS_JOB_TYPE && isEffectiveSyncSuccess(j),
        );
        // Só stubs de maintenance → awaiting_start (seller precisa rodar sync real).
        phase = !listingsDone || !productsDone ? "awaiting_start" : "none";
      }
    }

    perAccount.push({
      marketplace_account_id: accountId,
      phase,
      status,
      seller_company_id: coId || null,
      account_label: label,
      account_avatar_url: avatar,
      store_name: storeName,
      store_document_cnpj: storeDoc,
      store_logo_url: storeLogo,
      ml_nickname: nick || null,
      external_seller_id:
        row?.external_seller_id != null ? String(row.external_seller_id).trim() : null,
    });
  }

  // Aggregate legado (compat): prioriza in_progress, depois awaiting_start.
  const inProg = perAccount.find((a) => a.phase === "in_progress") ?? null;
  const awaiting = perAccount.find((a) => a.phase === "awaiting_start") ?? null;
  const pick = inProg || awaiting || null;

  return {
    accounts: perAccount,
    phase: pick ? pick.phase : "none",
    marketplace_account_id: pick ? pick.marketplace_account_id : null,
  };
}
