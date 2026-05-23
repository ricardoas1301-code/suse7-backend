// ======================================================
// Dev Center — rotas admin (dashboard, sellers, finance, clientes global)
// Service role: payloads minimizados (LGPD) — e-mail/telefone mascarados em listas.
// ======================================================

import { ok, fail } from "../../infra/http.js";
import { buildDevCenterSellerDetail, buildDevCenterSellersList } from "./devCenterSellersService.js";
import {
  buildDevCenterSubscriptionDetail,
  buildDevCenterSubscriptionsList,
} from "./devCenterSubscriptionsService.js";
import { buildDevCenterFinanceDetail, buildDevCenterFinanceList } from "./devCenterFinanceService.js";
import { getCentralNotificationEngineSummary } from "../../domain/notifications/central/index.js";
import { buildDevCenterCustomersGlobalSummary } from "./devCenterCustomersGlobalOpsSummaryService.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** @param {string | null | undefined} email */
function maskEmailForApi(email) {
  const s = String(email ?? "").trim().toLowerCase();
  if (!s || !s.includes("@")) return null;
  const [box, dom] = s.split("@");
  if (!dom) return "•••";
  const ob = box.length <= 2 ? `${box.slice(0, 1)}•` : `${box.slice(0, 2)}•••${box.slice(-1)}`;
  return `${ob}@${dom}`;
}

/** @param {string | null | undefined} phone */
function maskPhoneForApi(phone) {
  const d = String(phone ?? "").replace(/\D/g, "");
  if (d.length <= 4) return d ? "****" : null;
  return `${d.slice(0, 2)}••••${d.slice(-2)}`;
}

/** @param {string | null | undefined} doc — dígitos normalizados; lista/detalhe admin (LGPD). */
function maskDocumentForApi(doc) {
  const d = String(doc ?? "").replace(/\D/g, "");
  if (d.length < 4) return d ? "****" : null;
  return `••••${d.slice(-4)}`;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} traceId
 */
async function safeCount(supabase, table, traceId) {
  const { count, error } = await supabase.from(table).select("id", { count: "exact", head: true });
  if (error) {
    console.warn("[dev-center-admin] count_failed", { table, message: error.message, traceId });
    return 0;
  }
  return typeof count === "number" && Number.isFinite(count) ? count : 0;
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {string} path
 * @param {string} method
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} traceId
 * @returns {Promise<boolean>} true se respondeu
 */
