// ======================================================================
// Rotas HTTP — Billing (checkout, status, webhooks)
// ======================================================================

import { config } from "../../infra/config.js";
import { ok, fail, getTraceId } from "../../infra/http.js";
import { requireAuthUser } from "../../handlers/ml/_helpers/requireAuthUser.js";
import { readRequestJson } from "../utils/readRequestJson.js";
import { getBillingProvider } from "../providers/index.js";
import { AsaasApiError } from "../providers/AsaasBillingProvider.js";
import { summarizeAsaasErrorBody } from "../providers/asaasApiHelpers.js";
import { classifyAsaasCheckoutFailure } from "../utils/asaasCheckoutErrorMap.js";
import { INVALID_CARD_HOLDER_POSTAL_CODE_MESSAGE } from "../utils/billingCardPostalCode.js";
import { assertCreditCardCheckoutOnly } from "../utils/billingCheckoutGuards.js";
import { checkoutPlan, normalizeCheckoutPaymentMethod } from "../services/billingSubscriptionService.js";
import { startBillingCheckout } from "../services/billingCheckoutStartService.js";
import { listActivePlans, resolvePlanDisplayFields } from "../services/billingPlanRepository.js";
import { resolveBillingAccess } from "../services/resolveBillingAccess.js";
import {
  enrichSubscriptionWithBillingCycle,
  resolveSubscriptionBillingCycle,
} from "../services/billingCycleService.js";
import { waitUntil } from "@vercel/functions";
import {
  dispatchAsaasWebhookBackgroundApply,
  runAsaasWebhookAckPipeline,
} from "../services/billingWebhookService.js";
import { buildBillingAsaasWebhookHealthPayload } from "../utils/billingAsaasWebhookHealth.js";
import {
  deactivateSellerPaymentMethod,
  listSellerPaymentMethods,
  setDefaultSellerPaymentMethod,
} from "../services/billingPaymentMethodsService.js";
import { tokenizeAndPersistSellerCard } from "../services/billingCardPaymentMethodService.js";
import {
  buildCardCheckoutFromRequestBody,
  resolveCardCheckoutPaymentMethod,
  resolveClientRemoteIp,
} from "../utils/billingRequestContext.js";
import { listSellerPaymentHistory } from "../services/billingPaymentsHistoryService.js";
import { requestSubscriptionCancellationAtPeriodEnd, enrichSubscriptionCancellationFields } from "../services/billingSubscriptionCancelService.js";
import { reactivateSubscriptionCancellation } from "../services/billingSubscriptionReactivateService.js";
import {
  enrichSubscriptionPlanChangeFields,
  requestSubscriptionPlanChange,
} from "../services/billingSubscriptionChangePlanService.js";
import { processBillingPeriodExpirations } from "../services/billingPeriodExpirationService.js";
import { processBillingRenewals } from "../services/billingRenewalService.js";
import { processBillingRenewalEngine } from "../services/billingRenewalEngine.js";
import { payRenewalCycle } from "../services/billingRenewalPayService.js";
import {
  enrichSubscriptionDelinquencyFields,
  findLatestOverduePaymentInvoiceUrl,
  processBillingOverdues,
} from "../services/billingDunningService.js";
import { logBilling, logBillingError } from "../billingLog.js";
import { canRunBillingDevMaintenanceRoute } from "../middleware/evaluateBillingJobAuth.js";
import { refreshBillingPaymentFromProvider } from "../services/billingPaymentSyncService.js";
import { resolveSubscriptionPresentation } from "../services/billingSubscriptionPresentationService.js";
import { fetchPixCheckoutPayload } from "../services/billingPixCheckoutService.js";
import { fetchBoletoCheckoutPayload } from "../services/billingBoletoCheckoutService.js";
import { assertBillingPaymentPayableForUser } from "../utils/billingPaymentPayability.js";
import {
  buildPendingPaymentPresentation,
  findPendingCheckoutPaymentRow,
} from "../services/billingPendingPaymentPresentationService.js";
import { resolvePendingRenewalPresentation } from "../services/billingPendingRenewalPresentationService.js";
import { computeRenewalNotice } from "../services/billingRenewalNoticeEngine.js";
import { resolveRenewalAccessPresentation } from "../services/billingRenewalAccessPolicy.js";
import { recordRenewalNoticeEvent } from "../services/billingRenewalNoticeEventService.js";
import {
  findOpenRenewalCycleForSubscription,
} from "../services/billingRenewalCycleRepository.js";
import { resolveRenewalStrategyForSubscription } from "../services/billingRenewalStrategyService.js";
import { listBillingTimelineForUser } from "../services/billingTimelineEventService.js";
import { computeRevenueHealthForUser } from "../services/billingRevenueHealthService.js";
import { listBillingNotificationsForUser } from "../services/billingNotificationCenterService.js";

/** Path canônico para match de rotas (decode + slashes + case). */
/**
 * @param {unknown} body
 */
function isExplicitUserAction(body) {
  return body && typeof body === "object" && /** @type {Record<string, unknown>} */ (body).explicit_user_action === true;
}

function normalizeBillingRoutePath(input) {
  let s = String(input ?? "").trim();
  if (!s) return "/";
  try {
    s = decodeURIComponent(s);
  } catch {
    /* manter */
  }
  s = s.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
  return s.toLowerCase();
}

/**
 * @param {import("http").ServerResponse} res
 * @param {unknown} e
 * @param {string} traceId
 * @param {string | null | undefined} userId
 */
