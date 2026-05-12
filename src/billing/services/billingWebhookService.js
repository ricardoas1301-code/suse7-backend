// ======================================================================
// billingWebhookService — Asaas (idempotência + regras de negócio)
// ======================================================================

import { readRequestBodyBuffer } from "../../infra/readRequestBodyBuffer.js";
import { normalizeAsaasWebhook } from "../utils/normalizeAsaasWebhook.js";
import { decimalToScale2String, toDecimal } from "../utils/moneyDecimal.js";
import { logBilling, logBillingError } from "../billingLog.js";

/**
 * @param {import("http").IncomingMessage & { body?: unknown; bodyBuffer?: Buffer }} req
 */
export function validateAsaasWebhookToken(req, expectedToken) {
  const exp = String(expectedToken || "").trim();
  if (!exp) return false;

  const h1 = req.headers["asaas-access-token"] || req.headers["Asaas-Access-Token"];
  if (typeof h1 === "string" && h1.trim() === exp) return true;

  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ") && auth.slice(7).trim() === exp) return true;

  const rawPath = typeof req.url === "string" ? req.url : "";
  try {
    const host = req.headers?.host ? String(req.headers.host) : "localhost";
    const base = rawPath.startsWith("http") ? rawPath : `http://${host}${rawPath.startsWith("/") ? rawPath : `/${rawPath}`}`;
    const u = new URL(base);
    const q = u.searchParams.get("access_token");
    if (q && q.trim() === exp) return true;
  } catch {
    /* ignore */
  }

  return false;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} payment
 */
async function resolveUserAndSubscription(supabase, payment) {
  const subRaw = payment.subscription;
  const subAsaas =
    typeof subRaw === "string"
      ? subRaw.trim()
      : subRaw && typeof subRaw === "object" && typeof /** @type {{ id?: unknown }} */ (subRaw).id === "string"
        ? String(/** @type {{ id?: string }} */ (subRaw).id).trim()
        : "";

  if (subAsaas) {
    const { data } = await supabase
      .from("billing_subscriptions")
      .select("id, user_id")
      .eq("provider", "asaas")
      .eq("provider_subscription_id", subAsaas)
      .maybeSingle();
    if (data?.user_id) {
      return { userId: String(data.user_id), subscriptionId: data.id != null ? String(data.id) : null };
    }
  }

  const cust =
    typeof payment.customer === "string"
      ? payment.customer.trim()
      : payment.customer && typeof payment.customer === "object" && typeof /** @type {{ id?: unknown }} */ (payment.customer).id === "string"
        ? String(/** @type {{ id?: string }} */ (payment.customer).id).trim()
        : "";

  if (!cust) {
    return { userId: null, subscriptionId: null };
  }

  const { data: bc } = await supabase
    .from("billing_customers")
    .select("user_id")
    .eq("provider", "asaas")
    .eq("provider_customer_id", cust)
    .maybeSingle();
  if (!bc?.user_id) return { userId: null, subscriptionId: null };

  const { data: sub2 } = await supabase
    .from("billing_subscriptions")
    .select("id")
    .eq("user_id", bc.user_id)
    .eq("provider", "asaas")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return { userId: String(bc.user_id), subscriptionId: sub2?.id != null ? String(sub2.id) : null };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} provider
 * @param {Record<string, unknown>} payment
 * @param {string | null} userId
 * @param {string | null} subscriptionId
 * @param {string | null} eventType
 */
