// ============================================================
// S7 — Concorrência: rastreio ponta a ponta de sales_hint (DEV)
// ML API → resolver → banco → API → frontend
// ============================================================

import { competitionSalesAuditEnabled } from "./competitionSalesMlAudit.js";
import { pickSalesHintFromRecord } from "./competitionEnrichHelpers.js";

/**
 * Erro em etapa do POST save — sempre console.error (visível no filtro error do Vercel).
 * @param {string} stage
 * @param {Record<string, unknown>} ctx
 * @param {unknown} error
 */
export function logSaveStageError(stage, ctx = {}, error = null) {
  const e = error instanceof Error ? error : error != null ? new Error(String(error)) : new Error("unknown");
  const context = ctx && typeof ctx === "object" ? ctx : {};
  console.error("[S7_COMPETITION_SAVE_STAGE_ERROR]", {
    stage,
    at: new Date().toISOString(),
    product_id: context.product_id ?? null,
    item_id: context.item_id ?? null,
    competitor_id: context.competitor_id ?? null,
    competitor_persisted: context.competitor_persisted ?? false,
    message: e.message,
    stack: e.stack ? String(e.stack).slice(0, 1200) : null,
    payload_sanitized: context.payload_sanitized ?? null,
  });
  if (competitionSalesAuditEnabled()) {
    console.info("[S7_COMPETITION_SAVE_STAGE_ERROR_DETAIL]", {
      stage,
      ...context,
      message: e.message,
    });
  }
}

/**
 * Log estruturado por etapa do pipeline de vendas.
 * Ativo somente em DEV ou S7_COMPETITION_SALES_AUDIT=1.
 * @param {string} stage
 * @param {Record<string, unknown>} data
 */
export function logSalesPipelineTrace(stage, data = {}) {
  if (!competitionSalesAuditEnabled()) return;
  const payload = data && typeof data === "object" ? data : {};
  console.info("[S7_COMPETITION_SALES_PIPELINE_TRACE]", {
    stage,
    at: new Date().toISOString(),
    ...payload,
  });
}

/** Resumo final após cadastro — responde as 7 perguntas do diagnóstico. */
export function logSalesPipelineSummary(summary = {}) {
  if (!competitionSalesAuditEnabled()) return;
  const s = summary && typeof summary === "object" ? summary : {};
  console.info("[S7_COMPETITION_SALES_PIPELINE_SUMMARY]", {
    item_id: s.item_id ?? null,
    competitor_id: s.competitor_id ?? null,
    // Prova ML (origem)
    resolved: s.resolved ?? s.ml_resolved ?? null,
    scenario: s.scenario ?? null,
    ml_endpoint_called: s.ml_endpoint_called ?? null,
    ml_http_status: s.ml_http_status ?? null,
    ml_sold_quantity_evidence: s.ml_sold_quantity_evidence ?? null,
    ml_sold_quantity_raw: s.ml_sold_quantity_raw ?? null,
    ml_has_sold_quantity_field: s.ml_has_sold_quantity_field ?? null,
    ml_resolved: s.ml_resolved ?? null,
    ml_failure_class: s.ml_failure_class ?? null,
    is_third_party: s.is_third_party ?? null,
    audit_recommendation: s.audit_recommendation ?? null,
    // Pipeline interno
    sales_hint: s.sales_hint ?? s.enrich_sales_hint ?? s.api_response_sales_hint ?? null,
    sales_hint_source: s.sales_hint_source ?? s.enrich_sales_hint_source ?? null,
    enrich_sales_hint: s.enrich_sales_hint ?? null,
    enrich_sales_hint_source: s.enrich_sales_hint_source ?? null,
    snapshot_inserted: s.snapshot_inserted ?? null,
    snapshot_sales_hint: s.snapshot_sales_hint ?? null,
    db_read_sales_hint: s.db_read_sales_hint ?? null,
    api_response_sales_hint: s.api_response_sales_hint ?? null,
    // Veredito
    bottleneck: s.bottleneck ?? "unknown",
    recommendation: s.recommendation ?? null,
  });
}

/** Inferir gargalo do pipeline com base nos valores coletados. */
export function inferSalesHintBottleneck(ctx = {}) {
  const enrich = pickSalesHintFromRecord({ sales_hint: ctx.enrich_sales_hint });
  const snapshot = pickSalesHintFromRecord({ sales_hint: ctx.snapshot_sales_hint });
  const api = pickSalesHintFromRecord({ sales_hint: ctx.api_response_sales_hint });

  if (ctx.ml_resolved === true && enrich != null && snapshot == null) {
    return {
      bottleneck: "snapshot_persist",
      recommendation: "sales_hint no enrich mas não gravou/leu do competition_snapshots",
    };
  }
  if (enrich != null && snapshot != null && api == null) {
    return {
      bottleneck: "api_merge",
      recommendation: "snapshot tem sales_hint mas toCompetitorResponse/GET não expôs",
    };
  }
  if (api != null && ctx.frontend_pick_sales_hint == null) {
    return {
      bottleneck: "frontend_pick_or_render",
      recommendation: "API retornou sales_hint mas pickSalesHint/formatCompactPriceSales omitiu",
    };
  }
  if (ctx.ml_resolved === false || enrich == null) {
    if (ctx.ml_failure_class === "permission_or_policy_blocked") {
      return {
        bottleneck: "ml_api_permission",
        recommendation: "ML bloqueou ou omitiu sold_quantity para anúncio de terceiro",
      };
    }
    return {
      bottleneck: "ml_api_no_sold_quantity",
      recommendation: "Ver [S7_COMPETITION_DIRECT_ITEM_AUDIT] phase final_diagnosis",
    };
  }
  if (enrich != null && snapshot != null && api != null) {
    return {
      bottleneck: "none_pipeline_ok",
      recommendation: "Pipeline backend OK — verificar frontend se UI não exibe",
    };
  }
  return {
    bottleneck: "investigate_logs",
    recommendation: "Seguir [S7_COMPETITION_SALES_PIPELINE_TRACE] por stage",
  };
}
