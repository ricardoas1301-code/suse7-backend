// ======================================================================
// Latches pós-OAuth ML — somente após marketplace_account + ml_tokens OK.
// ======================================================================

import { carregarContextoConfiguracaoInicial } from "./carregarContextoConfiguracaoInicial.js";
import {
  resolveConfigurationSnapshot,
  tentarRegistrarConclusaoConfiguracaoInicial,
} from "../domain/resolverSnapshotConfiguracaoInicial.js";

const LOG_PREFIX = "[S7_ONBOARDING_ML_LATCH]";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 */
export async function registrarPrimeiraIntegracaoMarketplaceSeAusente(supabase, userId) {
  const uid = String(userId || "").trim();
  if (!uid) return { updated: false, reason: "INVALID_USER" };

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("profiles")
    .update({ first_marketplace_connected_at: now })
    .eq("id", uid)
    .is("first_marketplace_connected_at", null)
    .select("first_marketplace_connected_at")
    .maybeSingle();

  if (error) {
    console.warn(`${LOG_PREFIX} first_marketplace_failed`, { user_id: uid, message: error.message });
    return { updated: false, reason: "PERSISTENCE_ERROR", error };
  }

  if (data?.first_marketplace_connected_at) {
    return { updated: true, latched_at: data.first_marketplace_connected_at };
  }

  const { data: existing } = await supabase
    .from("profiles")
    .select("first_marketplace_connected_at")
    .eq("id", uid)
    .maybeSingle();

  if (existing?.first_marketplace_connected_at) {
    return { updated: false, reason: "ALREADY_LATCHED", latched_at: existing.first_marketplace_connected_at };
  }

  return { updated: false, reason: "NOT_UPDATED" };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ maxAttempts?: number }} [opts]
 */
export async function aplicarLatchesPosConexaoMarketplace(supabase, userId, opts = {}) {
  const uid = String(userId || "").trim();
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 2);
  /** @type {{ first?: Awaited<ReturnType<typeof registrarPrimeiraIntegracaoMarketplaceSeAusente>>; completion?: Awaited<ReturnType<typeof tentarRegistrarConclusaoConfiguracaoInicial>> }} */
  const results = {};

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    results.first = await registrarPrimeiraIntegracaoMarketplaceSeAusente(supabase, uid);
    if (results.first.updated || results.first.reason === "ALREADY_LATCHED") break;
    if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 80));
  }

  const ctx = await carregarContextoConfiguracaoInicial(supabase, uid);
  const snapshot = resolveConfigurationSnapshot({
    profile: ctx.profile ?? null,
    companies: ctx.companies ?? [],
    legalAcceptance: ctx.legalAcceptance ?? null,
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    results.completion = await tentarRegistrarConclusaoConfiguracaoInicial(supabase, uid, snapshot);
    if (results.completion.updated || results.completion.reason === "ALREADY_LATCHED") break;
    if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 80));
  }

  return results;
}

/**
 * Recovery idempotente — não conecta marketplace; só reconcilia latches deriváveis.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 */
export async function reconciliarLatchesConfiguracaoInicial(supabase, userId) {
  const uid = String(userId || "").trim();
  if (!uid) return { ok: false, code: "INVALID_USER" };

  const { count, error: cntErr } = await supabase
    .from("marketplace_accounts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", uid)
    .neq("status", "removed");

  const hasActiveAccount = !cntErr && typeof count === "number" && count > 0;
  if (!hasActiveAccount) {
    return { ok: false, code: "NO_ACTIVE_MARKETPLACE_ACCOUNT", message: "Nenhuma conta marketplace ativa para reconciliar." };
  }

  const latchResults = await aplicarLatchesPosConexaoMarketplace(supabase, uid, { maxAttempts: 3 });
  return { ok: true, latch_results: latchResults };
}
