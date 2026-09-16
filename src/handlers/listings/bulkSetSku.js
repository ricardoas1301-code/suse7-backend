// ======================================================================
// POST /api/listings/bulk-set-sku
// Handler fino — lógica em ./bulkSetSkuService.js
//
// Payload canônico do frontend (unitário e lote):
// {
//   "marketplace": "mercado_livre",
//   "items": [{ "listing_id": "uuid-…", "sku": "0170" }]
// }
//
// Payload legado ainda aceito:
// {
//   "marketplace": "mercado_livre",
//   "listing_ids": ["uuid-…", "MLB123…", "660321858"],
//   "sku": "33k"
// }
//
// Exemplo 200:
// {
//   "ok": true,
//   "total_received": 3,
//   "total_updated": 3,
//   "total_skipped": 0,
//   "errors": [],
//   "product_id": "uuid",
//   "normalized_sku": "33K",
//   "sku_literal": "33k"
// }
//
// Exemplo 422 (SKU inexistente no catálogo):
// {
//   "ok": false,
//   "error": "Não existe produto no seu catálogo…",
//   "total_received": 3,
//   "total_updated": 0,
//   "total_skipped": 3,
//   "normalized_sku": "33K",
//   "sku_literal": "33k",
//   "errors": []
// }
// ======================================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { ML_MARKETPLACE_SLUG } from "../ml/_helpers/mlMarketplace.js";
import { ATTENTION_REASON_SKU_PENDING_ML } from "../ml/_helpers/mlItemSkuExtract.js";
import { executeBulkSetSku } from "./bulkSetSkuService.js";
import { parseBulkSetSkuPayload } from "./parseBulkSetSkuPayload.js";

const MAX_LISTING_IDS = Math.min(
  200,
  Math.max(10, parseInt(process.env.S7_BULK_SET_SKU_MAX_LISTINGS || "100", 10) || 100)
);

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
function resolveCanonicalMarketplace(raw) {
  const s = raw != null ? String(raw).trim().toLowerCase() : "";
  if (!s) return null;
  if (s === ML_MARKETPLACE_SLUG || s === "mercadolivre") return ML_MARKETPLACE_SLUG;
  return null;
}

