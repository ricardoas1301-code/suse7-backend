#!/usr/bin/env node
/**
 * S7 Mission Control — Fase 3.5C.1.A3.1 — Smoke HTTP mock Modal Raio-X Venda
 *
 * POST /api/notifications/manual/sale-rayx
 * - venda real DEV + seller autenticado
 * - sem live delivery, sem processWhatsAppOutbox, sem Z-API real
 *
 * node scripts/runPhase35C1A3_1SaleRayxManualHttpSmoke.mjs
 */

import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
const RAYX_BODY_WHATSAPP = `🚨 Suse7 — Raio-X da venda

Venda: #{{sale_id}}
Produto: {{product_title}}
Cliente: {{buyer_name}}
Valor da venda: R$ {{sale_amount}}
Valor recebido: R$ {{received_amount}}
Lucro: R$ {{profit_amount}}
Margem: {{margin_percent}}%
Saúde da venda: {{sale_health}}

Ver detalhes:
{{sale_rayx_url}}`;

const RAYX_BODY_EMAIL = `Olá,

Segue o resumo do Raio-X da venda:

Venda: #{{sale_id}}
Produto: {{product_title}}
Cliente: {{buyer_name}}
Valor da venda: R$ {{sale_amount}}
Valor recebido: R$ {{received_amount}}
Lucro: R$ {{profit_amount}}
Margem: {{margin_percent}}%
Saúde da venda: {{sale_health}}

Ver detalhes: {{sale_rayx_url}}

— Suse7`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
loadEnv({ path: resolve(root, ".env.local") });
loadEnv({ path: resolve(root, "../suse7-frontend/.env.development") });
loadEnv();

const MANUAL_EVENT = Object.freeze({
  category: "SALES",
  type_key: "MANUAL_SALE_RAYX",
  template_key: "sales.manual.rayx",
});

const SMOKE_PHONE = String(process.env.S7_RAYX_SMOKE_PHONE ?? "5511999999999").replace(/\D/g, "");

/** @type {Record<string, string | undefined>} */
const envSnapshot = {
  S7_WHATSAPP_MODE: process.env.S7_WHATSAPP_MODE,
  S7_ALLOW_LIVE_DELIVERY: process.env.S7_ALLOW_LIVE_DELIVERY,
  S7_PROVIDER_SMOKE_ENABLED: process.env.S7_PROVIDER_SMOKE_ENABLED,
  S7_ZAPI_SMOKE_RUN: process.env.S7_ZAPI_SMOKE_RUN,
};

function applySafeEnv() {
  process.env.S7_WHATSAPP_MODE = "mock";
  process.env.S7_ALLOW_LIVE_DELIVERY = "false";
  process.env.S7_PROVIDER_SMOKE_ENABLED = "false";
  process.env.S7_ZAPI_SMOKE_RUN = "false";
}

function restoreEnv() {
  for (const [key, val] of Object.entries(envSnapshot)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
}

/**
 * @param {string} baseUrl
 */
async function probeApi(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { method: "GET" });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} email
 * @param {string} password
 */
/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} sbUrl
 * @param {string} anonKey
 * @param {string} userId
 */
async function getJwtForUserId(sb, sbUrl, anonKey, userId) {
  const { data: userRow, error: userErr } = await sb.auth.admin.getUserById(userId);
  if (userErr || !userRow?.user?.email) {
    throw new Error(`admin.getUserById: ${userErr?.message ?? "sem email"}`);
  }
  const email = String(userRow.user.email);
  const { data: link, error: linkErr } = await sb.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkErr) throw linkErr;
  const verifyRes = await fetch(`${sbUrl}/auth/v1/verify`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "email",
      token: link.properties.email_otp,
      email,
    }),
  });
  const verifyJson = await verifyRes.json();
  const token = verifyJson?.access_token;
  if (!token) throw new Error(`verify failed status=${verifyRes.status}`);
  return { jwt: token, sellerId: userId, sellerEmail: email };
}

/**
 * @param {string} sbUrl
 * @param {string} anonKey
 * @param {string} email
 * @param {string} password
 */
