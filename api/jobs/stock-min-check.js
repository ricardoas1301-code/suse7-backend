// ======================================================================
// JOB /api/jobs/stock-min-check — Verifica estoque mínimo e cria/resolve notificações
// Endpoint interno: protegido por X-Job-Secret (env JOB_SECRET)
//
// Schema usado (adaptar se divergir):
// - products: stock_quantity (estoque atual), min_stock_quantity ou stock_minimum (mínimo)
// - product_variants: stock_quantity (estoque atual), min_stock_quantity ou stock_minimum (mínimo)
// - products.user_id, product_variants.product_id
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../src/infra/config.js";
import { ok, fail, getTraceId } from "../../src/infra/http.js";
import { setCorsHeaders, handlePreflight } from "../../src/lib/cors.js";
import {
  buildDedupeKey,
  shouldOpenIncident,
  shouldResolveIncident,
} from "../../src/domain/StockMinDomainService.js";
import { recordAuditEvent } from "../../src/infra/auditService.js";

const BATCH_SIZE = 100;
const PAGE_SIZE = 50;

/**
 * Obtém min_stock de um row (prioriza min_stock_quantity, fallback stock_minimum)
 */
function getMinStock(row) {
  const v = row.min_stock_quantity ?? row.stock_minimum;
  if (v == null || v === "") return null;
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) || n < 0 ? null : n;
}

/**
 * Obtém estoque atual de um row
 */
