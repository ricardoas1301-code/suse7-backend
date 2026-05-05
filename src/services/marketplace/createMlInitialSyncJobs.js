// ======================================================================
// Pós-OAuth Mercado Livre: enfileira onda inicial de jobs (histórico + etapas).
// Idempotente: não duplica se já existir job pendente/em execução da mesma onda.
// ======================================================================

/** Ordem de dependência (sales primeiro; demais após conclusão das vendas). */
export const ML_INITIAL_SYNC_JOB_TYPES_ORDERED = [
  "ml_initial_sales_history",
  "ml_initial_listings",
  "ml_initial_products",
  "ml_initial_customers",
  "ml_enable_webhook_monitoring",
];

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   marketplaceAccountId: string;
 *   sellerCompanyId?: string | null;
 *   marketplace?: string;
 * }} ctx
 * @returns {Promise<{ created: number; skipped: boolean }>}
 */
export async function createMlInitialSyncJobsIfAbsent(supabase, ctx) {
  const marketplace = ctx.marketplace ?? "mercado_livre";
  const accId = String(ctx.marketplaceAccountId || "").trim();
  const uid = String(ctx.userId || "").trim();
  if (!accId || !uid) {
    console.warn("[ML_INITIAL_SYNC_CREATED]", { skipped: true, reason: "missing_ids", accId, uid });
    return { created: 0, skipped: true };
  }

  const { data: existing, error: exErr } = await supabase
    .from("marketplace_account_sync_jobs")
    .select("id")
    .eq("marketplace_account_id", accId)
    .in("job_type", ML_INITIAL_SYNC_JOB_TYPES_ORDERED)
    .in("status", ["pending", "running"])
    .limit(1);

  if (exErr) {
    console.error("[ML_INITIAL_SYNC_CREATED]", { ok: false, error: exErr.message });
    throw exErr;
  }

  if (existing?.length) {
    console.info("[ML_INITIAL_SYNC_CREATED]", {
      skipped: true,
      reason: "active_wave_exists",
      marketplace_account_id: accId,
    });
    return { created: 0, skipped: true };
  }

  const sellerCompanyId =
    ctx.sellerCompanyId != null && String(ctx.sellerCompanyId).trim() !== ""
      ? String(ctx.sellerCompanyId).trim()
      : null;

  const rows = ML_INITIAL_SYNC_JOB_TYPES_ORDERED.map((job_type) => ({
    user_id: uid,
    marketplace,
    marketplace_account_id: accId,
    seller_company_id: sellerCompanyId,
    job_type,
    status: "pending",
    metadata: { wave: "oauth_post_connect_v1" },
    updated_at: new Date().toISOString(),
  }));

  const { error: insErr } = await supabase.from("marketplace_account_sync_jobs").insert(rows);
  if (insErr) {
    console.error("[ML_INITIAL_SYNC_CREATED]", { ok: false, error: insErr.message });
    throw insErr;
  }

  console.info("[ML_INITIAL_SYNC_CREATED]", {
    marketplace_account_id: accId,
    user_id: uid,
    jobs: rows.length,
    job_types: ML_INITIAL_SYNC_JOB_TYPES_ORDERED,
  });

  return { created: rows.length, skipped: false };
}
