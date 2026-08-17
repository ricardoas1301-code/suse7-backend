import { ML_MARKETPLACE_LISTING_ALIASES, ML_MARKETPLACE_SLUG } from "../mlMarketplace.js";
import {
  logMercadoLivreShippingAudit,
  normalizeMercadoLivreShippingSummary,
} from "../../../../domain/listings/shipping/normalizeMercadoLivreShippingSummary.js";
import { normalizeMercadoLivreMediaSummary } from "../../../../domain/listings/media/normalizeMercadoLivreMediaSummary.js";
import { normalizeMercadoLivrePriceSummary } from "../../../../domain/listings/price/normalizeMercadoLivrePriceSummary.js";
import { normalizeMercadoLivreWholesaleSummary } from "../../../../domain/listings/wholesale/normalizeMercadoLivreWholesaleSummary.js";

/**
 * @param {unknown} value
 */
function textoOuNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text !== "" ? text : null;
}

/**
 * @param {unknown} value
 */
function numeroOuNull(value) {
  if (value == null || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function urlHttpsSegura(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return /^https?:\/\//i.test(text) ? text : null;
}

/**
 * Resolve URL segura para edição/visualização do anúncio no marketplace (backend SSOT).
 * @param {Record<string, unknown>} rawItem
 * @param {Record<string, unknown>} listingRow
 */
export function resolverUrlEdicaoMarketplaceMl(rawItem, listingRow) {
  const rowRaw =
    listingRow?.raw_json && typeof listingRow.raw_json === "object" && !Array.isArray(listingRow.raw_json)
      ? /** @type {Record<string, unknown>} */ (listingRow.raw_json)
      : {};

  const editCandidates = [
    rawItem?.marketplace_edit_url,
    rawItem?.external_edit_url,
    rawItem?.edit_url,
    rawItem?.seller_edit_url,
    rowRaw?.marketplace_edit_url,
    rowRaw?.external_edit_url,
    rowRaw?.edit_url,
    listingRow?.marketplace_edit_url,
    listingRow?.external_edit_url,
  ];
  for (const candidate of editCandidates) {
    const url = urlHttpsSegura(candidate);
    if (url) return url;
  }

  const itemId = textoOuNull(rawItem?.id) ?? textoOuNull(listingRow?.external_listing_id);
  const siteId = (textoOuNull(rawItem?.site_id) ?? "MLB").toUpperCase();
  if (itemId && /^ML[A-Z]\d+$/i.test(itemId)) {
    const hostBySite = {
      MLB: "www.mercadolivre.com.br",
      MLA: "www.mercadolibre.com.ar",
      MLM: "www.mercadolibre.com.mx",
      MLC: "www.mercadolibre.cl",
      MLU: "www.mercadolibre.com.uy",
      MCO: "www.mercadolibre.com.co",
    };
    const host = hostBySite[/** @type {keyof typeof hostBySite} */ (siteId)] ?? hostBySite.MLB;
    return `https://${host}/publicaciones/${encodeURIComponent(itemId)}/modificar`;
  }

  const permalinkCandidates = [rawItem?.permalink, rowRaw?.permalink, listingRow?.permalink];
  for (const candidate of permalinkCandidates) {
    const url = urlHttpsSegura(candidate);
    if (url) return url;
  }

  return null;
}

/**
 * @param {unknown} value
 */
function boolOuNull(value) {
  if (value === true || value === false) return value;
  if (value == null) return null;
  const text = String(value).trim().toLowerCase();
  if (["true", "1", "sim", "yes"].includes(text)) return true;
  if (["false", "0", "nao", "não", "no"].includes(text)) return false;
  return null;
}

/**
 * @param {unknown} attrsRaw
 * @param {string[]} attributeIds
 */
function pickAttributeValue(attrsRaw, attributeIds) {
  const attrs = Array.isArray(attrsRaw) ? attrsRaw : [];
  for (const raw of attrs) {
    if (!raw || typeof raw !== "object") continue;
    const attr = /** @type {Record<string, unknown>} */ (raw);
    const id = textoOuNull(attr.id)?.toUpperCase();
    if (!id || !attributeIds.includes(id)) continue;
    return textoOuNull(attr.value_name) ?? textoOuNull(attr.value_id) ?? null;
  }
  return null;
}

/**
 * @param {Record<string, unknown>} rawItem
 */
function extrairSkuVariacao(rawItem) {
  const attrs = Array.isArray(rawItem.attributes) ? rawItem.attributes : [];
  for (const attr of attrs) {
    if (!attr || typeof attr !== "object") continue;
    const id = textoOuNull(attr.id);
    const name = textoOuNull(attr.name);
    if (id === "SELLER_SKU" || name?.toUpperCase() === "SKU") {
      return textoOuNull(attr.value_name) ?? textoOuNull(attr.value_id);
    }
  }
  return null;
}

/**
 * @param {Record<string, unknown>} rawItem
 */
function normalizarVariacoes(rawItem) {
  const vars = Array.isArray(rawItem.variations) ? rawItem.variations : [];
  return vars
    .filter((v) => v && typeof v === "object")
    .map((v) => {
      const row = /** @type {Record<string, unknown>} */ (v);
      const atributos = Array.isArray(row.attribute_combinations)
        ? row.attribute_combinations
            .filter((a) => a && typeof a === "object")
            .map((a) => {
              const attr = /** @type {Record<string, unknown>} */ (a);
              const nome = textoOuNull(attr.name) ?? textoOuNull(attr.id) ?? "Atributo";
              const valor = textoOuNull(attr.value_name) ?? textoOuNull(attr.value_id) ?? "—";
              return `${nome}: ${valor}`;
            })
            .filter(Boolean)
        : [];
      const sku =
        textoOuNull(row.seller_custom_field) ??
        textoOuNull(row.seller_sku) ??
        extrairSkuVariacao(row) ??
        null;
      const imageIds = Array.isArray(row.picture_ids)
        ? row.picture_ids.map((id) => textoOuNull(id)).filter(Boolean)
        : [];
      return {
        id: textoOuNull(row.id),
        nome_atributos: atributos.length > 0 ? atributos.join(" • ") : "—",
        sku,
        estoque_disponivel: numeroOuNull(row.available_quantity),
        imagens: imageIds,
      };
    });
}

/**
 * @param {number | null} scorePercent
 * @param {number | null} objectivesCount
 */
function fallbackObjectivesLabel(scorePercent, objectivesCount) {
  if (scorePercent != null && scorePercent >= 100) return "Objetivos alcançados";
  if (objectivesCount != null && Number.isFinite(objectivesCount)) {
    return `${objectivesCount} objetivo${objectivesCount === 1 ? "" : "s"} para alcançar`;
  }
  if (scorePercent == null) return "Ainda não há dados suficientes";
  if (scorePercent >= 85) return "Há melhorias possíveis";
  if (scorePercent >= 60) return "Há melhorias recomendadas";
  if (scorePercent > 0) return "Requer atenção";
  return "Ainda não há dados suficientes";
}

/**
 * @param {number | null} scorePercent
 */
function fallbackLevelLabel(scorePercent) {
  if (scorePercent == null) return "Sem calcular";
  if (scorePercent >= 100) return "Qualidade máxima";
  if (scorePercent >= 85) return "Profissional";
  if (scorePercent >= 60) return "Satisfatória";
  if (scorePercent > 0) return "Básica";
  return "Sem calcular";
}

/**
 * @param {number | null} scorePercent
 */
function fallbackStatusTone(scorePercent) {
  if (scorePercent == null) return "neutral";
  if (scorePercent >= 100) return "success";
  if (scorePercent >= 85) return "info";
  if (scorePercent >= 60) return "warning";
  if (scorePercent > 0) return "danger";
  return "neutral";
}

/**
 * @param {unknown} scoreRaw
 */
function normalizarScorePercent(scoreRaw) {
  const score = numeroOuNull(scoreRaw);
  if (score == null || score < 0) return null;
  if (score > 0 && score <= 1) return Math.max(0, Math.min(100, Math.round(score * 100)));
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * @param {Record<string, unknown>} rawItem
 * @param {Record<string, unknown> | null | undefined} healthRow
 */
function extractQualityScore(rawItem, healthRow) {
  return normalizarScorePercent(
    healthRow?.health_percent ??
      healthRow?.listing_quality_score ??
      healthRow?.raw_json?.listing_quality_score ??
      rawItem.health ??
      rawItem.listing_quality_score,
  );
}

/**
 * @param {Record<string, unknown>} rawItem
 * @param {Record<string, unknown> | null | undefined} healthRow
 */
function extractExperienceScore(rawItem, healthRow) {
  return normalizarScorePercent(
    healthRow?.experience_score ??
      healthRow?.raw_json?.experience_score ??
      healthRow?.raw_json?.buying_experience_score ??
      rawItem.experience_score ??
      rawItem.buying_experience_score,
  );
}

/**
 * @param {Record<string, unknown>} performancePayload
 */
function countPendingObjectives(performancePayload) {
  /** @type {Array<Record<string, unknown>>} */
  const rules = [];
  const buckets = Array.isArray(performancePayload.buckets) ? performancePayload.buckets : [];
  for (const bucket of buckets) {
    if (!bucket || typeof bucket !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (bucket);
    if (Array.isArray(row.rules)) rules.push(...row.rules.filter((r) => r && typeof r === "object"));
    if (Array.isArray(row.variables)) rules.push(...row.variables.filter((r) => r && typeof r === "object"));
    if (Array.isArray(row.actions)) rules.push(...row.actions.filter((r) => r && typeof r === "object"));
  }
  if (Array.isArray(performancePayload.rules)) {
    rules.push(...performancePayload.rules.filter((r) => r && typeof r === "object"));
  }
  if (Array.isArray(performancePayload.actions)) {
    rules.push(...performancePayload.actions.filter((r) => r && typeof r === "object"));
  }

  let pending = 0;
  for (const rule of rules) {
    const status = textoOuNull(rule.status)?.toUpperCase() ?? "";
    if (status === "PENDING" || status === "INCOMPLETE" || status === "NOT_COMPLETED") pending += 1;
  }
  return pending;
}

/**
 * @param {number | null} scorePercent
 * @param {number} pendingCount
 * @param {boolean} hasRulesList
 */
function buildObjectivesLabelFromPerformance(scorePercent, pendingCount, hasRulesList) {
  if (hasRulesList) {
    if (pendingCount === 0) return "Objetivos alcançados";
    return `${pendingCount} objetivo${pendingCount === 1 ? "" : "s"} para alcançar`;
  }
  return fallbackObjectivesLabel(scorePercent, pendingCount > 0 ? pendingCount : null);
}

/**
 * @param {Record<string, unknown>} performancePayload
 * @param {string | null | undefined} performanceSource
 */
function buildQualitySummaryFromPerformance(performancePayload, performanceSource) {
  const scorePercent = normalizarScorePercent(performancePayload.score);
  const pendingCount = countPendingObjectives(performancePayload);
  const hasRulesList =
    (Array.isArray(performancePayload.buckets) && performancePayload.buckets.length > 0) ||
    (Array.isArray(performancePayload.rules) && performancePayload.rules.length > 0) ||
    (Array.isArray(performancePayload.actions) && performancePayload.actions.length > 0);

  const levelWording =
    textoOuNull(performancePayload.level_wording) ??
    textoOuNull(performancePayload.level_label) ??
    (performancePayload.wordings &&
    typeof performancePayload.wordings === "object" &&
    !Array.isArray(performancePayload.wordings)
      ? textoOuNull(/** @type {Record<string, unknown>} */ (performancePayload.wordings).label)
      : null);

  const levelLabel =
    levelWording ??
    (scorePercent != null && scorePercent >= 100 && pendingCount === 0
      ? "Qualidade máxima"
      : fallbackLevelLabel(scorePercent));

  if (scorePercent == null && performanceSource === "mercado_livre_performance") {
    return {
      score_percent: null,
      display_value: "—",
      score_label: "Qualidade do anúncio",
      level_label: "Sem calcular",
      objectives_label: "Ainda não há dados suficientes",
      objectives_count: pendingCount > 0 ? pendingCount : null,
      tone: "neutral",
      status_tone: "neutral",
      source: "unavailable",
    };
  }

  return {
    score_percent: scorePercent,
    display_value: scorePercent != null ? `${scorePercent}%` : "—",
    score_label: "Qualidade do anúncio",
    level_label: levelLabel,
    objectives_label: buildObjectivesLabelFromPerformance(scorePercent, pendingCount, hasRulesList),
    objectives_count: pendingCount > 0 ? pendingCount : hasRulesList ? 0 : null,
    tone: fallbackStatusTone(scorePercent),
    status_tone: fallbackStatusTone(scorePercent),
    source:
      performanceSource === "mercado_livre_performance"
        ? "mercado_livre_performance"
        : performanceSource === "mercado_livre_health"
          ? "mercado_livre_health"
          : scorePercent == null
            ? "unavailable"
            : "fallback",
  };
}

/**
 * @param {Record<string, unknown>} rawItem
 * @param {Record<string, unknown> | null | undefined} healthRow
 * @param {{ performancePayload?: Record<string, unknown> | null; performanceSource?: string | null }} [options]
 */
function buildQualitySummary(rawItem, healthRow, options = {}) {
  const performancePayload =
    options.performancePayload && typeof options.performancePayload === "object"
      ? options.performancePayload
      : null;
  if (performancePayload) {
    return buildQualitySummaryFromPerformance(performancePayload, options.performanceSource ?? null);
  }

  const scorePercent = extractQualityScore(rawItem, healthRow);

  const rawHealthJson =
    healthRow?.raw_json && typeof healthRow.raw_json === "object" && !Array.isArray(healthRow.raw_json)
      ? /** @type {Record<string, unknown>} */ (healthRow.raw_json)
      : {};
  const objectivesCount =
    numeroOuNull(rawHealthJson.goals_pending_count) ??
    numeroOuNull(rawHealthJson.objectives_pending_count) ??
    numeroOuNull(rawHealthJson.pending_requirements_count) ??
    null;

  const levelLabel =
    textoOuNull(healthRow?.listing_quality_status) ??
    textoOuNull(rawHealthJson.listing_quality_status) ??
    (scorePercent == null ? "Sem calcular" : fallbackLevelLabel(scorePercent));

  return {
    score_percent: scorePercent,
    display_value: scorePercent != null ? `${scorePercent}%` : "—",
    score_label: "Qualidade do anúncio",
    level_label: levelLabel,
    objectives_label:
      scorePercent != null && scorePercent >= 100
        ? "Objetivos alcançados"
        : fallbackObjectivesLabel(scorePercent, objectivesCount),
    objectives_count: objectivesCount,
    tone: fallbackStatusTone(scorePercent),
    status_tone: fallbackStatusTone(scorePercent),
    source: scorePercent == null ? "unavailable" : healthRow != null ? "suse7_cache" : "fallback",
  };
}

/**
 * @param {unknown} value
 */
function extrairTextoMl(value) {
  if (value == null) return null;
  if (typeof value === "string") return textoOuNull(value);
  if (typeof value === "object" && !Array.isArray(value)) {
    return textoOuNull(/** @type {Record<string, unknown>} */ (value).text);
  }
  return null;
}

/**
 * @param {string | null | undefined} reputationText
 * @param {number | null} scorePercent
 * @param {string | null | undefined} reputationColor
 */
function mapearLabelExperienciaCompra(reputationText, scorePercent, reputationColor) {
  const text = reputationText != null ? String(reputationText).trim() : "";
  const lower = text.toLowerCase();
  if (lower.includes("muito bem")) return "Muito bem!";
  if (lower.includes("excelente")) return "Muito bem!";
  if (lower === "buena" || lower === "boa" || lower === "good") {
    return scorePercent != null && scorePercent >= 95 ? "Muito bem!" : "Boa";
  }
  if (text) return text;
  if (scorePercent != null && scorePercent >= 95) return "Muito bem!";
  if (scorePercent != null && scorePercent >= 75) return "Boa";
  if (scorePercent != null && scorePercent >= 60) return "Regular";
  if (scorePercent != null && scorePercent > 0) return "Atenção";
  return null;
}

/**
 * @param {Record<string, unknown>} integratorsPayload
 */
function buildPurchaseExperienceFromIntegrators(integratorsPayload) {
  const reputation =
    integratorsPayload.reputation && typeof integratorsPayload.reputation === "object"
      ? /** @type {Record<string, unknown>} */ (integratorsPayload.reputation)
      : null;
  const scorePercent = normalizarScorePercent(reputation?.value);
  const reputationText = extrairTextoMl(reputation?.text) ?? textoOuNull(reputation?.text);
  const reputationColor = textoOuNull(reputation?.color)?.toLowerCase() ?? null;
  const titleText = extrairTextoMl(integratorsPayload.title) ?? extrairTextoMl(integratorsPayload.freeze);

  const subtitles = Array.isArray(integratorsPayload.subtitles) ? integratorsPayload.subtitles : [];
  const subtitleText = subtitles
    .map((row) => (row && typeof row === "object" ? extrairTextoMl(row.text ?? row) : null))
    .find(Boolean);

  const unavailablePhrases = [
    "ainda não podemos calculá-la",
    "ainda nao podemos calcula-la",
    "vendas suficientes para podermos calculá-la",
    "vendas suficientes para podermos calcula-la",
    "sem calcular",
    "not available",
    "no podemos calcularla",
  ];

  const candidates = [reputationText, titleText, subtitleText, ...subtitles.map((row) => extrairTextoMl(row))].filter(Boolean);
  const hasUnavailablePhrase = candidates.some((c) =>
    unavailablePhrases.some((p) => String(c).toLowerCase().includes(p)),
  );

  if (
    (reputationColor === "gray" && scorePercent == null) ||
    (integratorsPayload.reputation != null &&
      numeroOuNull(reputation?.value) != null &&
      Number(reputation?.value) < 0)
  ) {
    return {
      score_percent: null,
      display_value: "—",
      title: "Experiência de compra",
      label: "Ainda não podemos calculá-la",
      description: null,
      tone: "neutral",
      source: "unavailable",
    };
  }

  const metricsDetails =
    integratorsPayload.metrics_details && typeof integratorsPayload.metrics_details === "object"
      ? /** @type {Record<string, unknown>} */ (integratorsPayload.metrics_details)
      : null;
  const emptyStateTitle = extrairTextoMl(metricsDetails?.empty_state_title);

  const hasPositiveReputation =
    reputationColor === "green" ||
    (reputationText != null &&
      (String(reputationText).toLowerCase().includes("muito bem") ||
        String(reputationText).toLowerCase().includes("excelente") ||
        String(reputationText).toLowerCase().includes("boa")));

  if (
    !hasPositiveReputation &&
    hasUnavailablePhrase &&
    scorePercent == null &&
    !reputationText &&
    reputationColor !== "green"
  ) {
    return {
      score_percent: null,
      display_value: "—",
      title: "Experiência de compra",
      label: "Ainda não podemos calculá-la",
      description: null,
      tone: "neutral",
      source: "unavailable",
    };
  }

  const labelFromApi = mapearLabelExperienciaCompra(reputationText, scorePercent, reputationColor);
  if (!labelFromApi && scorePercent == null && !reputation && !titleText) {
    return {
      score_percent: null,
      display_value: "—",
      title: "Experiência de compra",
      label: "Ainda não podemos calculá-la",
      description: null,
      tone: "neutral",
      source: "unavailable",
    };
  }

  const levelLabel = labelFromApi ?? "Ainda não podemos calculá-la";
  const toneFromColor =
    reputationColor === "green"
      ? "success"
      : reputationColor === "orange" || reputationColor === "yellow"
        ? "warning"
        : reputationColor === "red"
          ? "danger"
          : null;

  const footerText =
    emptyStateTitle && emptyStateTitle !== levelLabel
      ? emptyStateTitle
      : subtitleText && subtitleText !== levelLabel
        ? subtitleText
        : levelLabel.includes("!") && !levelLabel.endsWith("!")
          ? `${levelLabel}!`
          : scorePercent != null && scorePercent >= 95 && !levelLabel.includes("!")
            ? "Muito bem!"
            : null;

  return {
    score_percent: scorePercent,
    display_value: scorePercent != null ? `${scorePercent}%` : "—",
    title: "Experiência de compra",
    label: levelLabel,
    description: footerText && footerText !== levelLabel ? footerText : null,
    tone: toneFromColor ?? fallbackStatusTone(scorePercent),
    source: "mercado_livre_purchase_experience",
  };
}

/**
 * @param {Record<string, unknown>} performancePayload
 */
function buildPurchaseExperienceFromPerformance(performancePayload) {
  const buy =
    (performancePayload.buying_experience && typeof performancePayload.buying_experience === "object"
      ? performancePayload.buying_experience
      : null) ??
    (performancePayload.buyer_experience && typeof performancePayload.buyer_experience === "object"
      ? performancePayload.buyer_experience
      : null) ??
    (performancePayload.shopping_experience && typeof performancePayload.shopping_experience === "object"
      ? performancePayload.shopping_experience
      : null) ??
    (performancePayload.purchase_experience && typeof performancePayload.purchase_experience === "object"
      ? performancePayload.purchase_experience
      : null) ??
    (performancePayload.experience && typeof performancePayload.experience === "object"
      ? performancePayload.experience
      : null);

  if (!buy) return null;

  const scorePercent = normalizarScorePercent(
    buy.score ?? buy.value ?? buy.reputation?.value ?? buy.health ?? buy.percent,
  );
  const labelCandidate =
    textoOuNull(buy.text) ??
    textoOuNull(buy.label) ??
    textoOuNull(buy.status) ??
    textoOuNull(buy.level) ??
    textoOuNull(buy.title);

  if (scorePercent == null && !labelCandidate) return null;

  return {
    score_percent: scorePercent,
    display_value: scorePercent != null ? `${scorePercent}%` : "—",
    title: "Experiência de compra",
    label:
      labelCandidate ??
      (scorePercent != null && scorePercent >= 95
        ? "Muito bem"
        : scorePercent != null && scorePercent >= 75
          ? "Boa"
          : "Ainda não podemos calculá-la"),
    description: null,
    tone: fallbackStatusTone(scorePercent),
    source: "mercado_livre_performance",
  };
}

/**
 * @param {Record<string, unknown>} rawItem
 * @param {Record<string, unknown> | null | undefined} healthRow
 * @param {{
 *   performancePayload?: Record<string, unknown> | null;
 *   purchaseExperiencePayload?: Record<string, unknown> | null;
 * }} [options]
 */
function buildPurchaseExperienceSummary(rawItem, healthRow, options = {}) {
  const integratorsPayload =
    options.purchaseExperiencePayload && typeof options.purchaseExperiencePayload === "object"
      ? options.purchaseExperiencePayload
      : null;
  if (integratorsPayload) {
    return buildPurchaseExperienceFromIntegrators(integratorsPayload);
  }

  const performancePayload =
    options.performancePayload && typeof options.performancePayload === "object"
      ? options.performancePayload
      : null;
  if (performancePayload) {
    const fromPerformance = buildPurchaseExperienceFromPerformance(performancePayload);
    if (fromPerformance) return fromPerformance;
  }

  const scorePercent = extractExperienceScore(rawItem, healthRow);
  const experienceStatus =
    textoOuNull(healthRow?.experience_status) ??
    textoOuNull(healthRow?.raw_json?.experience_status) ??
    textoOuNull(rawItem.experience_status);
  const levelLabel =
    experienceStatus ??
    (scorePercent == null
      ? "Ainda não podemos calculá-la"
      : scorePercent >= 95
        ? "Muito bem"
        : scorePercent >= 75
          ? "Boa"
          : scorePercent >= 60
            ? "Regular"
            : "Atenção");
  return {
    score_percent: scorePercent,
    display_value: scorePercent != null ? `${scorePercent}%` : "—",
    title: "Experiência de compra",
    label: levelLabel,
    description: scorePercent == null ? "Ainda não podemos calculá-la" : null,
    tone: fallbackStatusTone(scorePercent),
    source: scorePercent == null ? "unavailable" : healthRow != null ? "suse7_cache" : "fallback",
  };
}

/**
 * @param {string | null | undefined} raw
 */
function formatarStatusLabel(raw) {
  const value = textoOuNull(raw);
  if (!value) return "—";
  const s = value.toLowerCase();
  if (s === "active" || s === "ativo") return "Ativo";
  if (s === "paused" || s === "pausado") return "Pausado";
  if (s === "closed" || s === "finalizado") return "Finalizado";
  if (s === "under_review" || s === "em revisão" || s === "em revisao") return "Em revisão";
  if (s === "inactive" || s === "not_yet_active" || s === "inativo") return "Inativo";
  const humanized = value.replace(/_/g, " ");
  return humanized.charAt(0).toUpperCase() + humanized.slice(1);
}

/**
 * @param {Record<string, unknown>} rawItem
 * @param {Array<{ estoque_disponivel?: number | null }>} variacoesNormalizadas
 */
function extrairSoldQuantity(rawItem, variacoesNormalizadas) {
  const fromItem = numeroOuNull(rawItem.sold_quantity);
  if (fromItem != null) return fromItem;
  const vars = Array.isArray(rawItem.variations) ? rawItem.variations : [];
  if (vars.length === 0) return null;
  let sum = 0;
  let hasAny = false;
  for (const raw of vars) {
    if (!raw || typeof raw !== "object") continue;
    const sq = numeroOuNull(/** @type {Record<string, unknown>} */ (raw).sold_quantity);
    if (sq != null) {
      sum += sq;
      hasAny = true;
    }
  }
  return hasAny ? sum : null;
}

/**
 * @param {number | null} soldQuantity
 * @param {number | null} visits
 */
function calcularConversaoPercent(soldQuantity, visits) {
  if (visits == null || visits <= 0) return null;
  if (soldQuantity == null) return null;
  const conversion = (soldQuantity / visits) * 100;
  return Math.round(conversion * 100) / 100;
}

/**
 * @param {Record<string, unknown>} listingRow
 * @param {Record<string, unknown>} rawItem
 * @param {{ plain_text?: unknown; html_text?: unknown }} [descriptionRow]
 * @param {Array<{ secure_url?: unknown; url?: unknown; position?: unknown; raw_json?: unknown }>} [pictureRows]
 * @param {{ healthRow?: Record<string, unknown> | null; visitsTotal?: number | null; visitsAvailable?: boolean; performancePayload?: Record<string, unknown> | null; performanceSource?: string | null }} [options]
 */
export function buildMercadoLivreListingEditorPayload(
  listingRow,
  rawItem,
  descriptionRow = {},
  pictureRows = [],
  options = {},
) {
  const healthRow = options.healthRow && typeof options.healthRow === "object" ? options.healthRow : null;
  const visitsAvailable = options.visitsAvailable === true;
  const visitsFromApi = visitsAvailable ? numeroOuNull(options.visitsTotal) : null;
  const channels = Array.isArray(rawItem.channels) ? rawItem.channels.map((c) => String(c)) : [];
  const tags = Array.isArray(rawItem.tags) ? rawItem.tags.map((t) => String(t)) : [];
  const subStatus = Array.isArray(rawItem.sub_status) ? rawItem.sub_status.map((s) => String(s)) : [];
  const variacoesNormalizadas = normalizarVariacoes(rawItem);
  const pictures =
    pictureRows.length > 0
      ? pictureRows
          .map((p, index) => {
            const rawJson =
              p.raw_json && typeof p.raw_json === "object" && !Array.isArray(p.raw_json)
                ? /** @type {Record<string, unknown>} */ (p.raw_json)
                : {};
            return {
              picture_id: textoOuNull(rawJson.id),
              url: textoOuNull(p.secure_url) ?? textoOuNull(p.url),
              position: numeroOuNull(p.position) ?? index,
            };
          })
          .filter((p) => p.url != null)
      : Array.isArray(rawItem.pictures)
        ? rawItem.pictures
            .filter((p) => p && typeof p === "object")
            .map((p, index) => {
              const row = /** @type {Record<string, unknown>} */ (p);
              return {
                picture_id: textoOuNull(row.id),
                url: textoOuNull(row.secure_url) ?? textoOuNull(row.url),
                position: numeroOuNull(row.position) ?? index,
              };
            })
            .filter((p) => p.url != null)
        : [];

  const soldQuantity = extrairSoldQuantity(rawItem, variacoesNormalizadas);
  const availableQuantity = (() => {
    const fromItem = numeroOuNull(rawItem.available_quantity);
    if (fromItem != null) return fromItem;
    const variacaoEstoque = variacoesNormalizadas
      .map((v) => numeroOuNull(v.estoque_disponivel))
      .filter((n) => n != null);
    if (variacaoEstoque.length === 0) return null;
    return variacaoEstoque.reduce((acc, n) => acc + Number(n), 0);
  })();
  const skuValue =
    pickAttributeValue(rawItem.attributes, ["SELLER_SKU", "SKU"]) ??
    textoOuNull(rawItem.seller_custom_field) ??
    textoOuNull(rawItem.seller_sku) ??
    textoOuNull(listingRow.seller_sku);
  const conversionPercent = calcularConversaoPercent(soldQuantity, visitsFromApi);
  const marketplaceEditUrl = resolverUrlEdicaoMarketplaceMl(rawItem, listingRow);
  const shippingSummary = normalizeMercadoLivreShippingSummary(rawItem);
  const priceSummary = normalizeMercadoLivrePriceSummary(rawItem);
  const mediaSummary = normalizeMercadoLivreMediaSummary({
    ...rawItem,
    item_full_detail: options.itemFullDetailPayload ?? null,
  });
  const wholesaleSummary = normalizeMercadoLivreWholesaleSummary({
    ...rawItem,
    item_prices_show_all: options.itemPricesShowAllPayload ?? null,
  });
  logMercadoLivreShippingAudit(
    rawItem,
    textoOuNull(rawItem.id) ?? textoOuNull(listingRow.external_listing_id),
  );
  if (process.env.NODE_ENV !== "production" && process.env.S7_DEBUG_ML_LISTING_MEDIA === "1") {
    console.info("[S7_ML_LISTING_MEDIA_AUDIT]", {
      listing_id: textoOuNull(rawItem.id) ?? textoOuNull(listingRow.external_listing_id),
      has_video_id: textoOuNull(rawItem.video_id) != null,
      video_id_masked: textoOuNull(rawItem.video_id) ? "***" : null,
      has_videos_array: Array.isArray(rawItem.videos),
      videos_count: Array.isArray(rawItem.videos) ? rawItem.videos.length : 0,
      has_clips_array: Array.isArray(rawItem.clips),
      clips_count: Array.isArray(rawItem.clips) ? rawItem.clips.length : 0,
      item_full_detail_status: options.itemFullDetailPayload?.status ?? null,
      normalized: mediaSummary,
    });
  }
  if (process.env.NODE_ENV !== "production" && process.env.S7_DEBUG_ML_WHOLESALE === "1") {
    const priceRows =
      options.itemPricesShowAllPayload?.data &&
      typeof options.itemPricesShowAllPayload.data === "object" &&
      Array.isArray(options.itemPricesShowAllPayload.data.prices)
        ? options.itemPricesShowAllPayload.data.prices
        : [];
    const quantityTiers = priceRows
      .filter((row) => row && typeof row === "object")
      .map((row) => {
        const conditions = row.conditions && typeof row.conditions === "object" ? row.conditions : {};
        return {
          min_purchase_unit: conditions.min_purchase_unit ?? null,
          amount: row.amount ?? null,
          currency_id: row.currency_id ?? null,
          context_restrictions: Array.isArray(conditions.context_restrictions)
            ? conditions.context_restrictions
            : [],
        };
      })
      .filter((row) => row.min_purchase_unit != null);
    console.info("[S7_ML_WHOLESALE_AUDIT]", {
      listing_id: textoOuNull(rawItem.id) ?? textoOuNull(listingRow.external_listing_id),
      prices_status: options.itemPricesShowAllPayload?.status ?? null,
      show_all_prices_sent: options.itemPricesShowAllPayload?.show_all_prices_sent === true,
      prices_count: priceRows.length,
      quantity_tiers_count: quantityTiers.length,
      tiers: quantityTiers,
      normalized: wholesaleSummary,
    });
  }

  return {
    listing_edit_capabilities: {
      content: {
        title: { readable: true, editable: true },
        description: { readable: true, editable: true },
        pictures: { readable: true, editable: false },
      },
      variations: { readable: true, editable: false },
      logistics: {
        dimensions: { readable: true, editable: false },
        weight: { readable: true, editable: false },
        shipping_mode: { readable: true, editable: false },
      },
      settings: { readable: true, editable: false },
    },
    content: {
      title: textoOuNull(rawItem.title) ?? textoOuNull(listingRow.title) ?? "—",
      description:
        textoOuNull(descriptionRow.plain_text) ??
        textoOuNull(descriptionRow.html_text) ??
        textoOuNull(rawItem.plain_text) ??
        null,
      pictures,
      pictures_edit_status: "preparing",
    },
    variations: variacoesNormalizadas,
    logistics: {
      logistic_type: shippingSummary.logistic_type_code,
      shipping_mode: shippingSummary.mode_code,
      free_shipping: shippingSummary.free_shipping,
      shipping_summary: shippingSummary,
      dimensions: textoOuNull(rawItem.dimensions),
      weight: numeroOuNull(rawItem.weight),
    },
    listing_summary_kpis: {
      shipping: shippingSummary,
      price: priceSummary,
      media: mediaSummary,
      wholesale: wholesaleSummary,
    },
    price_summary: priceSummary,
    media_summary: mediaSummary,
    wholesale_summary: wholesaleSummary,
    summary: {
      experience_status:
        textoOuNull(healthRow?.experience_status) ??
        textoOuNull(rawItem.experience_status) ??
        "Sem calcular",
      status: textoOuNull(rawItem.status) ?? textoOuNull(listingRow.status) ?? "—",
      status_label: formatarStatusLabel(textoOuNull(rawItem.status) ?? textoOuNull(listingRow.status)),
      status_technical: textoOuNull(rawItem.status),
      visits: visitsFromApi,
      visits_available: visitsAvailable,
      sold_quantity: soldQuantity,
      conversion_percent: conversionPercent,
      available_quantity: availableQuantity,
      sku: skuValue,
      sku_label: skuValue,
      stock_label: availableQuantity != null ? String(availableQuantity) : null,
      category_name: textoOuNull(rawItem.category_name) ?? textoOuNull(rawItem.category_id),
      category_id: textoOuNull(rawItem.category_id),
      brand:
        pickAttributeValue(rawItem.attributes, ["BRAND"]) ??
        pickAttributeValue(rawItem.attributes, ["MANUFACTURER"]) ??
        null,
      universal_code:
        pickAttributeValue(rawItem.attributes, ["GTIN"]) ??
        pickAttributeValue(rawItem.attributes, ["EAN"]) ??
        pickAttributeValue(rawItem.attributes, ["UPC"]) ??
        pickAttributeValue(rawItem.attributes, ["ISBN"]) ??
        null,
    },
    quality: buildQualitySummary(rawItem, healthRow, {
      performancePayload: options.performancePayload ?? null,
      performanceSource: options.performanceSource ?? null,
    }),
    purchase_experience: buildPurchaseExperienceSummary(rawItem, healthRow, {
      performancePayload: options.performancePayload ?? null,
      purchaseExperiencePayload: options.purchaseExperiencePayload ?? null,
    }),
    settings: {
      item_id: textoOuNull(rawItem.id) ?? textoOuNull(listingRow.external_listing_id) ?? "—",
      seller_id: textoOuNull(rawItem.seller_id) ?? null,
      marketplace: ML_MARKETPLACE_SLUG,
      category_id: textoOuNull(rawItem.category_id),
      category_name: textoOuNull(rawItem.category_name),
      listing_type_id: textoOuNull(rawItem.listing_type_id) ?? textoOuNull(listingRow.listing_type_id),
      buying_mode: textoOuNull(rawItem.buying_mode),
      status: textoOuNull(rawItem.status) ?? textoOuNull(listingRow.status),
      sub_status: Array.isArray(rawItem.sub_status)
        ? rawItem.sub_status.map((s) => String(s)).filter(Boolean)
        : subStatus,
      channels,
      tags,
      catalog_product_id: textoOuNull(rawItem.catalog_product_id),
      is_catalog_listing: textoOuNull(rawItem.catalog_listing) === "true" || rawItem.catalog_listing === true,
      last_updated: textoOuNull(rawItem.last_updated) ?? textoOuNull(listingRow.api_last_seen_at),
      marketplace_account_id: textoOuNull(listingRow.marketplace_account_id),
    },
    marketplace_edit_url: marketplaceEditUrl,
    external_edit_url: marketplaceEditUrl,
  };
}

/**
 * @param {string | null | undefined} marketplace
 */
export function isMercadoLivreListingMarketplace(marketplace) {
  const value = String(marketplace ?? "").trim().toLowerCase();
  return ML_MARKETPLACE_LISTING_ALIASES.includes(value);
}