function getCurrentStock(row) {
  const v = row.stock_quantity ?? row.stock_real;
  if (v == null || v === "") return 0;
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) || n < 0 ? 0 : n;
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (handlePreflight(req, res)) return;

  if (req.method !== "POST" && req.method !== "GET") {
    const traceId = getTraceId(req);
    return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Método não permitido" }, 405, traceId);
  }

  const traceId = getTraceId(req);
  const jobSecret = config.jobSecret;

  if (jobSecret && req.headers["x-job-secret"] !== jobSecret) {
    return fail(res, { code: "UNAUTHORIZED", message: "Token de job inválido" }, 401, traceId);
  }

  try {
    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    let created = 0;
    let resolved = 0;

    // ------------------------------------------------------------------
    // 1) Produtos simples (format=simple) com min_stock definido
    // ------------------------------------------------------------------
    const { data: simpleProducts } = await supabase
      .from("products")
      .select("id, user_id, stock_quantity, min_stock_quantity, stock_minimum")
      .eq("format", "simple")
      .or("min_stock_quantity.not.is.null,stock_minimum.not.is.null")
      .limit(BATCH_SIZE);

    for (const p of simpleProducts || []) {
      const minStock = getMinStock(p);
      if (minStock == null) continue;

      const currentStock = getCurrentStock(p);
      const dedupeKey = buildDedupeKey({ type: "STOCK_LOW", productId: p.id });

      if (shouldOpenIncident(currentStock, minStock)) {
        const { data: existing } = await supabase
          .from("notifications")
          .select("id")
          .eq("user_id", p.user_id)
          .eq("dedupe_key", dedupeKey)
          .is("resolved_at", null)
          .limit(1)
          .maybeSingle();

        if (!existing) {
          const { data: inserted, error } = await supabase
            .from("notifications")
            .insert({
              user_id: p.user_id,
              type: "STOCK_LOW",
              product_id: p.id,
              variant_id: null,
              variant_key: null,
              payload: {
                currentStock,
                minStock,
                scope: "product",
                productId: p.id,
              },
              dedupe_key: dedupeKey,
            })
            .select("id")
            .single();

          if (!error && inserted) {
            created++;
            try {
              await recordAuditEvent({
                userId: p.user_id,
                entityType: "notification",
                entityId: inserted.id,
                action: "create",
                diff: { before: null, after: { type: "STOCK_LOW", productId: p.id } },
                traceId,
              });
            } catch (e) {
              console.error("[stock-min-check] audit create fail", e);
            }
          }
        }
      } else if (shouldResolveIncident(currentStock, minStock)) {
        const { data: active } = await supabase
          .from("notifications")
          .select("id")
          .eq("user_id", p.user_id)
          .eq("dedupe_key", dedupeKey)
          .is("resolved_at", null)
          .limit(1)
          .maybeSingle();

        if (active) {
          const { error } = await supabase
            .from("notifications")
            .update({ resolved_at: new Date().toISOString() })
            .eq("id", active.id);

          if (!error) {
            resolved++;
            try {
              await recordAuditEvent({
                userId: p.user_id,
                entityType: "notification",
                entityId: active.id,
                action: "update",
                diff: { before: null, after: { resolved_at: new Date().toISOString() } },
                traceId,
              });
            } catch (e) {
              console.error("[stock-min-check] audit resolve fail", e);
            }
          }
        }
      }
    }

    // ------------------------------------------------------------------
    // 2) Variações (product_variants) com min_stock definido
    // ------------------------------------------------------------------
    const { data: userProducts } = await supabase
      .from("products")
      .select("id, user_id")
      .limit(BATCH_SIZE);

    const productIds = (userProducts || []).map((p) => p.id).filter(Boolean);
    if (productIds.length > 0) {
      const { data: variants } = await supabase
        .from("product_variants")
        .select("id, product_id, stock_quantity, min_stock_quantity, stock_minimum")
        .in("product_id", productIds)
        .or("min_stock_quantity.not.is.null,stock_minimum.not.is.null")
        .limit(BATCH_SIZE);

      const productIdsSet = new Map((userProducts || []).map((p) => [p.id, p.user_id]));

      for (const v of variants || []) {
        const minStock = getMinStock(v);
        if (minStock == null) continue;

        const userId = productIdsSet.get(v.product_id);
        if (!userId) continue;

        const currentStock = getCurrentStock(v);
        const dedupeKey = buildDedupeKey({
          type: "STOCK_LOW",
          productId: v.product_id,
          variantId: v.id,
        });

        if (shouldOpenIncident(currentStock, minStock)) {
          const { data: existing } = await supabase
            .from("notifications")
            .select("id")
            .eq("user_id", userId)
            .eq("dedupe_key", dedupeKey)
            .is("resolved_at", null)
            .limit(1)
            .maybeSingle();

          if (!existing) {
            const { data: inserted, error } = await supabase
              .from("notifications")
              .insert({
                user_id: userId,
                type: "STOCK_LOW",
                product_id: v.product_id,
                variant_id: v.id,
                variant_key: null,
                payload: {
                  currentStock,
                  minStock,
                  scope: "variant",
                  productId: v.product_id,
                  variantId: v.id,
                },
                dedupe_key: dedupeKey,
              })
              .select("id")
              .single();

            if (!error && inserted) {
              created++;
              try {
                await recordAuditEvent({
                  userId,
                  entityType: "notification",
                  entityId: inserted.id,
                  action: "create",
                  diff: { before: null, after: { type: "STOCK_LOW", variantId: v.id } },
                  traceId,
                });
              } catch (e) {
                console.error("[stock-min-check] audit create fail", e);
              }
            }
          }
        } else if (shouldResolveIncident(currentStock, minStock)) {
          const { data: active } = await supabase
            .from("notifications")
            .select("id")
            .eq("user_id", userId)
            .eq("dedupe_key", dedupeKey)
            .is("resolved_at", null)
            .limit(1)
            .maybeSingle();

          if (active) {
            const { error } = await supabase
              .from("notifications")
              .update({ resolved_at: new Date().toISOString() })
              .eq("id", active.id);

            if (!error) {
              resolved++;
              try {
                await recordAuditEvent({
                  userId,
                  entityType: "notification",
                  entityId: active.id,
                  action: "update",
                  diff: { before: null, after: { resolved_at: new Date().toISOString() } },
                  traceId,
                });
              } catch (e) {
                console.error("[stock-min-check] audit resolve fail", e);
              }
            }
          }
        }
      }
    }

    return ok(res, {
      ok: true,
      created,
      resolved,
      traceId,
    });
  } catch (err) {
    console.error("[stock-min-check] fail", err);
    return fail(
      res,
      {
        code: "INTERNAL_ERROR",
        message: "Erro interno",
        details: process.env.NODE_ENV === "development" ? String(err?.message) : undefined,
      },
      500,
      traceId
    );
  }
}