export default async function handleListingsBulkSetSku(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    return res.status(400).json({ ok: false, error: "JSON inválido" });
  }

  if (body.marketplace == null || String(body.marketplace).trim() === "") {
    return res.status(400).json({ ok: false, error: "Marketplace obrigatório." });
  }

  const marketplaceRaw = String(body.marketplace).trim();
  const canonicalMarketplace = resolveCanonicalMarketplace(marketplaceRaw);
  if (!canonicalMarketplace) {
    return res.status(400).json({
      ok: false,
      error: "Marketplace inválido ou não suportado nesta versão.",
      supported: [ML_MARKETPLACE_SLUG, "mercadolivre"],
    });
  }

  const parsed = parseBulkSetSkuPayload(body);
  const listingTokens = parsed.allListingTokens;

  if (listingTokens.length === 0) {
    return res.status(400).json({
      ok: false,
      error: parsed.mode === "items" ? "Informe ao menos um listing_id válido." : "listing_ids deve ser um array não vazio.",
    });
  }

  if (listingTokens.length > MAX_LISTING_IDS) {
    return res.status(400).json({
      ok: false,
      error: `Limite de ${MAX_LISTING_IDS} anúncios por operação.`,
      max: MAX_LISTING_IDS,
    });
  }

  const groupsWithSku = parsed.groups.filter((g) => g.skuRaw);
  const groupsEmptySku = parsed.groups.filter((g) => !g.skuRaw && g.listingTokens.length > 0);
  if (groupsWithSku.length === 0 || groupsEmptySku.length > 0) {
    return res.status(400).json({ ok: false, error: "SKU obrigatório." });
  }

  const { user, supabase } = auth;
  const userId = user.id;

  /** @type {Awaited<ReturnType<typeof executeBulkSetSku>>} */
  let result;
  if (groupsWithSku.length === 1) {
    result = await executeBulkSetSku({
      supabase,
      userId,
      canonicalMarketplace,
      skuRaw: groupsWithSku[0].skuRaw,
      listingTokens: groupsWithSku[0].listingTokens,
    });
  } else {
    let totalReceived = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    /** @type {unknown[]} */
    const errors = [];
    let anyOk = false;
    /** @type {Awaited<ReturnType<typeof executeBulkSetSku>> | null} */
    let lastFail = null;
    let skuLiteral = groupsWithSku[0]?.skuRaw ?? "";

    for (const group of groupsWithSku) {
      const groupResult = await executeBulkSetSku({
        supabase,
        userId,
        canonicalMarketplace,
        skuRaw: group.skuRaw,
        listingTokens: group.listingTokens,
      });
      const b = groupResult.body && typeof groupResult.body === "object" ? groupResult.body : {};
      totalReceived += Number(b.total_received) || 0;
      totalUpdated += Number(b.total_updated) || 0;
      totalSkipped += Number(b.total_skipped) || 0;
      if (Array.isArray(b.errors)) errors.push(...b.errors);
      if (groupResult.ok && groupResult.status === 200) anyOk = true;
      else lastFail = groupResult;
      if (b.sku_literal != null) skuLiteral = String(b.sku_literal);
    }

    result = anyOk
      ? {
          ok: true,
          status: 200,
          body: {
            ok: true,
            total_received: totalReceived,
            total_updated: totalUpdated,
            total_skipped: totalSkipped,
            errors,
            sku_literal: skuLiteral,
          },
        }
      : lastFail ?? {
          ok: false,
          status: 500,
          body: { ok: false, error: "Falha ao aplicar vínculo em lote.", errors },
        };
  }

  if (result.ok && result.status === 200 && result.body?.ok) {
    const b = result.body;
    const msg =
      (b.total_skipped ?? 0) === 0 && (b.total_received ?? 0) > 0
        ? "Todos os anúncios selecionados foram vinculados ao produto."
        : (b.total_updated ?? 0) === 0
          ? "Nenhum anúncio foi atualizado; verifique os erros retornados."
          : `${b.total_updated} linha(s) de anúncio atualizada(s); ${b.total_skipped} item(ns) do payload não vinculados (duplicado, não encontrado ou falha).`;

    console.info("[listings/bulk-set-sku] bulk_link_ok", {
      user_id_prefix: String(userId).slice(0, 8),
      marketplace: canonicalMarketplace,
      total_received: b.total_received,
      total_updated: b.total_updated,
      total_skipped: b.total_skipped,
      error_count: Array.isArray(b.errors) ? b.errors.length : 0,
      product_id: b.product_id != null ? String(b.product_id).slice(0, 8) : null,
    });

    return res.status(200).json({
      ...b,
      message: msg,
      marketplace: canonicalMarketplace,
      attention_cleared: true,
      previous_attention: ATTENTION_REASON_SKU_PENDING_ML,
    });
  }

  if (!result.ok && result.status === 422) {
    console.info("[listings/bulk-set-sku] bulk_link_no_product", {
      user_id_prefix: String(userId).slice(0, 8),
      marketplace: canonicalMarketplace,
      total_received: result.body?.total_received,
      normalized_sku: result.body?.normalized_sku,
    });
    return res.status(422).json(result.body);
  }

  if (!result.ok && result.status === 400) {
    return res.status(400).json(result.body);
  }

  if (!result.ok) {
    console.error("[listings/bulk-set-sku] bulk_link_error", {
      status: result.status,
      user_id_prefix: String(userId).slice(0, 8),
      body: result.body,
    });
    return res.status(result.status || 500).json(result.body);
  }

  return res.status(200).json(result.body ?? { ok: false, error: "Resposta inválida do serviço." });
}
