// ======================================================================
// POST /api/marketplace/accounts/:id/start-initial-sync
// Enfileira onda inicial (jobs) — idempotente via createMlInitialSyncJobsIfAbsent.
// ======================================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { ML_MARKETPLACE_SLUG } from "../ml/_helpers/mlMarketplace.js";
import {
  createMlInitialSyncJobsIfAbsent,
  ML_INITIAL_SYNC_JOB_TYPES_ORDERED,
} from "../../services/marketplace/createMlInitialSyncJobs.js";
import { config } from "../../infra/config.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {string} path
 */
export default async function handleMarketplaceAccountStartInitialSync(req, res, path) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  /** @type {Record<string, unknown>} */
  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    body = {};
  }
  const forceParam = req.query?.force;
  const force =
    body?.force === true ||
    String(forceParam ?? "")
      .trim()
      .toLowerCase() === "true" ||
    String(forceParam ?? "").trim() === "1";
  const m = path.match(/^\/api\/marketplace\/accounts\/([^/]+)\/start-initial-sync$/);
  const accountId = m?.[1] ?? null;
  if (!accountId || !UUID_REGEX.test(accountId)) {
    return res.status(400).json({ ok: false, error: "ID inválido." });
  }

  try {
    console.info("[ML_ONBOARDING_SYNC_START_HANDLER_HIT]", {
      user_id: user.id,
      marketplace_account_id: accountId,
      planned_job_types: ML_INITIAL_SYNC_JOB_TYPES_ORDERED,
      force,
      build_fingerprint: {
        vercel_git_commit: process.env.VERCEL_GIT_COMMIT ?? null,
        vercel_deployment_id: process.env.VERCEL_DEPLOYMENT_ID ?? null,
      },
    });

    console.info("[ML_ONBOARDING_SYNC_START_REQUEST]", {
      user_id: user.id,
      path,
      method: req.method,
      force,
      timestamp: new Date().toISOString(),
    });

    const { data: acc, error: accErr } = await supabase
      .from("marketplace_accounts")
      .select("id, seller_company_id, marketplace, status")
      .eq("id", accountId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (accErr) {
      console.error("[marketplace/start-initial-sync] account_query", accErr);
      return res.status(500).json({ ok: false, error: "Erro ao carregar conta." });
    }
    if (!acc?.id) {
      return res.status(404).json({ ok: false, error: "Conta não encontrada." });
    }

    const mp = String(acc.marketplace || "").trim();
    if (mp !== ML_MARKETPLACE_SLUG) {
      return res.status(400).json({ ok: false, error: "Tipo de marketplace não suportado nesta rota." });
    }

    if (String(acc.status || "").toLowerCase() !== "active") {
      return res.status(400).json({ ok: false, error: "Conta inativa; reconecte o Mercado Livre." });
    }

    const sellerCompanyId =
      acc.seller_company_id != null && String(acc.seller_company_id).trim() !== ""
        ? String(acc.seller_company_id).trim()
        : null;

    if (force) {
      const forceTypes = ["ml_initial_sales_history"];
      const { error: forceErr } = await supabase
        .from("marketplace_account_sync_jobs")
        .update({
          status: "pending",
          started_at: null,
          finished_at: null,
          error_message: null,
          updated_at: new Date().toISOString(),
        })
        .eq("marketplace_account_id", accountId)
        .in("job_type", forceTypes);
      if (forceErr) {
        console.error("[ML_ONBOARDING_SYNC_FORCE_RESET_FAILED]", {
          user_id: user.id,
          marketplace_account_id: accountId,
          job_types: forceTypes,
          message: forceErr.message,
          code: forceErr.code,
        });
      } else {
        console.info("[ML_ONBOARDING_SYNC_FORCE_RESET_APPLIED]", {
          user_id: user.id,
          marketplace_account_id: accountId,
          job_types: forceTypes,
        });
      }
    }

    const result = await createMlInitialSyncJobsIfAbsent(supabase, {
      userId: user.id,
      marketplaceAccountId: accountId,
      sellerCompanyId,
    });

    const { data: plannedRows, error: plannedErr } = await supabase
      .from("marketplace_account_sync_jobs")
      .select("id, job_type, status, marketplace_account_id")
      .eq("marketplace_account_id", accountId)
      .in("job_type", ML_INITIAL_SYNC_JOB_TYPES_ORDERED)
      .in("status", ["pending", "running", "done", "error"])
      .order("created_at", { ascending: false })
      .limit(40);
    const planned = Array.isArray(plannedRows) ? plannedRows : [];
    const pending = planned.filter((r) => String(r.status || "") === "pending").length;
    const running = planned.filter((r) => String(r.status || "") === "running").length;
    const done = planned.filter((r) => String(r.status || "") === "done").length;
    const errors = planned.filter((r) => String(r.status || "") === "error").length;
    const plannedTypes = [...new Set(planned.map((r) => String(r.job_type || "")).filter(Boolean))];
    console.info("[ML_ONBOARDING_SYNC_JOBS_PLANNED]", {
      user_id: user.id,
      marketplace_account_id: accountId,
      total_jobs: planned.length,
      pending_jobs: pending,
      running_jobs: running,
      done_jobs: done,
      error_jobs: errors,
      job_types: plannedTypes,
      query_error: plannedErr?.message ?? null,
      created_now: result.created,
      skipped_creation: result.skipped,
    });

    console.info("[ML_ONBOARDING_SYNC_RUN_CREATED]", {
      user_id: user.id,
      marketplace_account_id: accountId,
      seller_company_id: sellerCompanyId,
      jobs_created: result.created,
      skipped: result.skipped,
      timestamp: new Date().toISOString(),
    });

    const host = req.headers?.host != null ? String(req.headers.host) : "";
    const protoHeader = req.headers?.["x-forwarded-proto"] != null ? String(req.headers["x-forwarded-proto"]) : "";
    const proto = protoHeader.includes("https") ? "https" : "http";
    const baseUrl = host ? `${proto}://${host}` : null;
    const dispatchUrl = baseUrl ? `${baseUrl}/api/jobs/marketplace-account-sync?limit=1` : null;

    // Fire-and-forget: inicia uma passada do worker sem bloquear a resposta da UI.
    if (dispatchUrl) {
      const headers = {};
      if (config.jobSecret) headers["x-job-secret"] = config.jobSecret;
      Promise.resolve()
        .then(async () => {
          try {
            const startedAt = Date.now();
            const r = await fetch(dispatchUrl, {
              method: "POST",
              headers,
            });
            console.info("[ML_ONBOARDING_SYNC_JOB_DISPATCHED]", {
              user_id: user.id,
              marketplace_account_id: accountId,
              status: r.status,
              ok: r.ok,
              elapsed_ms: Date.now() - startedAt,
              url: "/api/jobs/marketplace-account-sync?limit=1",
            });
          } catch (dispatchErr) {
            console.error("[ML_ONBOARDING_SYNC_JOB_DISPATCHED]", {
              user_id: user.id,
              marketplace_account_id: accountId,
              ok: false,
              error: dispatchErr?.message ?? String(dispatchErr),
            });
          }
        })
        .catch(() => {});
    }

    return res.status(200).json({
      ok: true,
      marketplace_account_id: accountId,
      created: result.created,
      skipped: result.skipped,
    });
  } catch (e) {
    console.error("[ML_ONBOARDING_SYNC_FAILED]", {
      message: e?.message ?? String(e),
      stack: e?.stack ?? null,
    });
    return res.status(500).json({ ok: false, error: "Erro interno." });
  }
}
