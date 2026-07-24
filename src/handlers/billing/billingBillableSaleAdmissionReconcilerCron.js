// ======================================================================
// Cron HTTP — reconciliador admissions Baby (S1.HF.6.9A.10)
// Periodicidade: 1 minuto (agendar no host/cron com CRON_SECRET).
// Auth: Authorization: Bearer <CRON_SECRET> ou header x-cron-secret.
// Registro sugerido: POST /api/billing/internal/billable-sale-admission-reconcile
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { runBillableSaleAdmissionReconcilerJob } from "../../billing/jobs/billingBillableSaleAdmissionReconcilerJob.js";

/**
 * @param {import("http").IncomingMessage & { headers: Record<string, string | string[] | undefined>; body?: unknown }} req
 * @param {import("http").ServerResponse} res
 */
export default async function billingBillableSaleAdmissionReconcilerCron(req, res) {
  const secret = process.env.CRON_SECRET || process.env.BILLING_CRON_SECRET || "";
  const auth = String(req.headers.authorization ?? "");
  const headerSecret = String(req.headers["x-cron-secret"] ?? "");
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const provided = bearer || headerSecret;

  if (!secret || provided !== secret) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, reason: "unauthorized" }));
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, reason: "supabase_env_missing" }));
    return;
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const result = await runBillableSaleAdmissionReconcilerJob(supabase, {
      source: "http_cron",
      batchLimit: 100,
    });
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, ...result }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ok: false,
        reason: "reconciler_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
