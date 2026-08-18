// ======================================================================
// POST /api/products/costs/batch — salva custos de vários produtos
// Delega cada item ao domínio canônico persistProductCostsForUser
// ======================================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import {
  isValidProductId,
  persistProductCostsForUser,
  validateProductCostsPayload,
} from "../../domain/products/persistProductCosts.js";

const MAX_BATCH_ITEMS = Math.min(
  50,
  Math.max(5, parseInt(process.env.S7_PRODUCT_COSTS_BATCH_MAX || "30", 10) || 30)
);

export async function handleProductsCostsBatchSave(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    return res.status(400).json({ ok: false, error: "JSON inválido" });
  }

  const itemsIn = Array.isArray(body.items) ? body.items : [];
  if (itemsIn.length === 0) {
    return res.status(400).json({ ok: false, error: "items deve ser um array não vazio" });
  }
  if (itemsIn.length > MAX_BATCH_ITEMS) {
    return res.status(400).json({
      ok: false,
      error: `Limite de ${MAX_BATCH_ITEMS} produtos por requisição`,
    });
  }

  /** @type {Array<{ product_id: string; catalog_completeness?: string }>} */
  const saved = [];
  /** @type {Array<{ product_id: string; code: string; message: string; field?: string }>} */
  const failed = [];

  /** @type {Set<string>} */
  const seen = new Set();

  for (const rawItem of itemsIn) {
    const productId =
      rawItem?.product_id != null
        ? String(rawItem.product_id).trim()
        : rawItem?.productId != null
          ? String(rawItem.productId).trim()
          : "";

    if (!productId) {
      failed.push({ product_id: "", code: "INVALID_INPUT", message: "product_id obrigatório" });
      continue;
    }

    if (seen.has(productId)) continue;
    seen.add(productId);

    if (!isValidProductId(productId)) {
      failed.push({ product_id: productId, code: "INVALID_INPUT", message: "product_id inválido" });
      continue;
    }

    const validation = validateProductCostsPayload({
      cost_price: rawItem?.cost_price ?? rawItem?.product_cost,
      packaging_cost: rawItem?.packaging_cost,
      operational_cost: rawItem?.operational_cost,
    });

    if (!validation.ok) {
      failed.push({
        product_id: productId,
        code: validation.code || "VALIDATION_ERROR",
        message: validation.message || "Custos inválidos",
        ...(validation.field ? { field: validation.field } : {}),
      });
      continue;
    }

    const result = await persistProductCostsForUser({
      supabase,
      userId: user.id,
      productId,
      costs: validation.costs,
    });

    if (!result.ok) {
      failed.push({
        product_id: productId,
        code: result.code || "SAVE_FAILED",
        message: result.message || "Não foi possível salvar",
      });
      continue;
    }

    saved.push({ product_id: productId, catalog_completeness: result.catalog_completeness });
  }

  return res.status(200).json({
    ok: true,
    saved,
    failed,
    total_received: itemsIn.length,
    total_saved: saved.length,
    total_failed: failed.length,
  });
}
