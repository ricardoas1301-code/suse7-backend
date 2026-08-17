// =============================================================================
// S7 — Central de Templates (Fase S5.4)
// Preview / simulação de templates por canal.
//
// Camada de INFRAESTRUTURA: renderiza um preview a partir de um template +
// variáveis simuladas, por canal. Sem interface final, sem template de negócio.
// =============================================================================

import { getChannelDefinition } from "../channels/channelRegistry.js";
import { renderTemplate } from "./templateRenderEngine.js";
import {
  buildTemplateVariableContext,
  buildSampleVariables,
  normalizeVariablesSchema,
} from "./templateVariables.js";

/**
 * Gera um preview de um template (puro, sem I/O).
 *
 * @param {{
 *   subject_template?: string;
 *   body_template?: string;
 *   channel?: string;
 *   variables_schema?: unknown[];
 * }} template
 * @param {{
 *   global?: Record<string, unknown>;
 *   channel?: Record<string, unknown>;
 *   context?: Record<string, unknown>;
 *   useSampleForMissing?: boolean;
 * }} [options]
 */
export function previewTemplate(template, options = {}) {
  const channelCode = template?.channel ? String(template.channel) : null;
  const channelDef = channelCode ? getChannelDefinition(channelCode) : null;

  const descriptors = normalizeVariablesSchema(template?.variables_schema);

  // Base de variáveis: escopos informados (precedência context > channel > global).
  let variables = buildTemplateVariableContext({
    global: options.global,
    channel: options.channel,
    context: options.context,
  });

  // Opcional: completa com amostras dos descritores para um preview legível.
  if (options.useSampleForMissing !== false) {
    variables = { ...buildSampleVariables(descriptors), ...variables };
  }

  const rendered = renderTemplate(
    { subject_template: template?.subject_template, body_template: template?.body_template },
    variables
  );

  return {
    channel: channelCode,
    channel_supported: channelDef?.supported === true,
    channel_available: channelDef?.available === true,
    delivery_mode: channelDef?.delivery_mode ?? null,
    subject: rendered.subject,
    body: rendered.body,
    placeholders: rendered.placeholders,
    missing_variables: rendered.missing_variables,
    used_variables: variables,
    ok: rendered.ok,
  };
}
