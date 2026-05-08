// ======================================================================
// GET /api/marketplace/accounts/:id/sync-status — checklist onboarding ML (JWT).
// ======================================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { ML_MARKETPLACE_SLUG } from "../ml/_helpers/mlMarketplace.js";
import {
  ML_INITIAL_SYNC_JOB_TYPES_ORDERED,
} from "../../services/marketplace/createMlInitialSyncJobs.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** @type {{ key: string; label: string; job_type: string | null }[]} */
const CHECKLIST_DEFS = [
  { key: "ml_connect", label: "Conectando conta Mercado Livre", job_type: null },
  { key: "sales_history", label: "Vendas", job_type: "ml_initial_sales_history" },
  { key: "listings", label: "Anúncios", job_type: "ml_initial_listings" },
  { key: "fees", label: "Taxas", job_type: "ml_initial_fees" },
  { key: "products", label: "Produtos/SKU", job_type: "ml_initial_products" },
  { key: "customers", label: "Clientes 360", job_type: "ml_initial_customers" },
  { key: "monitoring", label: "Webhook/monitoramento", job_type: "ml_enable_webhook_monitoring" },
];
const STALE_PROGRESS_MS = Math.min(
  24 * 60 * 60 * 1000,
  Math.max(30 * 1000, parseInt(process.env.ML_SYNC_STATUS_STALE_MS || "90000", 10) || 90000)
);
const PENDING_QUEUE_WARNING_MS = Math.min(
  24 * 60 * 60 * 1000,
  Math.max(30 * 1000, parseInt(process.env.ML_SYNC_PENDING_QUEUE_WARNING_MS || "120000", 10) || 120000)
);

/**
 * @param {Record<string, unknown>[]} rows
 * @param {string} jobType
 */
