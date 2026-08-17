// =============================================================================
// S7 — Canal Pop-up (Fase S5.7) — preview de template (infra)
// Compatível com Central de Templates S5.4 — sem CRUD.
// =============================================================================

import { previewTemplate } from "../templates/templatePreview.js";
import { S7_POPUP_CHANNEL_CODE, S7_POPUP_DISPLAY_TYPE } from "./popupChannelContract.js";
import { planPopupDisplay } from "./popupDisplayPolicy.js";

/**
 * Formato de preview específico do canal Pop-up (title + body, sem subject de e-mail).
 * @param {{
 *   title_template?: string;
 *   body_template?: string;
 *   channel?: string;
 *   display_type?: string;
 *   variables_schema?: unknown[];
 * }} template
 * @param {Parameters<typeof previewTemplate>[1]} [options]
 */
export function previewPopupTemplate(template, options = {}) {
  const base = previewTemplate(
    {
      subject_template: template?.title_template ?? "",
      body_template: template?.body_template ?? "",
      channel: template?.channel ?? S7_POPUP_CHANNEL_CODE,
      variables_schema: template?.variables_schema,
    },
    options
  );

  const display = planPopupDisplay({
    display_type: template?.display_type ?? S7_POPUP_DISPLAY_TYPE.INFO,
    display_mode: template?.display_mode,
    priority: template?.priority,
  });

  return {
    channel: S7_POPUP_CHANNEL_CODE,
    title: base.subject || base.body?.slice(0, 80) || "",
    body: base.body,
    display_type: display.display_type,
    display_mode: display.display_mode,
    priority: display.priority,
    placeholders: base.placeholders,
    missing_variables: base.missing_variables,
    ok: base.ok,
    preview_surfaces: ["toast", "modal", "overlay"],
  };
}
