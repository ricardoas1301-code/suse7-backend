// =============================================================================
// S7 — Central de Templates (Fase S5.4)
// Registry Único de Templates — fonte única de verdade (sobre s7_notification_templates).
//
// Camada de INFRAESTRUTURA: acesso/consulta + agrupamento por canal. NÃO cria
// templates de negócio. Integra com o Registro Oficial de Canais (S5.3).
// =============================================================================

import {
  isRegisteredChannel,
  resolveCanonicalChannelCode,
  listRegisteredChannels,
} from "../channels/channelRegistry.js";
import { logCentralNotification } from "../observability/centralNotificationLog.js";
import { toTemplateContract } from "./templateContract.js";

const TEMPLATES_TABLE = "s7_notification_templates";
const VERSIONS_TABLE = "s7_notification_template_versions";

/**
 * Lista templates com filtros opcionais. Retorna contratos normalizados.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ channel?: string|null; category?: string|null; status?: string|null; locale?: string|null; activeOnly?: boolean }} [filters]
 * @returns {Promise<{ ok: boolean; templates?: ReturnType<typeof toTemplateContract>[]; error?: string }>}
 */
export async function listTemplates(supabase, filters = {}) {
  let q = supabase.from(TEMPLATES_TABLE).select("*");

  if (filters.channel) {
    const ch = resolveCanonicalChannelCode(filters.channel);
    if (!ch) return { ok: true, templates: [] };
    q = q.eq("channel", ch);
  }
  if (filters.category) q = q.eq("category_code", filters.category);
  if (filters.status) q = q.eq("status", String(filters.status).toLowerCase());
  if (filters.locale) q = q.eq("locale", filters.locale);
  if (filters.activeOnly) q = q.eq("is_active", true);

  const { data, error } = await q;
  if (error) {
    logCentralNotification("TEMPLATE_REGISTRY_LIST_ERR", { message: error.message });
    return { ok: false, error: error.message };
  }
  return { ok: true, templates: (data ?? []).map(toTemplateContract) };
}

/**
 * Busca um template por slot (key + canal + locale).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ templateKey: string; channel: string; locale?: string }} input
 */
export async function getTemplate(supabase, input) {
  const channel = resolveCanonicalChannelCode(input.channel);
  if (!channel) return { ok: false, error: "UNREGISTERED_CHANNEL" };

  const { data, error } = await supabase
    .from(TEMPLATES_TABLE)
    .select("*")
    .eq("template_key", String(input.templateKey ?? "").trim())
    .eq("channel", channel)
    .eq("locale", input.locale ?? "pt-BR")
    .maybeSingle();

  if (error) {
    logCentralNotification("TEMPLATE_REGISTRY_GET_ERR", { message: error.message });
    return { ok: false, error: error.message };
  }
  return { ok: true, template: data ? toTemplateContract(data) : null };
}

/**
 * Histórico de versões de um template (mais recente primeiro).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ templateKey: string; channel: string; locale?: string }} input
 */
export async function getTemplateVersionHistory(supabase, input) {
  const channel = resolveCanonicalChannelCode(input.channel);
  if (!channel) return { ok: false, error: "UNREGISTERED_CHANNEL" };

  const { data, error } = await supabase
    .from(VERSIONS_TABLE)
    .select("*")
    .eq("template_key", String(input.templateKey ?? "").trim())
    .eq("channel", channel)
    .eq("locale", input.locale ?? "pt-BR")
    .order("version", { ascending: false });

  if (error) {
    if (error.code === "42P01" || error.code === "PGRST205") {
      return { ok: false, error: "VERSIONS_TABLE_MISSING", versions: [] };
    }
    logCentralNotification("TEMPLATE_REGISTRY_HISTORY_ERR", { message: error.message });
    return { ok: false, error: error.message };
  }
  return { ok: true, versions: data ?? [] };
}

/**
 * Agrupa contratos de template por canal — usado pela Central de Templates (Dev Center).
 * Sempre inclui TODOS os canais registrados (inclusive os sem templates ainda).
 * @param {ReturnType<typeof toTemplateContract>[]} templates
 * @returns {Record<string, { channel: string; count: number; templates: ReturnType<typeof toTemplateContract>[] }>}
 */
export function groupTemplatesByChannel(templates) {
  /** @type {Record<string, { channel: string; count: number; templates: any[] }>} */
  const grouped = {};
  for (const channel of listRegisteredChannels()) {
    grouped[channel] = { channel, count: 0, templates: [] };
  }
  for (const tpl of Array.isArray(templates) ? templates : []) {
    const ch = resolveCanonicalChannelCode(tpl.channel);
    if (!ch || !grouped[ch]) continue;
    grouped[ch].templates.push(tpl);
    grouped[ch].count += 1;
  }
  return grouped;
}

/** @param {string} channel — registrado no Registro Oficial de Canais */
export function isTemplateChannelRegistered(channel) {
  return isRegisteredChannel(channel);
}