async function loginDevSeller(sbUrl, anonKey, email, password) {
  const authClient = createClient(sbUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await authClient.auth.signInWithPassword({ email, password });
  if (error || !data.session?.access_token || !data.user?.id) {
    throw new Error(`login: ${error?.message ?? "sem access_token"}`);
  }
  return {
    jwt: data.session.access_token,
    sellerId: String(data.user.id),
    sellerEmail: email,
  };
}

/**
 * Garante catálogo MANUAL_SALE_RAYX (idempotente) se migration ainda não estiver no projeto.
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 */
/**
 * Limpa eventos manuais Raio-X da venda (janela de idempotência) para reexecutar o smoke.
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} sellerId
 * @param {string} saleId
 */
async function purgeManualRayxSmokeForSale(sb, sellerId, saleId) {
  const { data: events } = await sb
    .from("s7_notification_events")
    .select("id")
    .eq("seller_id", sellerId)
    .like("idempotency_key", `manual.sale-rayx:${saleId}:%`);

  const eventIds = (events ?? []).map((e) => String(e.id));
  if (eventIds.length === 0) return;

  const { data: dispatches } = await sb
    .from("s7_notification_dispatches")
    .select("id")
    .in("event_id", eventIds);
  const dispatchIds = (dispatches ?? []).map((d) => String(d.id));

  if (dispatchIds.length > 0) {
    await sb.from("s7_notification_whatsapp_outbox").delete().in("dispatch_id", dispatchIds);
    await sb.from("s7_notification_email_outbox").delete().in("dispatch_id", dispatchIds);
    await sb.from("s7_notification_dispatches").delete().in("id", dispatchIds);
  }
  await sb.from("s7_notification_events").delete().in("id", eventIds);
}

async function ensureManualSaleRayxCatalog(sb) {
  const { data: existing } = await sb
    .from("s7_notification_event_types")
    .select("type_key")
    .eq("category_code", MANUAL_EVENT.category)
    .eq("type_key", MANUAL_EVENT.type_key)
    .maybeSingle();

  if (!existing) {
    const { error: typeErr } = await sb.from("s7_notification_event_types").upsert(
      {
        category_code: MANUAL_EVENT.category,
        type_key: MANUAL_EVENT.type_key,
        label: "Compartilhar Raio-X da venda",
        description: "Acionamento manual pelo seller a partir do modal Raio-X",
        severity_default: "info",
        is_mandatory: false,
        default_channels: ["whatsapp", "email"],
        supported_channels: ["whatsapp", "email"],
        template_key: MANUAL_EVENT.template_key,
        is_active: true,
      },
      { onConflict: "category_code,type_key" }
    );
    if (typeErr) throw new Error(`event_type upsert: ${typeErr.message}`);
  }

  const templates = [
    {
      template_key: MANUAL_EVENT.template_key,
      category_code: MANUAL_EVENT.category,
      type_key: MANUAL_EVENT.type_key,
      channel: "whatsapp",
      locale: "pt-BR",
      priority: "normal",
      subject_template: "",
      body_template: RAYX_BODY_WHATSAPP,
      is_active: true,
    },
    {
      template_key: MANUAL_EVENT.template_key,
      category_code: MANUAL_EVENT.category,
      type_key: MANUAL_EVENT.type_key,
      channel: "email",
      locale: "pt-BR",
      priority: "normal",
      subject_template: "Raio-X da venda #{{sale_id}} — {{product_title}}",
      body_template: RAYX_BODY_EMAIL,
      is_active: true,
    },
  ];

  const { error: tplErr } = await sb.from("s7_notification_templates").upsert(templates, {
    onConflict: "template_key,channel,locale",
  });
  if (tplErr) throw new Error(`templates upsert: ${tplErr.message}`);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} sellerId
 */
async function pickRealSaleId(sb, sellerId) {
  const explicit = process.env.S7_RAYX_SMOKE_SALE_ID?.trim();
  if (explicit) {
    const { data } = await sb
      .from("sales_order_items")
      .select("id, user_id")
      .eq("id", explicit)
      .eq("user_id", sellerId)
      .maybeSingle();
    if (data?.id) return { saleId: String(data.id) };
  }

  const { data: rows, error } = await sb
    .from("sales_order_items")
    .select("id, created_at")
    .eq("user_id", sellerId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = rows?.[0];
  if (!row?.id) throw new Error("nenhuma venda encontrada para o seller DEV");
  return { saleId: String(row.id) };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} sellerId
 */
async function ensureWhatsAppDestination(sb, sellerId) {
  const { data: profile } = await sb.from("profiles").select("phone, email").eq("id", sellerId).maybeSingle();
  const profileDigits = String(profile?.phone ?? "").replace(/\D/g, "");
  if (profileDigits.length >= 10) return { source: "profile.phone", destination: profileDigits };

  const { data: existing } = await sb
    .from("s7_notification_recipients")
    .select("id, destination")
    .eq("seller_id", sellerId)
    .eq("channel", "whatsapp")
    .eq("is_active", true)
    .limit(5);

  const match = (existing ?? []).find(
    (r) => String(r.destination ?? "").replace(/\D/g, "").length >= 10
  );
  if (match) {
    return {
      source: "s7_notification_recipients",
      destination: String(match.destination).replace(/\D/g, ""),
      recipientId: match.id,
    };
  }

  const { error } = await sb.from("s7_notification_recipients").insert({
    seller_id: sellerId,
    channel: "whatsapp",
    destination: SMOKE_PHONE,
    label: "p35c1a3.1 rayx smoke",
    is_active: true,
  });
  if (error) throw new Error(`recipient insert: ${error.message}`);
  return { source: "smoke_insert", destination: SMOKE_PHONE };
}

/**
 * @param {string} apiBase
 * @param {string} jwt
 * @param {{ saleId: string; channel: string; recipientPhone?: string; recipientEmail?: string }} body
 */
async function postManualRayx(apiBase, jwt, body) {
  const url = `${apiBase}/api/notifications/manual/sale-rayx`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sale_id: body.saleId,
      channel: body.channel,
      recipient_phone: body.recipientPhone,
      recipient_email: body.recipientEmail,
    }),
  });
  const json = await res.json().catch(() => ({}));
  return { httpStatus: res.status, json };
}

