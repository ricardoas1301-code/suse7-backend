// =============================================================================
// S7 — Central Sininho (Fase S5.8) — preview de template (infra)
// Compatível com Central de Templates S5.4 — sem CRUD.
// =============================================================================

import { previewTemplate } from "../templates/templatePreview.js";
import { S7_SININHO_CHANNEL_CODE } from "./sininhoChannelContract.js";
import { isValidSininhoSeverity } from "./sininhoHistoryPolicy.js";

/**
 * Preview do canal Sininho (title + message, deep-link opcional).
 * @param {{
 *   subject_template?: string;
 *   body_template?: string;
 *   channel?: string;
 *   severity?: string;
 *   variables_schema?: unknown[];
 * }} template
 * @param {Parameters<typeof previewTemplate>[1]} [options]
 */
export function previewSininhoTemplate(template, options = {}) {
  const base = previewTemplate(
    {
      subject_template: template?.subject_template ?? template?.title_template ?? "",
      body_template: template?.body_template ?? "",
      channel: template?.channel ?? S7_SININHO_CHANNEL_CODE,
      variables_schema: template?.variables_schema,
    },
    options
  );

  const severity = isValidSininhoSeverity(template?.severity)
    ? String(template.severity).toLowerCase()
    : "info";

  return {
    channel: S7_SININHO_CHANNEL_CODE,
    title: base.subject || "",
    message: base.body,
    severity,
    placeholders: base.placeholders,
    missing_variables: base.missing_variables,
    ok: base.ok,
    preview_surfaces: ["sininho_dropdown", "notificacoes_hub"],
    deep_link_resolver: "resolveInAppDeepLink",
  };
}
