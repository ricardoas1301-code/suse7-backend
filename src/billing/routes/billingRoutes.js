// ======================================================================
// Rotas HTTP — Billing (checkout, status, webhooks)
// ======================================================================

import { config } from "../../infra/config.js";
import { ok, fail, getTraceId } from "../../infra/http.js";
import { requireAuthUser } from "../../handlers/ml/_helpers/requireAuthUser.js";
import { readRequestJson } from "../utils/readRequestJson.js";
import { getBillingProvider } from "../providers/index.js";
import { AsaasApiError } from "../providers/AsaasBillingProvider.js";
import { checkoutPlan } from "../services/billingSubscriptionService.js";
import { canUserAccessPlanFeatures } from "../services/billingAccessService.js";
import { handleAsaasWebhookRequest } from "../services/billingWebhookService.js";
import { logBillingError } from "../billingLog.js";

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {string} path
 */
export async function handleBillingRoutes(req, res, path) {
  const traceId = getTraceId(req);
  const method = String(req.method || "GET").toUpperCase();

  if (path === "/api/billing/ping") {
    if (method !== "GET") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use GET" }, 405, traceId);
    }
    const env = String(config.asaasEnv || "sandbox").trim() || "sandbox";
    const commit = typeof process.env.VERCEL_GIT_COMMIT_SHA === "string" ? process.env.VERCEL_GIT_COMMIT_SHA.trim() : "";
    return ok(res, {
      ok: true,
      service: "billing",
      env,
      router: "billing-pathnorm-v1",
      ...(commit ? { commit } : {}),
      traceId,
    });
  }

  if (path === "/api/billing/webhooks/asaas") {
    if (method !== "POST") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST" }, 405, traceId);
    }
    if (!config.supabaseUrl?.trim() || !config.supabaseServiceRoleKey?.trim()) {
      return fail(res, { code: "CONFIG_ERROR", message: "Configuração do banco indisponível" }, 503, traceId);
    }
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const r = await handleAsaasWebhookRequest(supabase, req, config.asaasWebhookToken);
    return ok(res, r.body, r.status);
  }

  if (path === "/api/billing/checkout") {
    if (method !== "POST") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST" }, 405, traceId);
    }
    const auth = await requireAuthUser(req);
    if (auth.error) {
      return fail(res, { code: "UNAUTHORIZED", message: auth.error.message }, auth.error.status, traceId);
    }
    const { user, supabase } = auth;
    const body = await readRequestJson(req);
    const planKey = typeof body.plan_key === "string" ? body.plan_key.trim() : "";
    const planId = typeof body.plan_id === "string" ? body.plan_id.trim() : "";
    const paymentMethod = typeof body.payment_method === "string" ? body.payment_method.trim() : undefined;

    if (!planKey && !planId) {
      return fail(
        res,
        { code: "VALIDATION_ERROR", message: "Informe plan_key (preferencial) ou plan_id no corpo JSON." },
        400,
        traceId
      );
    }

    try {
      const providerKey = config.billingProviderDefault || "asaas";
      /** @type {import("../providers/BillingProvider.js").BillingProvider} */
      let providerApi;
      try {
        providerApi = getBillingProvider(providerKey);
      } catch (pe) {
        return fail(
          res,
          {
            code: "UNKNOWN_BILLING_PROVIDER",
            message: pe instanceof Error ? pe.message : "Provider de billing inválido",
          },
          501,
          traceId
        );
      }
      const result = await checkoutPlan({
        supabase,
        user,
        planKey: planKey || null,
        planId: planId || null,
        paymentMethod: paymentMethod || null,
        providerApi,
        providerKey,
      });
      return ok(res, { ok: true, ...result, traceId });
    } catch (e) {
      const code = /** @type {{ code?: string }} */ (e)?.code;
      if (code === "PLAN_KEY_OR_ID_REQUIRED") {
        return fail(res, { code: "VALIDATION_ERROR", message: "Informe plan_key ou plan_id." }, 400, traceId);
      }
      if (code === "PLAN_NOT_FOUND") {
        return fail(res, { code: "PLAN_NOT_FOUND", message: "Plano não encontrado ou inativo" }, 404, traceId);
      }
      if (code === "CREDIT_CARD_NOT_SUPPORTED_YET") {
        return fail(
          res,
          {
            code: "PAYMENT_METHOD_NOT_SUPPORTED",
            message: "Cartão de crédito ainda não está habilitado nesta rota (aguarde BILLING 04 / tokenização).",
          },
          400,
          traceId
        );
      }
      if (code === "ASAAS_BASE_URL_REQUIRED" || code === "ASAAS_API_KEY_REQUIRED") {
        return fail(
          res,
          {
            code: "BILLING_CONFIG",
            message:
              e instanceof Error ? e.message : "Configure ASAAS_API_BASE_URL e ASAAS_API_KEY no backend.",
          },
          503,
          traceId
        );
      }
      if (code === "PLAN_PRICE_INVALID") {
        return fail(res, { code: "PLAN_PRICE_INVALID", message: e instanceof Error ? e.message : "Preço inválido" }, 400, traceId);
      }
      if (code === "PLAN_BILLING_CONFIG") {
        return fail(res, { code: "PLAN_BILLING_CONFIG", message: e instanceof Error ? e.message : "Configuração de billing do plano inválida" }, 422, traceId);
      }
      if (code === "PROVIDER_UNSUPPORTED_FOR_PAID") {
        return fail(
          res,
          { code: "PROVIDER_UNSUPPORTED", message: "Plano pago requer gateway configurado (ex.: Asaas)." },
          501,
          traceId
        );
      }
      if (e instanceof AsaasApiError) {
        logBillingError("billing", "checkout_asaas_error", e, { status: e.status });
        return fail(
          res,
          {
            code: "ASAAS_ERROR",
            message: "Falha ao comunicar com o gateway de pagamento",
            details: e.body,
          },
          502,
          traceId
        );
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("ASAAS_API_KEY") || msg.includes("ASAAS_API_BASE_URL")) {
        return fail(res, { code: "BILLING_CONFIG", message: msg }, 503, traceId);
      }
      logBillingError("billing", "checkout_unexpected", e, { user_id: user.id });
      return fail(res, { code: "CHECKOUT_FAILED", message: msg }, 500, traceId);
    }
  }

  if (path === "/api/billing/subscription/status") {
    if (method !== "GET") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use GET" }, 405, traceId);
    }
    const auth = await requireAuthUser(req);
    if (auth.error) {
      return fail(res, { code: "UNAUTHORIZED", message: auth.error.message }, auth.error.status, traceId);
    }
    const { user, supabase } = auth;
    const access = await canUserAccessPlanFeatures(supabase, user.id);
    const { data: subs } = await supabase
      .from("billing_subscriptions")
      .select("id, plan_id, provider, status, amount, currency, created_at, updated_at, provider_subscription_id")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(10);
    return ok(res, { ok: true, access, subscriptions: subs ?? [], traceId });
  }

  return fail(res, { code: "NOT_FOUND", message: "Rota billing não encontrada" }, 404, traceId);
}