async function upsertBillingPaymentRow(supabase, provider, payment, userId, subscriptionId, eventType) {
  const payId = typeof payment.id === "string" ? payment.id.trim() : "";
  if (!payId || !userId) return;

  const amount = payment.value != null ? decimalToScale2String(toDecimal(payment.value)) : null;
  const paidAt =
    typeof payment.confirmedDate === "string"
      ? payment.confirmedDate
      : typeof payment.clientPaymentDate === "string"
        ? payment.clientPaymentDate
        : typeof payment.paymentDate === "string"
          ? payment.paymentDate
          : null;

  const row = {
    user_id: userId,
    subscription_id: subscriptionId,
    provider,
    provider_payment_id: payId,
    status: typeof payment.status === "string" ? payment.status : null,
    amount,
    currency: "BRL",
    event_type_snapshot: eventType,
    paid_at: paidAt,
    raw_payload: payment,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("billing_payments").upsert(row, { onConflict: "provider,provider_payment_id" });
  if (error) {
    logBillingError("webhook", "billing_payments_upsert_failed", error, { provider_payment_id: payId });
    throw error;
  }
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {import("http").IncomingMessage & { body?: unknown; bodyBuffer?: Buffer }} req
 * @param {string} expectedWebhookToken
 */
export async function handleAsaasWebhookRequest(supabase, req, expectedWebhookToken) {
  if (!validateAsaasWebhookToken(req, expectedWebhookToken)) {
    return { ok: false, status: 401, body: { ok: false, error: "Webhook não autorizado" } };
  }

  let rawObj = /** @type {Record<string, unknown>} */ ({});
  try {
    const buf = await readRequestBodyBuffer(req);
    const raw = buf.toString("utf8").trim();
    if (raw) {
      const parsed = JSON.parse(raw);
      rawObj = typeof parsed === "object" && parsed != null && !Array.isArray(parsed) ? parsed : {};
    } else if (req.body != null && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
      rawObj = /** @type {Record<string, unknown>} */ (req.body);
    }
  } catch (e) {
    logBillingError("webhook", "invalid_json", e, {});
    return { ok: false, status: 400, body: { ok: false, error: "JSON inválido" } };
  }

  const norm = normalizeAsaasWebhook(rawObj);
  const provider = "asaas";
  const providerEventId = norm.providerEventId || `anon:${Date.now()}`;

  const insertRow = {
    provider,
    provider_event_id: providerEventId,
    event_type: norm.eventType,
    payload: rawObj,
    processed: false,
  };

  const { data: inserted, error: insErr } = await supabase
    .from("billing_webhook_events")
    .insert(insertRow)
    .select("id")
    .maybeSingle();

  const dup =
    insErr &&
    (insErr.code === "23505" ||
      String(insErr.message || "")
        .toLowerCase()
        .includes("duplicate"));
  if (dup) {
    logBilling("webhook", "duplicate_ignored", { provider_event_id: providerEventId });
    return { ok: true, status: 200, body: { ok: true, duplicate: true } };
  }
  if (insErr) {
    logBillingError("webhook", "insert_webhook_event_failed", insErr, {});
    return { ok: false, status: 500, body: { ok: false, error: "Falha ao registrar evento" } };
  }

  const webhookRowId =
    inserted && typeof inserted === "object" && "id" in inserted && inserted.id != null
      ? String(/** @type {{ id: unknown }} */ (inserted).id)
      : null;

  /** @type {string | null} */
  let errMsg = null;

  try {
    if (!norm.supported || !norm.eventType) {
      errMsg = norm.eventType ? `event_not_handled:${norm.eventType}` : "missing_event_type";
    } else if (!norm.payment || !norm.paymentId) {
      errMsg = "missing_payment_payload";
    } else {
      const { userId, subscriptionId } = await resolveUserAndSubscription(supabase, norm.payment);
      await upsertBillingPaymentRow(supabase, provider, norm.payment, userId, subscriptionId, norm.eventType);

      const subAsaas =
        typeof norm.payment.subscription === "string"
          ? norm.payment.subscription.trim()
          : norm.payment.subscription &&
              typeof norm.payment.subscription === "object" &&
              typeof /** @type {{ id?: unknown }} */ (norm.payment.subscription).id === "string"
            ? String(/** @type {{ id?: string }} */ (norm.payment.subscription).id).trim()
            : "";

      switch (norm.eventType) {
        case "PAYMENT_RECEIVED": {
          if (subAsaas) {
            await supabase
              .from("billing_subscriptions")
              .update({ status: "active", updated_at: new Date().toISOString() })
              .eq("provider", "asaas")
              .eq("provider_subscription_id", subAsaas);
          }
          break;
        }
        case "PAYMENT_OVERDUE": {
          if (subAsaas) {
            await supabase
              .from("billing_subscriptions")
              .update({ status: "past_due", updated_at: new Date().toISOString() })
              .eq("provider", "asaas")
              .eq("provider_subscription_id", subAsaas);
          }
          break;
        }
        case "PAYMENT_REFUNDED": {
          if (subAsaas) {
            await supabase
              .from("billing_subscriptions")
              .update({ status: "refunded", updated_at: new Date().toISOString() })
              .eq("provider", "asaas")
              .eq("provider_subscription_id", subAsaas);
          }
          break;
        }
        default:
          break;
      }
    }
  } catch (e) {
    errMsg = e instanceof Error ? e.message : String(e);
    logBillingError("webhook", "processing_failed", e, { provider_event_id: providerEventId });
  }

  if (webhookRowId) {
    await supabase
      .from("billing_webhook_events")
      .update({
        processed: true,
        error_message: errMsg,
      })
      .eq("id", webhookRowId);
  }

  return { ok: true, status: 200, body: { ok: true, processed: true, warning: errMsg } };
}
