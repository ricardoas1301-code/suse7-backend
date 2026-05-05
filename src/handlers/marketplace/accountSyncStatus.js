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
  { key: "sales_history", label: "Importando histórico de vendas", job_type: "ml_initial_sales_history" },
  { key: "listings", label: "Importando anúncios", job_type: "ml_initial_listings" },
  { key: "products", label: "Importando produtos/SKUs", job_type: "ml_initial_products" },
  { key: "customers", label: "Importando clientes", job_type: "ml_initial_customers" },
  { key: "monitoring", label: "Preparando monitoramento automático", job_type: "ml_enable_webhook_monitoring" },
];

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

    const anyError = typedStatuses.some((s) => s === "error");
    const anyRunning = typedStatuses.some((s) => s === "running" || s === "pending");
    const allDone =
      typedStatuses.length > 0 && typedStatuses.every((s) => s === "done");

    let overall = "idle";
    if (typedStatuses.length === 0) overall = "no_jobs";
    else if (anyError) overall = "error";
    else if (allDone) overall = "done";
    else overall = "running";

    const background_note =
      overall === "running"
        ? "Estamos terminando sua importação em segundo plano."
        : null;

    return res.status(200).json({
      ok: true,
      marketplace_account_id: accountId,
      marketplace: String(account.marketplace || ML_MARKETPLACE_SLUG),
      overall,
      background_note,
      title: "Estamos preparando sua conta Mercado Livre",
      description:
        "Vamos importar seu histórico de vendas, anúncios, produtos e clientes. Esse processo pode demorar um pouco na primeira vez. Depois disso, as atualizações serão automáticas.",
      checklist,
    });
  } catch (e) {
    console.error("[marketplace/sync-status]", e);
    return res.status(500).json({ ok: false, error: "Erro interno." });
  }
}