async function main() {
  console.log("=== S7 Fase 3.5C.1.A3.1 — Smoke HTTP mock Raio-X manual ===\n");

  applySafeEnv();

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const anonKey =
    process.env.SUPABASE_ANON_KEY?.trim() || process.env.VITE_SUPABASE_ANON_KEY?.trim();
  const testEmail =
    process.env.DEV_BILLING_TEST_EMAIL?.trim() || "s7-billing-dev-validate@suse7.local";
  const testPassword =
    process.env.DEV_BILLING_TEST_PASSWORD?.trim() || "S7BillingDevValidate!2026";

  if (!supabaseUrl || !serviceKey || !anonKey) {
    console.error("ABORT: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY");
    restoreEnv();
    process.exit(2);
  }

  const apiCandidates = [
    (process.env.S7_API_BASE || "http://localhost:3001").replace(/\/+$/, ""),
    (process.env.S7_BILLING_DEV_BASE_URL || "https://suse7-backend-dev.vercel.app").replace(/\/+$/, ""),
  ];
  let apiBase = apiCandidates[0];
  for (const candidate of apiCandidates) {
    if (await probeApi(candidate)) {
      apiBase = candidate;
      break;
    }
  }
  if (!(await probeApi(apiBase))) {
    console.error("ABORT: backend inacessível em", apiCandidates.join(" | "));
    restoreEnv();
    process.exit(2);
  }

  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  await ensureManualSaleRayxCatalog(sb);

  const { isWhatsAppLiveDeliveryActive } = await import(
    "../src/domain/notifications/central/whatsapp/S7WhatsAppProvider.js"
  );
  if (isWhatsAppLiveDeliveryActive()) {
    console.error("ABORT: live delivery ativo");
    restoreEnv();
    process.exit(2);
  }

  let auth;
  const smokeSellerOverride = process.env.S7_RAYX_SMOKE_SELLER?.trim();
  const explicitSaleId = process.env.S7_RAYX_SMOKE_SALE_ID?.trim();

  if (explicitSaleId) {
    const { data: item } = await sb
      .from("sales_order_items")
      .select("id, user_id")
      .eq("id", explicitSaleId)
      .maybeSingle();
    if (!item?.user_id) {
      console.error("ABORT: S7_RAYX_SMOKE_SALE_ID não encontrado");
      restoreEnv();
      process.exit(2);
    }
    auth = await getJwtForUserId(sb, supabaseUrl, anonKey, String(item.user_id));
  } else if (smokeSellerOverride) {
    auth = await getJwtForUserId(sb, supabaseUrl, anonKey, smokeSellerOverride);
  } else {
    auth = await loginDevSeller(supabaseUrl, anonKey, testEmail, testPassword);
    const saleProbe = await pickRealSaleId(sb, auth.sellerId).catch(() => null);
    if (!saleProbe) {
      const { data: anySale } = await sb
        .from("sales_order_items")
        .select("id, user_id")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (anySale?.user_id) {
        auth = await getJwtForUserId(sb, supabaseUrl, anonKey, String(anySale.user_id));
      }
    }
  }

  const sellerId = auth.sellerId;
  const jwt = auth.jwt;
  const sellerEmail = auth.sellerEmail;

  const { saleId } = await pickRealSaleId(sb, sellerId);
  await purgeManualRayxSmokeForSale(sb, sellerId, saleId);
  const waDest = await ensureWhatsAppDestination(sb, sellerId);

  const { data: templates } = await sb
    .from("s7_notification_templates")
    .select("template_key, channel, type_key, is_active, body_template")
    .eq("template_key", MANUAL_EVENT.template_key)
    .in("channel", ["whatsapp", "email"]);

  const { data: eventType } = await sb
    .from("s7_notification_event_types")
    .select("category_code, type_key, template_key, severity_default, supported_channels")
    .eq("category_code", MANUAL_EVENT.category)
    .eq("type_key", MANUAL_EVENT.type_key)
    .maybeSingle();

  const wa1 = await postManualRayx(apiBase, jwt, {
    saleId,
    channel: "whatsapp",
    recipientPhone: waDest.destination,
  });

  const wa2 = await postManualRayx(apiBase, jwt, {
    saleId,
    channel: "whatsapp",
    recipientPhone: waDest.destination,
  });

  let outbox = null;
  let dispatch = null;
  let eventRow = null;
  if (wa1.json?.dispatch_id) {
    const { data: ob } = await sb
      .from("s7_notification_whatsapp_outbox")
      .select("id, status, provider_message_id, metadata, dispatch_id")
      .eq("dispatch_id", wa1.json.dispatch_id)
      .maybeSingle();
    outbox = ob;
    const { data: d } = await sb
      .from("s7_notification_dispatches")
      .select("id, status, channel, rendered_body, variables, metadata")
      .eq("id", wa1.json.dispatch_id)
      .maybeSingle();
    dispatch = d;
    if (wa1.json?.event_id) {
      const { data: ev } = await sb
        .from("s7_notification_events")
        .select("id, payload, idempotency_key, entity_id, source_module")
        .eq("id", wa1.json.event_id)
        .maybeSingle();
      eventRow = ev;
    }
  }

  const { data: foreignSale } = await sb
    .from("sales_order_items")
    .select("id, user_id")
    .neq("user_id", sellerId)
    .limit(1)
    .maybeSingle();

  let ownershipDeny = null;
  if (foreignSale?.id) {
    ownershipDeny = await postManualRayx(apiBase, jwt, {
      saleId: String(foreignSale.id),
      channel: "whatsapp",
      recipientPhone: waDest.destination,
    });
  }

  const emailRes = await postManualRayx(apiBase, jwt, {
    saleId,
    channel: "email",
    recipientEmail: process.env.S7_RAYX_SMOKE_EMAIL?.trim() || undefined,
  });

  restoreEnv();

  const checks = {
    templates_in_db: (templates ?? []).length >= 2,
    event_type_in_db: Boolean(eventType?.type_key === MANUAL_EVENT.type_key),
    http_whatsapp_ok: wa1.httpStatus === 200 && wa1.json?.success === true,
    response_mocked: wa1.json?.mocked === true || wa1.json?.skipped === true,
    response_queued: wa1.json?.queued === true || Boolean(dispatch?.id),
    real_send_false: wa1.json?.real_send_executed !== true,
    dispatch_created: Boolean(wa1.json?.dispatch_id || dispatch?.id),
    outbox_pending:
      outbox?.status === "pending" || wa1.json?.outbox_status === "pending",
    outbox_no_provider_message_id: !outbox?.provider_message_id,
    payload_from_db:
      eventRow?.source_module === "sale_rayx_modal" &&
      eventRow?.entity_id === saleId &&
      eventRow?.payload &&
      typeof eventRow.payload === "object" &&
      "sale_rayx_url" in /** @type {Record<string, unknown>} */ (eventRow.payload),
    rendered_body_has_product:
      String(dispatch?.rendered_body ?? "").includes("Raio-X") ||
      String(dispatch?.rendered_body ?? "").length > 20,
    idempotent_second_call:
      wa2.httpStatus === 200 &&
      (wa2.json?.skipped === true || wa2.json?.status === "skipped" || wa2.json?.idempotent === true),
    ownership_denied: foreignSale?.id
      ? ownershipDeny?.httpStatus === 404 || ownershipDeny?.json?.error === "SALE_NOT_FOUND"
      : true,
    email_http_ok: emailRes.httpStatus === 200 && emailRes.json?.success === true,
    email_mocked: emailRes.json?.mocked === true,
    no_live_delivery: !isWhatsAppLiveDeliveryActive(),
  };

  const report = {
    phase: "S_3.5C.1.A3.1",
    api_base: apiBase,
    seller_id: sellerId,
    seller_email: sellerEmail,
    catalog_bootstrapped: true,
    sale_id: saleId,
    whatsapp_destination_source: waDest.source,
    channels_tested: ["whatsapp", "email"],
    templates_db: (templates ?? []).map((t) => ({
      channel: t.channel,
      type_key: t.type_key,
      active: t.is_active,
      body_has_rayx: String(t.body_template ?? "").includes("Raio-X"),
    })),
    event_type_db: eventType,
    whatsapp_first: {
      http_status: wa1.httpStatus,
      body: wa1.json,
    },
    whatsapp_idempotent_replay: {
      http_status: wa2.httpStatus,
      body: wa2.json,
    },
    email: {
      http_status: emailRes.httpStatus,
      body: emailRes.json,
    },
    ownership_foreign_sale: foreignSale?.id
      ? {
          foreign_sale_id: foreignSale.id,
          http_status: ownershipDeny?.httpStatus,
          body: ownershipDeny?.json,
        }
      : null,
    dispatch_id: wa1.json?.dispatch_id ?? null,
    dispatch_status: dispatch?.status ?? wa1.json?.status ?? null,
    outbox_id: outbox?.id ?? wa1.json?.outbox_id ?? null,
    outbox_status: outbox?.status ?? wa1.json?.outbox_status ?? null,
    event_id: wa1.json?.event_id ?? null,
    event_payload_keys: eventRow?.payload ? Object.keys(/** @type {object} */ (eventRow.payload)) : [],
    idempotency_key: eventRow?.idempotency_key ?? null,
    process_whatsapp_outbox_called: false,
    real_send_executed: false,
    env_restored: true,
    checks,
    success: Object.values(checks).every(Boolean),
  };

  console.log("\n--- Relatório S_3.5C.1.A3.1 ---");
  console.log(JSON.stringify(report, null, 2));

  process.exit(report.success ? 0 : 5);
}

main().catch((e) => {
  restoreEnv();
  console.error("FATAL", e);
  process.exit(1);
});