function respondCheckoutRouteError(res, e, traceId, userId) {
  const code = /** @type {{ code?: string }} */ (e)?.code;
  if (code === "EXPLICIT_USER_ACTION_REQUIRED") {
    return fail(
      res,
      {
        code: "EXPLICIT_USER_ACTION_REQUIRED",
        message: "Cobrança só pode ser criada após ação explícita do seller (botão de pagamento).",
      },
      400,
      traceId
    );
  }
  if (code === "PLAN_KEY_OR_ID_REQUIRED") {
    return fail(res, { code: "VALIDATION_ERROR", message: "Informe plan_slug, plan_key ou plan_id." }, 400, traceId);
  }
  if (code === "PLAN_NOT_FOUND") {
    return fail(res, { code: "PLAN_NOT_FOUND", message: "Plano não encontrado ou inativo" }, 404, traceId);
  }
  if (
    code === "CARD_PAYLOAD_REQUIRED" ||
    code === "CARD_PAYLOAD_INVALID" ||
    code === "CARD_HOLDER_TAX_ID_REQUIRED" ||
    code === "CARD_HOLDER_EMAIL_REQUIRED" ||
    code === "CARD_HOLDER_PHONE_REQUIRED" ||
    code === "CARD_HOLDER_POSTAL_CODE_REQUIRED" ||
    code === "INVALID_CARD_HOLDER_POSTAL_CODE"
  ) {
    const message =
      code === "INVALID_CARD_HOLDER_POSTAL_CODE" || code === "CARD_HOLDER_POSTAL_CODE_REQUIRED"
        ? INVALID_CARD_HOLDER_POSTAL_CODE_MESSAGE
        : e instanceof Error
          ? e.message
          : "Dados do cartão inválidos.";
    const responseCode =
      code === "INVALID_CARD_HOLDER_POSTAL_CODE" ? "invalid_card_holder_postal_code" : code ?? "CARD_VALIDATION_ERROR";
    return fail(res, { code: responseCode, message }, 400, traceId);
  }
  if (code === "CARD_TOKEN_UNAVAILABLE" || code === "REMOTE_IP_REQUIRED") {
    return fail(
      res,
      { code: code ?? "CARD_CHECKOUT_FAILED", message: e instanceof Error ? e.message : "Falha no cartão." },
      400,
      traceId
    );
  }
  if (code === "PAYMENT_METHOD_NOT_FOUND") {
    return fail(res, { code: "PAYMENT_METHOD_NOT_FOUND", message: "Forma de pagamento não encontrada." }, 404, traceId);
  }
  if (code === "DEBIT_CARD_NOT_SUPPORTED") {
    return fail(
      res,
      {
        code: "debit_card_not_supported",
        message:
          e instanceof Error
            ? e.message
            : "Cartão de débito não está disponível neste checkout. Use Pix, boleto ou cartão de crédito.",
      },
      400,
      traceId
    );
  }
  if (code === "CARD_TYPE_MISMATCH" || code === "CARD_AUTO_RENEW_NOT_SUPPORTED") {
    return fail(
      res,
      { code: code ?? "CARD_NOT_ALLOWED", message: e instanceof Error ? e.message : "Operação não permitida para este cartão." },
      400,
      traceId
    );
  }
  if (code === "ASAAS_BASE_URL_REQUIRED" || code === "ASAAS_API_KEY_REQUIRED") {
    return fail(
      res,
      {
        code: "BILLING_CONFIG",
        message: e instanceof Error ? e.message : "Configure ASAAS_API_BASE_URL e ASAAS_API_KEY no backend.",
      },
      503,
      traceId
    );
  }
  if (code === "CHECKOUT_TAX_ID_REQUIRED") {
    return fail(
      res,
      {
        code: "CHECKOUT_TAX_ID_REQUIRED",
        message: "CPF ou CNPJ é obrigatório para checkout pago. Complete o cadastro fiscal do seller.",
      },
      422,
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
    const summary = summarizeAsaasErrorBody(e.body);
    const mapped = classifyAsaasCheckoutFailure(e);
    logBillingError("billing", "checkout_asaas_error", e, {
      status: e.status,
      error_code: summary.errors[0]?.code ?? null,
      error_message: summary.message,
      mapped_code: mapped?.code ?? null,
      mapped_http_status: mapped?.httpStatus ?? null,
    });
    if (mapped) {
      return fail(
        res,
        {
          code: mapped.code,
          message: mapped.message,
          gateway_status: mapped.gateway_status,
          gateway_error_code: mapped.gateway_error_code,
          gateway_error_message: mapped.gateway_error_message,
        },
        mapped.httpStatus,
        traceId
      );
    }
    return fail(
      res,
      {
        code: "ASAAS_ERROR",
        message: "Falha ao comunicar com o gateway de pagamento",
        gateway_status: e.status,
        gateway_error_code: summary.errors[0]?.code ?? null,
        gateway_error_message: summary.message,
      },
      502,
      traceId
    );
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("ASAAS_API_KEY") || msg.includes("ASAAS_API_BASE_URL")) {
    return fail(res, { code: "BILLING_CONFIG", message: msg }, 503, traceId);
  }
  logBillingError("billing", "checkout_unexpected", e, { user_id: userId ?? undefined });
  return fail(res, { code: "CHECKOUT_FAILED", message: msg }, 500, traceId);
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {string} path
 */
export async function handleBillingRoutes(req, res, path) {
  const traceId = getTraceId(req);
  const method = String(req.method || "GET").toUpperCase();
  const pathNorm = normalizeBillingRoutePath(path);

  // TEMP — remover após validar roteamento billing em DEV/prod
  console.log("[S7 BILLING ROUTER]", JSON.stringify({ pathNorm, method }));

  if (pathNorm === "/api/billing/ping") {
    // TEMP — remover após validar roteamento billing em DEV/prod
    console.log("[S7 BILLING ROUTER MATCHED]", JSON.stringify({ route: "ping" }));
    if (method !== "GET") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use GET" }, 405, traceId);
    }
    const env = String(config.asaasEnv || "sandbox").trim() || "sandbox";
    const commit = typeof process.env.VERCEL_GIT_COMMIT_SHA === "string" ? process.env.VERCEL_GIT_COMMIT_SHA.trim() : "";
    const { isBillingRenewalTestAccelerated } = await import("../services/billingRenewalTestTime.js");
    return ok(res, {
      ok: true,
      service: "billing",
      env,
      router: "billing-pathnorm-v1",
      renewal_test_accelerated: isBillingRenewalTestAccelerated(),
      ...(commit ? { commit } : {}),
      traceId,
    });
  }

  if (pathNorm === "/api/billing/webhooks/asaas/health") {
    if (method !== "GET") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use GET" }, 405, traceId);
    }
    const health = buildBillingAsaasWebhookHealthPayload(req);
    console.info("[ASAAS_WEBHOOK_HEALTH]", {
      ok: health.ok,
      webhook_ready: health.webhookReady,
      supabase_project_ref: health.supabaseProjectRef,
      missing_env: health.missingEnv,
      trace_id: traceId,
    });
    return ok(res, { ...health, traceId });
  }

  if (pathNorm === "/api/billing/webhooks/asaas") {
    if (method !== "POST") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST" }, 405, traceId);
    }
    const health = buildBillingAsaasWebhookHealthPayload(req);
    if (!health.webhookReady) {
      console.error("[ASAAS_WEBHOOK_PROCESSING_FAILED]", {
        phase: "config",
        missing_env: health.missingEnv,
        supabase_project_ref: health.supabaseProjectRef,
        trace_id: traceId,
      });
      return fail(
        res,
        {
          code: health.missingEnv.includes("ASAAS_WEBHOOK_TOKEN")
            ? "WEBHOOK_NOT_CONFIGURED"
            : "CONFIG_ERROR",
          message:
            health.missingEnv.includes("ASAAS_WEBHOOK_TOKEN")
              ? "ASAAS_WEBHOOK_TOKEN não configurado no ambiente."
              : "Configuração do banco indisponível",
          missingEnv: health.missingEnv,
          supabaseProjectRef: health.supabaseProjectRef,
          expectedSupabaseProjectRef: health.expectedSupabaseProjectRef,
        },
        503,
        traceId
      );
    }
    try {
      const { createClient } = await import("@supabase/supabase-js");
      const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });

      const pipeline = await runAsaasWebhookAckPipeline(supabase, req, config.asaasWebhookToken, { traceId });
      if (pipeline.runBackground && pipeline.job) {
        waitUntil(dispatchAsaasWebhookBackgroundApply(supabase, pipeline.job, { traceId }));
      }

      return ok(res, pipeline.body, pipeline.httpStatus);
    } catch (routeErr) {
      console.error("[ASAAS_WEBHOOK_PROCESSING_FAILED]", {
        phase: "route_unhandled",
        message: routeErr instanceof Error ? routeErr.message : String(routeErr),
        trace_id: traceId,
      });
      return ok(
        res,
        {
          ok: true,
          accepted: true,
          warning: "route_internal_error_logged",
          traceId,
        },
        200
      );
    }
  }

  if (pathNorm === "/api/billing/plans") {
    if (method !== "GET") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use GET" }, 405, traceId);
    }
    const auth = await requireAuthUser(req);
    if (auth.error) {
      return fail(res, { code: "UNAUTHORIZED", message: auth.error.message }, auth.error.status, traceId);
    }
    const { supabase } = auth;
    const plans = await listActivePlans(supabase);
    const normalizedPlans = plans.map((plan) => ({
      ...plan,
      ...resolvePlanDisplayFields(plan),
    }));
    return ok(res, { ok: true, plans: normalizedPlans, traceId });
  }

  if (pathNorm === "/api/billing/checkout/card") {
    if (method !== "POST") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST" }, 405, traceId);
    }
    const auth = await requireAuthUser(req);
    if (auth.error) {
      return fail(res, { code: "UNAUTHORIZED", message: auth.error.message }, auth.error.status, traceId);
    }
    const { user, supabase } = auth;
    const body = await readRequestJson(req);
    if (!isExplicitUserAction(body)) {
      return fail(
        res,
        {
          code: "EXPLICIT_USER_ACTION_REQUIRED",
          message: "Informe explicit_user_action: true para criar cobrança (ação do seller).",
        },
        400,
        traceId
      );
    }
    const planSlug = typeof body.plan_slug === "string" ? body.plan_slug.trim() : "";
    const planKey = typeof body.plan_key === "string" ? body.plan_key.trim() : "";
    const planId = typeof body.plan_id === "string" ? body.plan_id.trim() : "";
    if (!planSlug && !planKey && !planId) {
      return fail(res, { code: "VALIDATION_ERROR", message: "Informe plan_slug, plan_key ou plan_id." }, 400, traceId);
    }
    try {
      assertCreditCardCheckoutOnly(body.payment_method, body.card_type);
    } catch (error) {
      return respondCheckoutRouteError(res, error, traceId, user.id);
    }
    const cardCheckout = {
      ...buildCardCheckoutFromRequestBody(body),
      remoteIp: resolveClientRemoteIp(req),
    };
    const paymentMethod = resolveCardCheckoutPaymentMethod(body);
    try {
      const providerKey = config.billingProviderDefault || "asaas";
      const result = await startBillingCheckout({
        supabase,
        user,
        planSlug: planSlug || null,
        planKey: planKey || null,
        planId: planId || null,
        paymentMethod,
        providerKey,
        explicitUserAction: true,
        auditRoute: pathNorm,
        auditRequestId: traceId,
        cardCheckout,
      });
      return ok(res, { ok: true, ...result, traceId });
    } catch (e) {
      return respondCheckoutRouteError(res, e, traceId, user.id);
    }
  }

  if (pathNorm === "/api/billing/checkout/start") {
    if (method !== "POST") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST" }, 405, traceId);
    }
    const auth = await requireAuthUser(req);
    if (auth.error) {
      return fail(res, { code: "UNAUTHORIZED", message: auth.error.message }, auth.error.status, traceId);
    }
    const { user, supabase } = auth;
    const body = await readRequestJson(req);
    const planSlug = typeof body.plan_slug === "string" ? body.plan_slug.trim() : "";
    const planKey = typeof body.plan_key === "string" ? body.plan_key.trim() : "";
    const planId = typeof body.plan_id === "string" ? body.plan_id.trim() : "";
    const paymentMethod = typeof body.payment_method === "string" ? body.payment_method.trim() : undefined;

    if (!isExplicitUserAction(body)) {
      return fail(
        res,
        {
          code: "EXPLICIT_USER_ACTION_REQUIRED",
          message: "Informe explicit_user_action: true para criar cobrança (ação do seller).",
        },
        400,
        traceId
      );
    }

    if (!planSlug && !planKey && !planId) {
      return fail(
        res,
        { code: "VALIDATION_ERROR", message: "Informe plan_slug (preferencial), plan_key ou plan_id no corpo JSON." },
        400,
        traceId
      );
    }

    try {
      assertCreditCardCheckoutOnly(paymentMethod, body.card_type);
      const providerKey = config.billingProviderDefault || "asaas";
      const pmRaw = typeof paymentMethod === "string" ? paymentMethod.trim().toUpperCase() : "";
      const paymentMethodNorm =
        pmRaw === "CREDIT_CARD" || pmRaw === "CREDIT" || body.card_type || body.card
          ? resolveCardCheckoutPaymentMethod({ ...body, payment_method: paymentMethod })
          : normalizeCheckoutPaymentMethod(pmRaw || "PIX");
      const cardCheckout =
        paymentMethodNorm === "CREDIT_CARD"
          ? { ...buildCardCheckoutFromRequestBody(body), remoteIp: resolveClientRemoteIp(req) }
          : null;
      const result = await startBillingCheckout({
        supabase,
        user,
        planSlug: planSlug || null,
        planKey: planKey || null,
        planId: planId || null,
        paymentMethod: paymentMethodNorm,
        providerKey,
        explicitUserAction: true,
        auditRoute: pathNorm,
        auditRequestId: traceId,
        cardCheckout,
      });
      return ok(res, { ok: true, ...result, traceId });
    } catch (e) {
      return respondCheckoutRouteError(res, e, traceId, user.id);
    }
  }

  if (pathNorm === "/api/billing/checkout") {
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

    if (!isExplicitUserAction(body)) {
      return fail(
        res,
        {
          code: "EXPLICIT_USER_ACTION_REQUIRED",
          message: "Informe explicit_user_action: true para criar cobrança (ação do seller).",
        },
        400,
        traceId
      );
    }

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
        explicitUserAction: true,
        auditRoute: pathNorm,
        auditRequestId: traceId,
      });
      return ok(res, { ok: true, ...result, traceId });
    } catch (e) {
      return respondCheckoutRouteError(res, e, traceId, user.id);
    }
  }

  if (pathNorm === "/api/billing/payment-methods/card") {
    if (method !== "POST") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST" }, 405, traceId);
    }
    const auth = await requireAuthUser(req);
    if (auth.error) {
      return fail(res, { code: "UNAUTHORIZED", message: auth.error.message }, auth.error.status, traceId);
    }
    const { user, supabase } = auth;
    const body = await readRequestJson(req);
    if (!isExplicitUserAction(body)) {
      return fail(
        res,
        {
          code: "EXPLICIT_USER_ACTION_REQUIRED",
          message: "Informe explicit_user_action: true para salvar o cartão.",
        },
        400,
        traceId
      );
    }
    try {
      const providerApi = getBillingProvider(config.billingProviderDefault || "asaas");
      const remoteIp = resolveClientRemoteIp(req);
      assertCreditCardCheckoutOnly("CREDIT_CARD", body.card_type);
      const saved = await tokenizeAndPersistSellerCard(
        supabase,
        providerApi,
        user,
        {
          holder_name: String(body.holder_name ?? ""),
          card_number: String(body.card_number ?? ""),
          expiry_month: String(body.expiry_month ?? ""),
          expiry_year: String(body.expiry_year ?? ""),
          cvv: String(body.cvv ?? ""),
          cpf_cnpj: typeof body.cpf_cnpj === "string" ? body.cpf_cnpj : undefined,
          postal_code: typeof body.postal_code === "string" ? body.postal_code : undefined,
          address_number: typeof body.address_number === "string" ? body.address_number : undefined,
          phone: typeof body.phone === "string" ? body.phone : undefined,
          card_type: "credit",
          set_default: body.set_default !== false,
          persist: true,
        },
        remoteIp,
        {
          user_id: user.id,
          card_type: "CREDIT",
          request_id: traceId,
        }
      );
      return ok(res, { ok: true, payment_method: saved.paymentMethod, traceId });
    } catch (error) {
      return respondCheckoutRouteError(res, error, traceId, user.id);
    }
  }

  const paymentMethodDefaultMatch = pathNorm.match(/^\/api\/billing\/payment-methods\/([^/]+)\/default$/);
  if (paymentMethodDefaultMatch) {
    if (method !== "POST") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST" }, 405, traceId);
    }
    const auth = await requireAuthUser(req);
    if (auth.error) {
      return fail(res, { code: "UNAUTHORIZED", message: auth.error.message }, auth.error.status, traceId);
    }
    const { user, supabase } = auth;
    try {
      const paymentMethod = await setDefaultSellerPaymentMethod(supabase, user.id, paymentMethodDefaultMatch[1]);
      logBilling("billing", "BILLING_CARD_DEFAULT_SET", { user_id: user.id, payment_method_id: paymentMethodDefaultMatch[1] });
      return ok(res, { ok: true, payment_method: paymentMethod, traceId });
    } catch (error) {
      return respondCheckoutRouteError(res, error, traceId, user.id);
    }
  }

  const paymentMethodDeleteMatch = pathNorm.match(/^\/api\/billing\/payment-methods\/([^/]+)$/);
  if (paymentMethodDeleteMatch && paymentMethodDeleteMatch[1] !== "card") {
    if (method !== "DELETE") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use DELETE" }, 405, traceId);
    }
    const auth = await requireAuthUser(req);
    if (auth.error) {
      return fail(res, { code: "UNAUTHORIZED", message: auth.error.message }, auth.error.status, traceId);
    }
    const { user, supabase } = auth;
    try {
      await deactivateSellerPaymentMethod(supabase, user.id, paymentMethodDeleteMatch[1]);
      return ok(res, { ok: true, traceId });
    } catch (error) {
      return respondCheckoutRouteError(res, error, traceId, user.id);
    }
  }

  if (pathNorm === "/api/billing/payment-methods") {
    if (method !== "GET") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use GET" }, 405, traceId);
    }
    const auth = await requireAuthUser(req);
    if (auth.error) {
      return fail(res, { code: "UNAUTHORIZED", message: auth.error.message }, auth.error.status, traceId);
    }
    const { user, supabase } = auth;
    try {
      const paymentMethods = await listSellerPaymentMethods(supabase, user.id);
      return ok(res, { ok: true, payment_methods: paymentMethods, traceId });
    } catch (error) {
      logBillingError("billing", "payment_methods_list_failed", error, { user_id: user.id });
      return fail(
        res,
        { code: "PAYMENT_METHODS_UNAVAILABLE", message: "Não foi possível carregar as formas de pagamento." },
        500,
        traceId
      );
    }
  }

  const renewalNoticeSeenMatch = pathNorm.match(/^\/api\/billing\/renewals\/([^/]+)\/notice-seen$/);
  if (renewalNoticeSeenMatch) {
    if (method !== "POST") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST" }, 405, traceId);
    }
    const auth = await requireAuthUser(req);
    if (auth.error) {
      return fail(res, { code: "UNAUTHORIZED", message: auth.error.message }, auth.error.status, traceId);
    }
    const { user, supabase } = auth;
    const body = await readRequestJson(req);
    const event = typeof body.event === "string" ? body.event.trim() : "";
    const level = typeof body.level === "string" ? body.level.trim() : null;
    if (!event) {
      return fail(res, { code: "VALIDATION_ERROR", message: "Informe event (popup_shown, popup_dismissed, banner_dismissed)." }, 400, traceId);
    }
    try {
      const result = await recordRenewalNoticeEvent(supabase, {
        userId: user.id,
        renewalCycleId: renewalNoticeSeenMatch[1],
        event,
        level,
      });
      return ok(res, { ok: true, ...result, traceId });
    } catch (error) {
      const code = /** @type {{ code?: string }} */ (error)?.code;
      if (code === "RENEWAL_CYCLE_NOT_FOUND") {
        return fail(res, { code: "RENEWAL_CYCLE_NOT_FOUND", message: "Ciclo de renovação não encontrado." }, 404, traceId);
      }
      if (code === "INVALID_NOTICE_EVENT") {
        return fail(res, { code: "INVALID_NOTICE_EVENT", message: "Evento de notice inválido." }, 400, traceId);
      }
      logBillingError("billing", "renewal_notice_seen_failed", error, { user_id: user.id });
      return fail(res, { code: "NOTICE_STATE_UPDATE_FAILED", message: "Não foi possível registrar o alerta." }, 500, traceId);
    }
  }

  const renewalPayMatch = pathNorm.match(/^\/api\/billing\/renewals\/([^/]+)\/pay$/);
  if (renewalPayMatch) {
    if (method !== "POST") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST" }, 405, traceId);
    }
    const auth = await requireAuthUser(req);
    if (auth.error) {
      return fail(res, { code: "UNAUTHORIZED", message: auth.error.message }, auth.error.status, traceId);
    }
    const { user, supabase } = auth;
    const body = await readRequestJson(req);
    const paymentMethod = typeof body.payment_method === "string" ? body.payment_method.trim() : "";
    if (!paymentMethod) {
      return fail(res, { code: "VALIDATION_ERROR", message: "Informe payment_method (PIX, BOLETO ou CREDIT_CARD)." }, 400, traceId);
    }
    if (body.plan_id != null || body.plan_slug != null || body.plan_key != null) {
      return fail(
        res,
        { code: "PLAN_SELECTION_NOT_ALLOWED", message: "Renovação usa sempre o plano atual da assinatura." },
        400,
        traceId
      );
    }
    if (!isExplicitUserAction(body)) {
      return fail(
        res,
        { code: "EXPLICIT_USER_ACTION_REQUIRED", message: "Informe explicit_user_action: true." },
        400,
        traceId
      );
    }
    try {
      const providerApi = getBillingProvider(config.billingProviderDefault || "asaas");
      const cardCheckout = buildCardCheckoutFromRequestBody(body, user);
      const result = await payRenewalCycle({
        supabase,
        user,
        renewalCycleId: renewalPayMatch[1],
        paymentMethod,
        providerApi,
        remoteIp: resolveClientRemoteIp(req, cardCheckout?.remoteIp),
        paymentMethodId: cardCheckout?.payment_method_id ?? null,
        card: cardCheckout?.card ?? null,
      });
      return ok(res, { ok: true, ...result, traceId });
    } catch (error) {
      const code = /** @type {{ code?: string }} */ (error)?.code;
      if (code === "RENEWAL_CYCLE_NOT_FOUND") {
        return fail(res, { code: "RENEWAL_CYCLE_NOT_FOUND", message: "Ciclo de renovação não encontrado." }, 404, traceId);
      }
      if (code === "RENEWAL_CYCLE_NOT_PAYABLE") {
        return fail(res, { code: "RENEWAL_CYCLE_NOT_PAYABLE", message: "Ciclo não elegível para pagamento." }, 409, traceId);
      }
      if (code === "RENEWAL_PLAN_MISMATCH") {
        return fail(res, { code: "RENEWAL_PLAN_MISMATCH", message: "Plano do ciclo não corresponde à assinatura ativa." }, 409, traceId);
      }
      return respondCheckoutRouteError(res, error, traceId, user.id);
    }
  }

  if (pathNorm === "/api/billing/timeline") {
    if (method !== "GET") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use GET" }, 405, traceId);
    }
    const auth = await requireAuthUser(req);
    if (auth.error) {
      return fail(res, { code: "UNAUTHORIZED", message: auth.error.message }, auth.error.status, traceId);
    }
    const { user, supabase } = auth;
    const url = new URL(req.url || "/", "http://localhost");
    const limitRaw = url.searchParams.get("limit");
    const subscriptionId = url.searchParams.get("subscription_id");
    const limit = limitRaw != null ? Number(limitRaw) : 50;
    try {
      const events = await listBillingTimelineForUser(supabase, user.id, {
        limit: Number.isFinite(limit) ? limit : 50,
        subscriptionId: subscriptionId?.trim() || null,
      });
      return ok(res, { ok: true, timeline: events, read_only: true, traceId });
    } catch (error) {
      logBillingError("billing", "timeline_list_failed", error, { user_id: user.id });
      return fail(res, { code: "TIMELINE_UNAVAILABLE", message: "Não foi possível carregar a timeline financeira." }, 500, traceId);
    }
  }

  if (pathNorm === "/api/billing/revenue-health") {
    if (method !== "GET") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use GET" }, 405, traceId);
    }
    const auth = await requireAuthUser(req);
    if (auth.error) {
      return fail(res, { code: "UNAUTHORIZED", message: auth.error.message }, auth.error.status, traceId);
    }
    const { user, supabase } = auth;
    try {
      const health = await computeRevenueHealthForUser(supabase, user.id, { persist: true });
      return ok(res, { ok: true, revenue_health: health, traceId });
    } catch (error) {
      logBillingError("billing", "revenue_health_failed", error, { user_id: user.id });
      return fail(res, { code: "REVENUE_HEALTH_UNAVAILABLE", message: "Não foi possível calcular a saúde financeira." }, 500, traceId);
    }
  }

  if (pathNorm === "/api/billing/notifications") {
    if (method !== "GET") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use GET" }, 405, traceId);
    }
    const auth = await requireAuthUser(req);
    if (auth.error) {
      return fail(res, { code: "UNAUTHORIZED", message: auth.error.message }, auth.error.status, traceId);
    }
    const { user, supabase } = auth;
    try {
      const notifications = await listBillingNotificationsForUser(supabase, user.id, { limit: 20 });
      return ok(res, { ok: true, notifications, traceId });
    } catch (error) {
      logBillingError("billing", "notifications_list_failed", error, { user_id: user.id });
      return fail(res, { code: "NOTIFICATIONS_UNAVAILABLE", message: "Não foi possível carregar notificações." }, 500, traceId);
    }
  }

  if (pathNorm === "/api/billing/payments") {
    if (method !== "GET") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use GET" }, 405, traceId);
    }
    const auth = await requireAuthUser(req);
    if (auth.error) {
      return fail(res, { code: "UNAUTHORIZED", message: auth.error.message }, auth.error.status, traceId);
    }
    const { user, supabase } = auth;
    try {
      const payments = await listSellerPaymentHistory(supabase, user.id);
      logBilling("billing", "BILLING_PAYMENTS_HISTORY_READ", { user_id: user.id, read_only: true, count: payments.length });
      return ok(res, { ok: true, payments, read_only: true, traceId });
    } catch (error) {
      const errObj = error && typeof error === "object" ? /** @type {{ message?: string; code?: string }} */ (error) : {};
      console.error("[billing/payments] failed", {
        user_id: user.id,
        error_message: errObj.message ?? (error instanceof Error ? error.message : String(error)),
        error_code: errObj.code ?? null,
      });
      logBillingError("billing", "payments_list_failed", error, { user_id: user.id });
      return fail(
        res,
        { code: "PAYMENTS_UNAVAILABLE", message: "Não foi possível carregar o histórico de pagamentos." },
        500,
        traceId
      );
    }
  }

  if (pathNorm === "/api/billing/subscription/reactivate") {
    if (method !== "POST") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST" }, 405, traceId);
    }
    const auth = await requireAuthUser(req);
    if (auth.error) {
      return fail(res, { code: "UNAUTHORIZED", message: auth.error.message }, auth.error.status, traceId);
    }
    const { user, supabase } = auth;
    try {
      const result = await reactivateSubscriptionCancellation({ supabase, user });
      return ok(res, { ok: true, ...result, traceId });
    } catch (error) {
      const code = /** @type {{ code?: string }} */ (error)?.code;
      if (code === "REACTIVATION_NOT_AVAILABLE") {
        return fail(res, { code: "REACTIVATION_NOT_AVAILABLE", message: "Nenhuma assinatura elegível para reativação." }, 404, traceId);
      }
      logBillingError("billing", "subscription_reactivate_failed", error, { user_id: user.id });
      return fail(
        res,
        { code: "SUBSCRIPTION_REACTIVATE_FAILED", message: error instanceof Error ? error.message : "Falha ao reativar assinatura." },
        500,
        traceId
      );
    }
  }

  if (pathNorm === "/api/billing/subscription/change-plan") {
    if (method !== "POST") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST" }, 405, traceId);
    }
    const auth = await requireAuthUser(req);
    if (auth.error) {
      return fail(res, { code: "UNAUTHORIZED", message: auth.error.message }, auth.error.status, traceId);
    }
    const { user, supabase } = auth;
    const body = await readRequestJson(req);
    const targetPlanSlug = typeof body.target_plan_slug === "string" ? body.target_plan_slug.trim() : "";
    const paymentMethod = typeof body.payment_method === "string" ? body.payment_method.trim() : undefined;
    if (!isExplicitUserAction(body)) {
      return fail(
        res,
        {
          code: "EXPLICIT_USER_ACTION_REQUIRED",
          message: "Informe explicit_user_action: true para criar cobrança (ação do seller).",
        },
        400,
        traceId
      );
    }
    try {
      const result = await requestSubscriptionPlanChange({
        supabase,
        user,
        targetPlanSlug,
        paymentMethod: paymentMethod || null,
        providerKey: config.billingProviderDefault || "asaas",
        explicitUserAction: true,
        auditRoute: pathNorm,
        auditRequestId: traceId,
      });
      return ok(res, { ok: true, ...result, traceId });
    } catch (error) {
      const code = /** @type {{ code?: string }} */ (error)?.code;
      if (code === "TARGET_PLAN_SLUG_REQUIRED") {
        return fail(res, { code: "VALIDATION_ERROR", message: "Informe target_plan_slug." }, 400, traceId);
      }
      if (code === "PLAN_NOT_FOUND") {
        return fail(res, { code: "PLAN_NOT_FOUND", message: "Plano não encontrado ou inativo" }, 404, traceId);
      }
      if (code === "TARGET_PLAN_IS_CURRENT") {
        return fail(res, { code: "TARGET_PLAN_IS_CURRENT", message: "O plano selecionado já é o plano atual." }, 409, traceId);
      }
      if (code === "PENDING_CHECKOUT_EXISTS") {
        return fail(
          res,
          {
            code: "PENDING_CHECKOUT_EXISTS",
            message: "Já existe um pagamento pendente para este plano. Conclua o Pix ou aguarde a confirmação.",
            pending_subscription_id: /** @type {{ pending_subscription_id?: string }} */ (error)?.pending_subscription_id ?? null,
          },
          409,
          traceId
        );
      }
      if (code === "ENTERPRISE_PLAN_REQUIRES_SALES") {
        return fail(res, { code: "ENTERPRISE_PLAN_REQUIRES_SALES", message: "Este plano exige contato com o suporte." }, 422, traceId);
      }
      if (code === "CREDIT_CARD_NOT_SUPPORTED_YET") {
        return fail(res, { code: "PAYMENT_METHOD_NOT_SUPPORTED", message: "Cartão de crédito ainda não está habilitado." }, 400, traceId);
      }
      return respondCheckoutRouteError(res, error, traceId, user.id);
    }
  }

  if (pathNorm === "/api/billing/subscription/cancel") {
    if (method !== "POST") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST" }, 405, traceId);
    }
    const auth = await requireAuthUser(req);
    if (auth.error) {
      return fail(res, { code: "UNAUTHORIZED", message: auth.error.message }, auth.error.status, traceId);
    }
    const { user, supabase } = auth;
    try {
      const result = await requestSubscriptionCancellationAtPeriodEnd({ supabase, user });
      return ok(res, { ok: true, ...result, traceId });
    } catch (error) {
      const code = /** @type {{ code?: string }} */ (error)?.code;
      if (code === "NO_ACTIVE_SUBSCRIPTION") {
        return fail(res, { code: "NO_ACTIVE_SUBSCRIPTION", message: "Nenhuma assinatura elegível para cancelamento." }, 404, traceId);
      }
      if (code === "CANCEL_ALREADY_REQUESTED") {
        return fail(res, { code: "CANCEL_ALREADY_REQUESTED", message: "O cancelamento ao fim do ciclo já foi solicitado." }, 409, traceId);
      }
      logBillingError("billing", "subscription_cancel_failed", error, { user_id: user.id });
      return fail(
        res,
        { code: "SUBSCRIPTION_CANCEL_FAILED", message: error instanceof Error ? error.message : "Falha ao solicitar cancelamento." },
        500,
        traceId
      );
    }
  }

  if (pathNorm === "/api/billing/subscription/status") {
    if (method !== "GET") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use GET" }, 405, traceId);
    }
    const auth = await requireAuthUser(req);
    if (auth.error) {
      return fail(res, { code: "UNAUTHORIZED", message: auth.error.message }, auth.error.status, traceId);
    }
    const { user, supabase } = auth;
    const statusLog = (step, payload = {}) => {
      console.info("[S7_BILLING_SUBSCRIPTION_STATUS]", {
        step,
        traceId,
        user_id: user.id,
        ...payload,
      });
    };

    try {
      statusLog("start", {
        has_jwt: true,
        method,
        path: pathNorm,
      });

      let billing;
      try {
        billing = await resolveBillingAccess(supabase, user.id);
        statusLog("billing_access_resolved", {
          can_access: Boolean(billing?.can_access),
          plan_id: billing?.access?.plan_id ?? null,
          subscription_id: billing?.access?.subscription_id ?? null,
          provider: billing?.access?.provider ?? null,
        });
      } catch (error) {
        logBillingError("billing", "subscription_status_failed", error, { user_id: user.id });
        statusLog("billing_access_failed", {
          error: error instanceof Error ? error.message : String(error ?? ""),
        });
        billing = {
          access: {
            can_access: false,
            allowed: false,
            state: "none",
            plan_id: null,
            subscription_id: null,
            subscription_status: null,
            provider: null,
          },
          usage: {
            total_sales_month: 0,
            limit_sales_month: null,
            usage_percent: 0,
            near_limit: false,
          },
          breakdowns: {
            marketplaces: {},
            companies: {},
            accounts: {},
          },
          limits: null,
          plan: null,
          can_access: false,
          billing_cycle_anchor: null,
          current_period_start: null,
          current_period_end: null,
          next_billing_at: null,
          usage_fallback: true,
        };
      }

      const { data: subs, error: subsError } = await supabase
        .from("billing_subscriptions")
        .select(
          "id, plan_id, plan_key, provider, status, amount, currency, current_period_start, current_period_end, next_due_date, canceled_at, metadata, created_at, updated_at, provider_subscription_id"
        )
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(10);

      if (subsError) {
        logBillingError("billing", "subscription_status_list_failed", subsError, { user_id: user.id });
        statusLog("subscriptions_list_failed", { error: subsError.message ?? String(subsError) });
      }

      const subsList = Array.isArray(subs) ? subs : [];
      statusLog("subscriptions_list_ready", { count: subsList.length });

      if (subsList.length === 0 && !billing?.access?.subscription_id) {
        statusLog("subscription_not_found", {
          reason: "subscription_not_found",
        });
        return ok(res, {
          ok: true,
          has_subscription: false,
          status: "none",
          plan: null,
          reason: "subscription_not_found",
          access: billing.access,
          usage: billing.usage,
          breakdowns: billing.breakdowns,
          limits: billing.limits,
          can_access: Boolean(billing.can_access),
          traceId,
        });
      }

      const subscriptions = subsList.map((sub) =>
        enrichSubscriptionDelinquencyFields(
          enrichSubscriptionPlanChangeFields(
            enrichSubscriptionCancellationFields(
              enrichSubscriptionWithBillingCycle(sub, resolveSubscriptionBillingCycle(sub))
            )
          )
        )
      );

      const presentation = resolveSubscriptionPresentation(subscriptions, billing.access?.subscription_id);
      const primarySubscription = presentation.display_subscription ?? subscriptions[0] ?? null;
      const activeSubscription = presentation.active_subscription;
      const pendingCheckout = presentation.pending_checkout;

    let pendingPayment = null;
    if (pendingCheckout?.subscription_id) {
      try {
        const providerApi = getBillingProvider(config.billingProviderDefault || "asaas");
        const payRow = await findPendingCheckoutPaymentRow(supabase, pendingCheckout);
        pendingPayment = await buildPendingPaymentPresentation(providerApi, pendingCheckout, payRow);
      } catch (pendingPayError) {
        logBillingError("billing", "pending_payment_presentation_failed", pendingPayError, {
          user_id: user.id,
          subscription_id: pendingCheckout.subscription_id,
        });
      }
    }

    let overdueInvoiceUrl = null;
    try {
      overdueInvoiceUrl = await findLatestOverduePaymentInvoiceUrl(
        supabase,
        user.id,
        primarySubscription?.id != null ? String(primarySubscription.id) : null
      );
    } catch (invoiceError) {
      logBillingError("billing", "overdue_invoice_lookup_failed", invoiceError, { user_id: user.id });
    }

    let pendingRenewal = null;
    let renewalNotice = null;
    let renewalAccess = null;
    let revenueHealth = null;
    try {
      revenueHealth = await computeRevenueHealthForUser(supabase, user.id, { persist: false });
    } catch (healthErr) {
      logBillingError("billing", "revenue_health_status_failed", healthErr, { user_id: user.id });
    }
    try {
      const activeSub = activeSubscription ? /** @type {Record<string, unknown>} */ (activeSubscription) : null;
      pendingRenewal = await resolvePendingRenewalPresentation(supabase, user.id, activeSub);
      if (activeSub?.id) {
        const openCycle = await findOpenRenewalCycleForSubscription(supabase, String(activeSub.id));
        if (openCycle) {
          const strategyInfo = await resolveRenewalStrategyForSubscription(supabase, activeSub);
          renewalNotice = await computeRenewalNotice(supabase, user.id, activeSub, openCycle, {
            strategy: strategyInfo.strategy,
          });
        }
      }
      renewalAccess = resolveRenewalAccessPresentation(
        renewalNotice,
        billing.access,
        primarySubscription ? /** @type {Record<string, unknown>} */ (primarySubscription) : null
      );
    } catch (pendingRenewalError) {
      logBillingError("billing", "pending_renewal_presentation_failed", pendingRenewalError, { user_id: user.id });
    }

      statusLog("response_sent", {
        has_subscription: true,
        active: Boolean(activeSubscription),
        pending_checkout: Boolean(pendingCheckout),
        subscriptions_count: subscriptions.length,
      });

      return ok(res, {
      ok: true,
      has_subscription: true,
      status: primarySubscription?.status ?? billing.access?.subscription_status ?? null,
      access: billing.access,
      usage: billing.usage,
      breakdowns: billing.breakdowns,
      limits: billing.limits,
      plan: billing.plan,
      can_access: billing.can_access,
      show_usage_growth_notice: Boolean(billing.show_usage_growth_notice),
      usage_growth_grace: billing.usage_growth_grace ?? null,
      billing_cycle_anchor: billing.billing_cycle_anchor ?? null,
      current_period_start: billing.current_period_start ?? null,
      current_period_end: billing.current_period_end ?? null,
      next_billing_at: billing.next_billing_at ?? null,
      cancel_at_period_end: Boolean(primarySubscription?.cancel_at_period_end),
      cancel_requested_at: primarySubscription?.cancel_requested_at ?? null,
      access_ends_at: primarySubscription?.access_ends_at ?? billing.current_period_end ?? null,
      downgrade_target_plan_key: primarySubscription?.downgrade_target_plan_key ?? null,
      plan_change_at_period_end: Boolean(primarySubscription?.plan_change_at_period_end),
      plan_change_requested_at: primarySubscription?.plan_change_requested_at ?? null,
      plan_change_target_plan_slug: primarySubscription?.plan_change_target_plan_slug ?? null,
      plan_change_access_ends_at: primarySubscription?.plan_change_access_ends_at ?? null,
      delinquency_status: primarySubscription?.delinquency_status ?? billing.access?.delinquency_status ?? null,
      overdue_since: primarySubscription?.overdue_since ?? billing.access?.overdue_since ?? null,
      grace_period_ends_at: primarySubscription?.grace_period_ends_at ?? billing.access?.grace_period_ends_at ?? null,
      access_suspended_at: primarySubscription?.access_suspended_at ?? billing.access?.access_suspended_at ?? null,
      delinquency_warning: Boolean(billing.access?.delinquency_warning),
      overdue_invoice_url: overdueInvoiceUrl,
      subscriptions,
      active_subscription: activeSubscription,
      pending_checkout: pendingCheckout
        ? {
            ...pendingCheckout,
            payment: pendingPayment,
          }
        : null,
      pending_renewal: pendingRenewal,
      renewal_notice: renewalNotice,
      subscription_status: renewalAccess?.subscription_status ?? primarySubscription?.renewal_subscription_status ?? null,
      access_status: renewalAccess?.access_status ?? "FULL",
      access_restrictions: renewalAccess?.access_restrictions ?? {
        operational_blocked: false,
        allowed_path_prefixes: [],
        blocked_path_prefixes: [],
        reason: null,
      },
      grace_period_until: primarySubscription?.grace_period_ends_at ?? billing.access?.grace_period_ends_at ?? null,
      revenue_health: revenueHealth,
      traceId,
      });
    } catch (unexpected) {
      const errorId = Date.now();
      statusLog("unexpected_error", {
        errorId,
        error: unexpected instanceof Error ? unexpected.message : String(unexpected ?? ""),
      });
      logBillingError("billing", "subscription_status_unexpected_error", unexpected, { user_id: user.id, errorId });
      return ok(res, {
        ok: true,
        has_subscription: false,
        status: "none",
        plan: null,
        reason: "internal_error",
        errorId,
        traceId,
      });
    }
  }

  if (pathNorm === "/api/billing/payments/refresh") {
    if (method !== "POST") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST" }, 405, traceId);
    }
    const auth = await requireAuthUser(req);
    if (auth.error) {
      return fail(res, { code: "UNAUTHORIZED", message: auth.error.message }, auth.error.status, traceId);
    }
    const { user, supabase } = auth;
    const body = await readRequestJson(req);
    const providerPaymentId =
      typeof body.provider_payment_id === "string" ? body.provider_payment_id.trim() : "";
    if (!providerPaymentId) {
      return fail(res, { code: "VALIDATION_ERROR", message: "Informe provider_payment_id." }, 400, traceId);
    }
    try {
      const providerApi = getBillingProvider(config.billingProviderDefault || "asaas");
      const result = await refreshBillingPaymentFromProvider(supabase, user.id, providerPaymentId, providerApi);
      return ok(res, { ok: true, ...result, traceId });
    } catch (error) {
      const code = /** @type {{ code?: string }} */ (error)?.code;
      if (code === "PAYMENT_NOT_FOUND") {
        return fail(res, { code: "PAYMENT_NOT_FOUND", message: "Cobrança não encontrada." }, 404, traceId);
      }
      logBillingError("billing", "payment_refresh_failed", error, { user_id: user.id });
      return fail(
        res,
        { code: "PAYMENT_REFRESH_FAILED", message: error instanceof Error ? error.message : "Falha ao atualizar cobrança." },
        500,
        traceId
      );
    }
  }

  if (pathNorm === "/api/billing/payments/pix-qr") {
    if (method !== "POST") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST" }, 405, traceId);
    }
    const auth = await requireAuthUser(req);
    if (auth.error) {
      return fail(res, { code: "UNAUTHORIZED", message: auth.error.message }, auth.error.status, traceId);
    }
    const { user, supabase } = auth;
    const body = await readRequestJson(req);
    const providerPaymentId =
      typeof body.provider_payment_id === "string" ? body.provider_payment_id.trim() : "";
    if (!providerPaymentId) {
      return fail(res, { code: "VALIDATION_ERROR", message: "Informe provider_payment_id." }, 400, traceId);
    }
    try {
      const payability = await assertBillingPaymentPayableForUser(supabase, user.id, providerPaymentId);
      if (!payability.ok) {
        const status = payability.code === "PAYMENT_NOT_PAYABLE" ? 409 : 404;
        return fail(res, { code: payability.code, message: payability.message }, status, traceId);
      }
      const providerApi = getBillingProvider(config.billingProviderDefault || "asaas");
      const pix = await fetchPixCheckoutPayload(providerApi, providerPaymentId);
      if (!pix) {
        return fail(res, { code: "PIX_QR_UNAVAILABLE", message: "QR Code Pix indisponível no momento." }, 404, traceId);
      }
      return ok(res, { ok: true, pix, traceId });
    } catch (error) {
      logBillingError("billing", "pix_qr_route_failed", error, { user_id: user.id });
      return fail(res, { code: "PIX_QR_FAILED", message: "Falha ao obter QR Code Pix." }, 502, traceId);
    }
  }

  if (pathNorm === "/api/billing/payments/boleto-details") {
    if (method !== "POST") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST" }, 405, traceId);
    }
    const auth = await requireAuthUser(req);
    if (auth.error) {
      return fail(res, { code: "UNAUTHORIZED", message: auth.error.message }, auth.error.status, traceId);
    }
    const { user, supabase } = auth;
    const body = await readRequestJson(req);
    const providerPaymentId =
      typeof body.provider_payment_id === "string" ? body.provider_payment_id.trim() : "";
    if (!providerPaymentId) {
      return fail(res, { code: "VALIDATION_ERROR", message: "Informe provider_payment_id." }, 400, traceId);
    }
    try {
      const payability = await assertBillingPaymentPayableForUser(supabase, user.id, providerPaymentId);
      if (!payability.ok) {
        const status = payability.code === "PAYMENT_NOT_PAYABLE" ? 409 : 404;
        return fail(res, { code: payability.code, message: payability.message }, status, traceId);
      }

      const { data: payRow } = await supabase
        .from("billing_payments")
        .select("raw_payload")
        .eq("provider", "asaas")
        .eq("provider_payment_id", providerPaymentId)
        .limit(1)
        .maybeSingle();

      const stored = mapPublicBoletoFieldsFromStoredPayload(payRow?.raw_payload);
      if (stored.identification_field) {
        return ok(res, {
          ok: true,
          boleto: {
            identification_field: stored.identification_field,
            bank_slip_url: stored.bank_slip_url,
            invoice_url: stored.invoice_url,
          },
          traceId,
        });
      }

      const providerApi = getBillingProvider(config.billingProviderDefault || "asaas");
      const boleto = await fetchBoletoCheckoutPayload(providerApi, providerPaymentId);
      if (!boleto?.identification_field) {
        return fail(
          res,
          { code: "BOLETO_CODE_UNAVAILABLE", message: "Código do boleto indisponível no momento." },
          404,
          traceId
        );
      }
      return ok(res, { ok: true, boleto, traceId });
    } catch (error) {
      logBillingError("billing", "boleto_details_route_failed", error, { user_id: user.id });
      return fail(res, { code: "BOLETO_DETAILS_FAILED", message: "Falha ao obter dados do boleto." }, 502, traceId);
    }
  }

  if (pathNorm === "/api/billing/dev/process-period-expirations") {
    if (method !== "POST") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST" }, 405, traceId);
    }
    if (!canRunBillingDevMaintenanceRoute(req)) {
      return fail(res, { code: "FORBIDDEN", message: "Rota disponível apenas em DEV/local ou com segredo de job." }, 403, traceId);
    }
    if (!config.supabaseUrl?.trim() || !config.supabaseServiceRoleKey?.trim()) {
      return fail(res, { code: "CONFIG_ERROR", message: "Configuração do banco indisponível" }, 503, traceId);
    }
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const body = await readRequestJson(req);
    const limit = body && typeof body.limit === "number" ? body.limit : undefined;
    try {
      const result = await processBillingPeriodExpirations(supabase, { limit });
      return ok(res, { ok: true, ...result, traceId });
    } catch (error) {
      logBillingError("billing", "process_period_expirations_failed", error, {});
      return fail(
        res,
        { code: "PERIOD_EXPIRATION_FAILED", message: error instanceof Error ? error.message : "Falha ao processar expirações." },
        500,
        traceId
      );
    }
  }

  if (pathNorm === "/api/billing/dev/process-renewals" || pathNorm === "/api/billing/dev/process-renewal-engine") {
    if (method !== "POST") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST" }, 405, traceId);
    }
    if (!canRunBillingDevMaintenanceRoute(req)) {
      return fail(res, { code: "FORBIDDEN", message: "Rota disponível apenas em DEV/local ou com segredo de job." }, 403, traceId);
    }
    if (!config.supabaseUrl?.trim() || !config.supabaseServiceRoleKey?.trim()) {
      return fail(res, { code: "CONFIG_ERROR", message: "Configuração do banco indisponível" }, 503, traceId);
    }
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const body = await readRequestJson(req);
    const limit = body && typeof body.limit === "number" ? body.limit : undefined;
    try {
      const providerApi = getBillingProvider(config.billingProviderDefault || "asaas");
      const result = await processBillingRenewalEngine(supabase, {
        providerApi,
        requestId: traceId,
        jobName:
          pathNorm === "/api/billing/dev/process-renewal-engine"
            ? "billing-dev-renewal-engine"
            : "billing-dev-process-renewals",
        limit,
      });
      return ok(res, { ok: true, ...result, traceId });
    } catch (error) {
      logBillingError("billing", "process_renewals_failed", error, {});
      return fail(
        res,
        { code: "RENEWAL_JOB_FAILED", message: error instanceof Error ? error.message : "Falha ao processar renovações." },
        500,
        traceId
      );
    }
  }

  if (pathNorm === "/api/billing/dev/process-overdues") {
    if (method !== "POST") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST" }, 405, traceId);
    }
    if (!canRunBillingDevMaintenanceRoute(req)) {
      return fail(res, { code: "FORBIDDEN", message: "Rota disponível apenas em DEV/local ou com segredo de job." }, 403, traceId);
    }
    if (!config.supabaseUrl?.trim() || !config.supabaseServiceRoleKey?.trim()) {
      return fail(res, { code: "CONFIG_ERROR", message: "Configuração do banco indisponível" }, 503, traceId);
    }
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const body = await readRequestJson(req);
    const limit = body && typeof body.limit === "number" ? body.limit : undefined;
    try {
      const result = await processBillingOverdues(supabase, { limit });
      return ok(res, { ok: true, ...result, traceId });
    } catch (error) {
      logBillingError("billing", "process_overdues_failed", error, {});
      return fail(
        res,
        { code: "OVERDUE_PROCESSING_FAILED", message: error instanceof Error ? error.message : "Falha ao processar inadimplências." },
        500,
        traceId
      );
    }
  }

  return fail(res, { code: "NOT_FOUND", message: "Rota billing não encontrada" }, 404, traceId);
}