function pickLatestJob(rows, jobType) {
  const list = rows.filter((r) => String(r.job_type || "") === jobType);
  list.sort((a, b) => {
    const ta = new Date(/** @type {string} */ (a.created_at || 0)).getTime();
    const tb = new Date(/** @type {string} */ (b.created_at || 0)).getTime();
    return tb - ta;
  });
  return list[0] ?? null;
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {string} path
 */
export default async function handleMarketplaceAccountSyncStatus(req, res, path) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;

  const m = path.match(/^\/api\/marketplace\/accounts\/([^/]+)\/sync-status$/);
  const accountId = m?.[1] ?? null;
  if (!accountId || !UUID_REGEX.test(accountId)) {
    return res.status(400).json({ ok: false, error: "ID inválido." });
  }

  try {
    const { data: account, error: accErr } = await supabase
      .from("marketplace_accounts")
      .select("id,status,marketplace,user_id,updated_at")
      .eq("id", accountId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (accErr) {
      console.error("[marketplace/sync-status] account_query", accErr);
      return res.status(500).json({ ok: false, error: "Erro ao carregar conta." });
    }
    if (!account?.id) {
      return res.status(404).json({ ok: false, error: "Conta não encontrada." });
    }

    const { data: jobRows, error: jobErr } = await supabase
      .from("marketplace_account_sync_jobs")
      .select("*")
      .eq("marketplace_account_id", accountId)
      .in("job_type", ML_INITIAL_SYNC_JOB_TYPES_ORDERED)
      .order("created_at", { ascending: false })
      .limit(120);

    if (jobErr) {
      console.error("[marketplace/sync-status] jobs_query", jobErr);
      return res.status(500).json({ ok: false, error: "Erro ao carregar jobs." });
    }

    const rows = jobRows ?? [];

    /** @type {Record<string, unknown>[]} */
    const checklist = [];

    for (const def of CHECKLIST_DEFS) {
      if (def.job_type == null) {
        const st = String(account.status || "").toLowerCase() === "active" ? "done" : "pending";
        checklist.push({
          key: def.key,
          label: def.label,
          job_type: null,
          status: st,
          progress_current: null,
          progress_total: null,
          error_message: null,
          metadata: {},
        });
        continue;
      }

      const job = pickLatestJob(rows, def.job_type);
      const st = job?.status != null ? String(job.status) : "pending";
      checklist.push({
        key: def.key,
        label: def.label,
        job_type: def.job_type,
        status: st,
        progress_current: job?.progress_current ?? null,
        progress_total: job?.progress_total ?? null,
        error_message: job?.error_message ?? null,
        metadata: job?.metadata && typeof job.metadata === "object" ? job.metadata : {},
      });
    }

    const typedStatuses = checklist
      .filter((x) => x.job_type != null)
      .map((x) => String(x.status || ""));

    const hasEngagedInitialSync = rows.length > 0;

    const anyError = typedStatuses.some((s) => s === "error");
    const allDone =
      typedStatuses.length > 0 && typedStatuses.every((s) => s === "done");
    const doneRows = rows.filter((r) => String(r.status || "") === "done");
    const hasPartialWarnings = doneRows.some((r) => {
      const m = r?.metadata && typeof r.metadata === "object" ? r.metadata : {};
      const c = Number(m?.errors_count ?? 0);
      return Number.isFinite(c) && c > 0;
    });
    const runningRows = rows.filter((r) => String(r.status || "") === "running");
    const pendingRows = rows.filter((r) => String(r.status || "") === "pending");
    const latestRunningTs = runningRows
      .map((r) => Date.parse(String(r.updated_at ?? r.created_at ?? "")))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => b - a)[0];
    const staleRunning =
      runningRows.length > 0 &&
      Number.isFinite(latestRunningTs) &&
      Date.now() - Number(latestRunningTs) > STALE_PROGRESS_MS;
    const oldestPendingTs = pendingRows
      .map((r) => Date.parse(String(r.updated_at ?? r.created_at ?? "")))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b)[0];
    const queuedTooLong =
      pendingRows.length > 0 &&
      Number.isFinite(oldestPendingTs) &&
      Date.now() - Number(oldestPendingTs) > PENDING_QUEUE_WARNING_MS;

    let overall = "idle";
    if (!hasEngagedInitialSync) {
      overall = "awaiting_start";
    } else if (typedStatuses.length === 0) {
      overall = "no_jobs";
    } else if (anyError) {
      overall = "error";
    } else if (allDone && hasPartialWarnings) {
      overall = "completed_with_errors";
    } else if (allDone) {
      overall = "done";
    } else {
      overall = "running";
    }

    const background_note =
      overall === "running"
        ? "Estamos terminando sua importação em segundo plano."
        : null;
    const stalled_warning =
      overall === "running" && staleRunning
        ? "A sincronização está demorando mais que o normal. Estamos tentando continuar em segundo plano."
        : null;
    const pending_queue_warning =
      (overall === "running" || overall === "awaiting_start") && queuedTooLong
        ? "Sincronização enfileirada. Estamos aguardando o processamento em segundo plano."
        : null;

    return res.status(200).json({
      ok: true,
      marketplace_account_id: accountId,
      marketplace: String(account.marketplace || ML_MARKETPLACE_SLUG),
      overall,
      stalled: Boolean(staleRunning),
      stale_threshold_ms: STALE_PROGRESS_MS,
      pending_queued_too_long: Boolean(queuedTooLong),
      pending_warning_threshold_ms: PENDING_QUEUE_WARNING_MS,
      initial_sync_engaged: hasEngagedInitialSync,
      background_note,
      stalled_warning,
      pending_queue_warning,
      title: "Conta Mercado Livre conectada",
      description:
        "Conta Mercado Livre conectada com sucesso. Agora vamos sincronizar seus dados para preparar o Suse7.",
      checklist,
    });
  } catch (e) {
    console.error("[marketplace/sync-status]", e);
    return res.status(500).json({ ok: false, error: "Erro interno." });
  }
}
