// ======================================================================
// GET /api/products/catalog-rankings
// Top 10 por: quantidade de vendas, faturamento (R$), lucro bruto (R$).
// Fonte: RPC public.get_catalog_rankings(p_user_id) quando existir no Supabase;
// caso contrário retorna listas vazias (UI com fallback elegante).
//
// Contrato JSON (cada lista: até 10 itens):
// {
//   top_sales_quantity: [{ product_id, product_name, sku?, value, rank }],
//   top_revenue:        [{ product_id, product_name, sku?, value, rank }],
//   top_profit:         [{ product_id, product_name, sku?, value, rank }],
//   meta?: { source: "rpc" | "fallback_empty" }
// }
// value: número (int para quantidade; decimal para BRL no servidor).
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { ok, fail, getTraceId } from "../../infra/http.js";

const EMPTY = {
  top_sales_quantity: [],
  top_revenue: [],
  top_profit: [],
  meta: { source: "fallback_empty" },
};

function normalizeList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((row, i) => {
      const rank = Number(row?.rank) || i + 1;
      const product_id = row?.product_id != null ? String(row.product_id) : "";
      const product_name = row?.product_name != null ? String(row.product_name) : "—";
      const sku = row?.sku != null ? String(row.sku) : undefined;
      const value = typeof row?.value === "number" && Number.isFinite(row.value) ? row.value : Number(row?.value) || 0;
      return { rank, product_id, product_name, sku, value };
    })
    .filter((r) => r.product_id)
    .slice(0, 10);
}

function mergeRpcPayload(raw) {
  if (raw == null) return { ...EMPTY };
  const obj = typeof raw === "string" ? safeJsonParse(raw) : raw;
  if (!obj || typeof obj !== "object") return { ...EMPTY };

  return {
    top_sales_quantity: normalizeList(obj.top_sales_quantity),
    top_revenue: normalizeList(obj.top_revenue),
    top_profit: normalizeList(obj.top_profit),
    meta: {
      source: "rpc",
      ...(obj.meta && typeof obj.meta === "object" ? obj.meta : {}),
    },
  };
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export async function handleProductsCatalogRankings(req, res) {
  if (req.method !== "GET") {
    const traceId = getTraceId(req);
    return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Método não permitido" }, 405, traceId);
  }

  const traceId = getTraceId(req);

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return fail(res, { code: "UNAUTHORIZED", message: "Token não informado" }, 401, traceId);
    }
    const token = authHeader.slice(7);

    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(token);
    if (authError || !user?.id) {
      return fail(res, { code: "UNAUTHORIZED", message: "Token inválido" }, 401, traceId);
    }

    const { data: rpcData, error: rpcError } = await supabase.rpc("get_catalog_rankings", {
      p_user_id: user.id,
    });

    if (rpcError) {
      if (process.env.NODE_ENV !== "production") {
        console.info(
          "[products/catalog-rankings] RPC get_catalog_rankings indisponível ou não aplicada — usando listas vazias.",
          rpcError.message || rpcError
        );
      }
      return ok(res, { ...EMPTY, meta: { ...EMPTY.meta, hint: rpcError.message } });
    }

    const merged = mergeRpcPayload(rpcData);
    return ok(res, merged);
  } catch (err) {
    console.error("[products/catalog-rankings] fail", err);
    return ok(res, { ...EMPTY, meta: { ...EMPTY.meta, error: String(err?.message || err) } });
  }
}
