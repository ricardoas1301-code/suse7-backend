// ======================================================
// POST /api/dev/sales/:sale_id/refresh-financial-contract
// POST /api/dev/sales/refresh-financial-contracts
// Recalcula marketplace_fee (tarifa/comissão) com Decimal no backend.
// Acesso: NODE_ENV=development OU Dev Center allowlist/admin.
// ======================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { getValidMLToken } from "../ml/_helpers/mlToken.js";
import { ML_MARKETPLACE_SLUG } from "../ml/_helpers/mlMarketplace.js";
import { resolveDevCenterAccess } from "../devCenter/devCenterAccess.js";
import {
  refreshRecentSaleFinancialContracts,
  refreshSaleFinancialContractByItemId,
} from "../../services/sales/saleFinancialContractRefresh.js";

/** @param {import("http").IncomingMessage} req */
function parseBody(req) {
  if (req.body == null) return {};
  if (typeof req.body === "string") {
    try {
      return req.body.trim() ? JSON.parse(req.body) : {};
    } catch {
      return {};
    }
  }
  if (typeof req.body === "object") return /** @type {Record<string, unknown>} */ (req.body);
  return {};
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 */
async function assertDevFinancialRefreshAccess(req, res) {
  const auth = await requireAuthUser(req);
  if (auth.error) {
    res.status(auth.error.status ?? 401).json({ ok: false, error: auth.error.message });
    return null;
  }

  const nodeEnv = process.env.NODE_ENV ?? "";
  const allowDev = nodeEnv === "development";
  const access = await resolveDevCenterAccess(auth.supabase, auth.user);
  if (!allowDev && !access.allowed) {
    res.status(403).json({ ok: false, error: "Acesso negado (somente DEV ou Dev Center)." });
    return null;
  }

  return auth;
}

/**
 * @param {string} path
 */
function extractSaleIdFromPath(path) {
  const m = String(path || "").match(/^\/api\/dev\/sales\/([^/]+)\/refresh-financial-contract$/);
  return m?.[1] != null ? String(m[1]).trim() : "";
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {string} path
 */
export async function handleSaleFinancialContractRefresh(req, res, path) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await assertDevFinancialRefreshAccess(req, res);
  if (!auth) return;

  const pathNorm = String(path || "").replace(/\/+$/, "") || "/";

  if (pathNorm === "/api/dev/sales/refresh-financial-contracts") {
    const body = parseBody(req);
    try {
      const result = await refreshRecentSaleFinancialContracts(auth.supabase, auth.user.id, {
        days: body.days,
        marketplace: body.marketplace,
        limit: body.limit,
      });
      return res.status(200).json(result);
    } catch (e) {
      console.error("[S7 RAYX FEE REFRESH] batch_failed", {
        message: e instanceof Error ? e.message : String(e),
      });
      return res.status(500).json({
        ok: false,
        error: e instanceof Error ? e.message : "Erro ao atualizar contratos financeiros",
      });
    }
  }

  const saleId = extractSaleIdFromPath(pathNorm);
  if (!saleId) {
    return res.status(404).json({ ok: false, error: "Rota não encontrada" });
  }

  try {
    let accessToken = null;
    const { data: item } = await auth.supabase
      .from("sales_order_items")
      .select("marketplace,marketplace_account_id")
      .eq("user_id", auth.user.id)
      .eq("id", saleId)
      .maybeSingle();

    const marketplace = String(item?.marketplace ?? "").trim().toLowerCase();
    if (
      item?.marketplace_account_id &&
      (marketplace === ML_MARKETPLACE_SLUG || marketplace === "mercado_livre" || marketplace === "mercadolivre")
    ) {
      try {
        accessToken = await getValidMLToken(auth.user.id, {
          marketplaceAccountId: String(item.marketplace_account_id).trim(),
        });
      } catch (tokenErr) {
        console.warn("[S7 RAYX FEE REFRESH] ml_token_unavailable", {
          sale_id: saleId,
          message: tokenErr instanceof Error ? tokenErr.message : String(tokenErr),
        });
      }
    }

    const result = await refreshSaleFinancialContractByItemId(auth.supabase, auth.user.id, saleId, {
      accessToken,
    });

    if (!result.ok) {
      return res.status(404).json(result);
    }

    return res.status(200).json(result);
  } catch (e) {
    console.error("[S7 RAYX FEE REFRESH] single_failed", {
      sale_id: saleId,
      message: e instanceof Error ? e.message : String(e),
    });
    return res.status(500).json({
      ok: false,
      error: e instanceof Error ? e.message : "Erro ao atualizar contrato financeiro",
      sale_id: saleId,
    });
  }
}
