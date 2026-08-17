// ======================================================================
// GET /api/dashboard/operational-tasks
// Central de Tarefas Operacionais — contrato frontend (tasks + total_tasks).
// Ausência de tarefas → 200 com lista vazia (nunca 500 soft).
// ======================================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { formatBillingErrorMessage } from "../../billing/utils/billingNormalizeError.js";
import {
  buildOperationalTasksPayload,
  countMissingProductCostsForUser,
  countSkuDependencyPendingForUser,
} from "../../domain/dashboard/operationalTasksPayload.js";
import { resolveInitialSyncUniverseStable } from "../../domain/dashboard/initialSyncUniverseStable.js";
import { resolveMlInitialSyncOperationalPhase } from "../../domain/dashboard/resolveMlInitialSyncOperationalPhase.js";
import { resolverEmpresaPrincipalOnboarding } from "../../onboarding/domain/avaliarMilestonesConfiguracaoInicial.js";

const LOG_PREFIX = "[S7_OPERATIONAL_TASKS]";

/** @param {string} label @param {Record<string, unknown>} [payload] */
function logHandler(label, payload = {}) {
  console.info(`${LOG_PREFIX} ${label}`, payload);
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse & { status: Function; json: Function }} res
 */
export async function handleDashboardOperationalTasks(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  logHandler("started", { method: req.method });

  const auth = await requireAuthUser(req);
  if (auth.error) {
    if (auth.error.code === "CONFIG_ERROR") {
      return res.status(200).json({ ok: true, tasks: [], total_tasks: 0 });
    }
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;

  try {
    const [universe, mlSyncPhase, profileRes, companiesRes] = await Promise.all([
      resolveInitialSyncUniverseStable(supabase, user.id),
      resolveMlInitialSyncOperationalPhase(supabase, user.id),
      supabase.from("profiles").select("photo_url, telefone").eq("id", user.id).maybeSingle(),
      supabase
        .from("seller_companies")
        .select(
          "id, user_id, whatsapp, phone, logo_url, cep, address_street, address_number, address_complement, address_district, address_city, address_state, is_primary, active",
        )
        .eq("user_id", user.id),
    ]);

    const { company: primaryCompany } = resolverEmpresaPrincipalOnboarding(companiesRes.data ?? []);

    const [skuResult, costsResult] = await Promise.allSettled([
      universe.stable ? countSkuDependencyPendingForUser(supabase, user.id) : Promise.resolve(0),
      universe.stable ? countMissingProductCostsForUser(supabase, user.id) : Promise.resolve(0),
    ]);
    const skuCount = skuResult.status === "fulfilled" ? skuResult.value : 0;
    const costsCount = costsResult.status === "fulfilled" ? costsResult.value : 0;
    const built = buildOperationalTasksPayload({
      skuDependencyPendingCount: skuCount,
      missingProductCostsCount: costsCount,
      universeStable: universe.stable,
      mlInitialSyncPhase: mlSyncPhase.phase,
      mlMarketplaceAccountId: mlSyncPhase.marketplace_account_id,
      profilePhotoUrl: profileRes.data?.photo_url ?? null,
      companyLogoUrl: primaryCompany?.logo_url ?? null,
      primaryCompany: primaryCompany ?? null,
    });
    const warning =
      skuResult.status === "rejected" || costsResult.status === "rejected"
        ? "operational_tasks_partial_unavailable"
        : undefined;
    logHandler("ok", {
      user_id: user.id,
      sku_dependency_pending: skuCount,
      missing_product_costs: costsCount,
      total_tasks: built.total_tasks,
      initial_sync_universe_stable: universe.stable,
    });
    return res.status(200).json({
      ok: true,
      tasks: built.tasks,
      total_tasks: built.total_tasks,
      initial_sync_universe_stable: built.initial_sync_universe_stable ?? universe.stable,
      ml_initial_sync_phase: mlSyncPhase.phase,
      ...(warning ? { warning } : {}),
    });
  } catch (error) {
    const errorId = Date.now();
    const message = formatBillingErrorMessage(error, {
      operation: "dashboard_operational_tasks",
      errorId,
    });
    console.error(`${LOG_PREFIX} failed`, { errorId, message });
    // Soft-fail: não derruba o dashboard / permissões do plano.
    return res.status(200).json({
      ok: true,
      tasks: [],
      total_tasks: 0,
      warning: "operational_tasks_unavailable",
      errorId,
    });
  }
}

export default handleDashboardOperationalTasks;