export async function handleDevCenterAdminRoutes(req, res, path, method, supabase, traceId) {
  if (method !== "GET") return false;

  try {
    if (path === "/api/dev-center/dashboard") {
      const totalSellers = await safeCount(supabase, "profiles", traceId);
      let integracoesMlAtivas = 0;
      let distinctSellerUsers = 0;
      const { data: accRows, error: accErr } = await supabase.from("marketplace_accounts").select("user_id, status");
      if (!accErr && Array.isArray(accRows)) {
        const u = new Set();
        for (const r of accRows) {
          const st = String(r.status ?? "").toLowerCase();
          if (st === "active" || st === "connected" || st === "ok" || st === "") {
            integracoesMlAtivas += 1;
          }
          if (r.user_id) u.add(String(r.user_id));
        }
        distinctSellerUsers = u.size;
      }

      const totalClientesGlobal = await safeCount(supabase, "s7_global_customers", traceId);
      const totalPedidosProcessados = await safeCount(supabase, "sales_orders", traceId);

      const sellersInativos = Math.max(0, totalSellers - distinctSellerUsers);
      const sellersAtivos = distinctSellerUsers;

      ok(res, {
        ok: true,
        summary: {
          totalSellers,
          sellersAtivos,
          sellersInativos,
          mrr: "—",
          receitaTotal: "—",
          totalClientesGlobal,
          totalPedidosProcessados,
          integracoesMlAtivas,
        },
      });
      return true;
    }

    const sellerDetail = path.match(/^\/api\/dev-center\/sellers\/([^/]+)$/);
    if (sellerDetail && UUID_RE.test(sellerDetail[1])) {
      const detail = await buildDevCenterSellerDetail(supabase, sellerDetail[1], traceId);
      if (!detail) {
        fail(res, { code: "NOT_FOUND", message: "Seller não encontrado" }, 404, traceId);
        return true;
      }
      ok(res, { ok: true, ...detail });
      return true;
    }

    if (path === "/api/dev-center/sellers") {
      try {
        const sellers = await buildDevCenterSellersList(supabase, traceId);
        ok(res, { ok: true, sellers });
      } catch (e) {
        console.error("[dev-center-admin] sellers", { message: e?.message, traceId });
        ok(res, { ok: true, sellers: [] });
      }
      return true;
    }

    const subscriptionDetail = path.match(/^\/api\/dev-center\/subscriptions\/([^/]+)$/);
    if (subscriptionDetail && UUID_RE.test(subscriptionDetail[1])) {
      const detail = await buildDevCenterSubscriptionDetail(supabase, subscriptionDetail[1], traceId);
      if (!detail) {
        fail(res, { code: "NOT_FOUND", message: "Assinatura não encontrada" }, 404, traceId);
        return true;
      }
      ok(res, { ok: true, ...detail });
      return true;
    }

    if (path === "/api/dev-center/subscriptions") {
      try {
        const payload = await buildDevCenterSubscriptionsList(supabase, traceId);
        ok(res, { ok: true, ...payload });
      } catch (e) {
        console.error("[dev-center-admin] subscriptions", { message: e?.message, traceId });
        ok(res, {
          ok: true,
          summary: {
            active_subscriptions: 0,
            grace_period: 0,
            past_due: 0,
            trials_active: 0,
            mrr_brl: "—",
            arr_brl: "—",
            churn_risk: 0,
            renewals_upcoming: 0,
          },
          subscriptions: [],
        });
      }
      return true;
    }

    const financeDetail = path.match(/^\/api\/dev-center\/finance\/([^/]+)$/);
    if (financeDetail && UUID_RE.test(financeDetail[1])) {
      const detail = await buildDevCenterFinanceDetail(supabase, financeDetail[1], traceId);
      if (!detail) {
        fail(res, { code: "NOT_FOUND", message: "Registro financeiro não encontrado" }, 404, traceId);
        return true;
      }
      ok(res, { ok: true, ...detail });
      return true;
    }

    if (path === "/api/dev-center/finance") {
      try {
        const payload = await buildDevCenterFinanceList(supabase, traceId);
        ok(res, { ok: true, ...payload });
      } catch (e) {
        console.error("[dev-center-admin] finance", { message: e?.message, traceId });
        ok(res, {
          ok: true,
          summary: {
            mrr_brl: "—",
            arr_brl: "—",
            receita_mes_atual_brl: "—",
            receita_recebida_brl: "—",
            receita_pendente_brl: "—",
            receita_grace_brl: "—",
            receita_risco_brl: "—",
            receita_cancelada_count: 0,
            inadimplencia: 0,
            churn_risco: 0,
            sellers_pagantes: 0,
            trials_ativos: 0,
            renovacoes_proximas: 0,
            ticket_medio_brl: "—",
            assinaturas_ativas: 0,
          },
          observability: {},
          rows: [],
        });
      }
      return true;
    }

    if (path === "/api/dev-center/customers-global") {
      const qRaw = req.query?.q != null ? String(req.query.q).trim().toLowerCase() : "";
      const { data: rows, error } = await supabase
        .from("s7_global_customers")
        .select(
          "id, name, document_normalized, email_normalized, phone_normalized, total_orders_global, total_spent_global, total_sellers_related, last_purchase_global, related_sellers"
        )
        .order("last_purchase_global", { ascending: false, nullsFirst: false })
        .limit(500);
      if (error) {
        if (String(error.code ?? "") === "42P01" || String(error.message ?? "").includes("does not exist")) {
          ok(res, { ok: true, customers: [] });
          return true;
        }
        console.error("[dev-center-admin] customers-global", { message: error.message, traceId });
        fail(res, { code: "DB_ERROR", message: "Erro ao listar clientes globais" }, 500, traceId);
        return true;
      }

      let filtered = rows ?? [];
      if (qRaw) {
        filtered = filtered.filter((r) => {
          const blob = [
            r.name,
            r.document_normalized,
            r.email_normalized,
            r.phone_normalized,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          return blob.includes(qRaw);
        });
      }
      filtered = filtered.slice(0, 200);

      const customers = filtered.map((r) => ({
        id: String(r.id),
        name: r.name ?? null,
        document: r.document_normalized ? maskDocumentForApi(r.document_normalized) : null,
        email: r.email_normalized ? maskEmailForApi(r.email_normalized) : null,
        phone: r.phone_normalized ? maskPhoneForApi(r.phone_normalized) : null,
        city: null,
        state: null,
        total_orders_global: r.total_orders_global ?? 0,
        total_spent_global: r.total_spent_global != null ? String(r.total_spent_global) : "0.00",
        total_sellers_related: r.total_sellers_related ?? 0,
        last_purchase_global: r.last_purchase_global ?? null,
      }));

      // 4A.5 — summary operacional admin global (cross-seller); não mistura escopo seller.
      const summary = await buildDevCenterCustomersGlobalSummary(supabase, {
        listedCount: customers.length,
        traceId,
      });

      ok(res, { ok: true, customers, summary });
      return true;
    }

    if (path === "/api/dev-center/notifications/engine/summary") {
      const url = new URL(req.url || "", `http://${req.headers?.host || "localhost"}`);
      const sellerId = url.searchParams.get("seller_id");
      const hours = Number.parseInt(url.searchParams.get("hours") || "24", 10);
      let summary;
      try {
        summary = await getCentralNotificationEngineSummary(supabase, {
          sellerId: sellerId && UUID_RE.test(sellerId) ? sellerId : null,
          hours: Number.isFinite(hours) ? hours : 24,
        });
      } catch (summaryErr) {
        const msg = summaryErr?.message ?? String(summaryErr);
        if (msg.includes("s7_notification") || msg.includes("does not exist")) {
          ok(res, {
            ok: true,
            engine: "s7_central_notification_engine",
            phase: "3.1",
            migration_pending: true,
            summary: null,
          });
          return true;
        }
        throw summaryErr;
      }
      ok(res, { ok: true, summary });
      return true;
    }

    const detail = path.match(/^\/api\/dev-center\/customers-global\/([^/]+)$/);
    if (detail && UUID_RE.test(detail[1])) {
      const id = detail[1];
      const { data: row, error } = await supabase
        .from("s7_global_customers")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (error || !row) {
        fail(res, { code: "NOT_FOUND", message: "Cliente global não encontrado" }, 404, traceId);
        return true;
      }
      const customer = {
        ...row,
        document_masked: row.document_normalized ? maskDocumentForApi(row.document_normalized) : null,
        email_masked: row.email_normalized ? maskEmailForApi(row.email_normalized) : null,
        phone_masked: row.phone_normalized ? maskPhoneForApi(row.phone_normalized) : null,
      };
      delete customer.document_normalized;
      delete customer.email_normalized;
      delete customer.phone_normalized;
      ok(res, { ok: true, customer });
      return true;
    }
  } catch (e) {
    console.error("[dev-center-admin] fatal", { message: e?.message, traceId });
    fail(res, { code: "INTERNAL", message: "Erro interno" }, 500, traceId);
    return true;
  }

  return false;
}
