// =============================================================================
// CRUD — regra de automação SALES:DAILY_SALES_SUMMARY
// =============================================================================

import {
  DAILY_SALES_SUMMARY_CATEGORY,
  DAILY_SALES_SUMMARY_TYPE,
  DEFAULT_DAILY_SALES_SUMMARY_CONFIG,
} from "./dailySalesSummaryAutomationConstants.js";
import {
  formatDailySalesSummaryScheduleSummary,
  validateDailySalesSummaryAutomationPatch,
} from "./validateDailySalesSummaryAutomationConfig.js";

/**
 * @param {Record<string, unknown> | null | undefined} row
 */
export function mapDailySalesSummaryAutomationRule(row) {
  if (!row) return null;
  const config =
    row.config && typeof row.config === "object"
      ? /** @type {Record<string, unknown>} */ (row.config)
      : { ...DEFAULT_DAILY_SALES_SUMMARY_CONFIG };

  return {
    id: row.id,
    seller_id: row.seller_id,
    category_code: row.category_code,
    type_key: row.type_key,
    enabled: Boolean(row.enabled),
    config: {
      channels: config.channels ?? DEFAULT_DAILY_SALES_SUMMARY_CONFIG.channels,
      weekdays: config.weekdays ?? DEFAULT_DAILY_SALES_SUMMARY_CONFIG.weekdays,
      times: config.times ?? DEFAULT_DAILY_SALES_SUMMARY_CONFIG.times,
      timezone: config.timezone ?? DEFAULT_DAILY_SALES_SUMMARY_CONFIG.timezone,
    },
    last_successful_run_at: row.last_successful_run_at ?? null,
    schedule_summary: formatDailySalesSummaryScheduleSummary(config),
    updated_at: row.updated_at ?? null,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 */
export async function getDailySalesSummaryAutomationRule(supabase, sellerId) {
  const { data, error } = await supabase
    .from("s7_notification_automation_rules")
    .select("*")
    .eq("seller_id", sellerId)
    .eq("category_code", DAILY_SALES_SUMMARY_CATEGORY)
    .eq("type_key", DAILY_SALES_SUMMARY_TYPE)
    .maybeSingle();

  if (error) throw error;
  if (data) return mapDailySalesSummaryAutomationRule(data);

  return {
    id: null,
    seller_id: sellerId,
    category_code: DAILY_SALES_SUMMARY_CATEGORY,
    type_key: DAILY_SALES_SUMMARY_TYPE,
    enabled: true,
    config: { ...DEFAULT_DAILY_SALES_SUMMARY_CONFIG },
    last_successful_run_at: null,
    schedule_summary: formatDailySalesSummaryScheduleSummary(DEFAULT_DAILY_SALES_SUMMARY_CONFIG),
    updated_at: null,
    is_default: true,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {Record<string, unknown>} patch
 */
export async function patchDailySalesSummaryAutomationRule(supabase, sellerId, patch) {
  const current = await getDailySalesSummaryAutomationRule(supabase, sellerId);
  const validated = validateDailySalesSummaryAutomationPatch(patch, current);
  if (!validated.ok) {
    return { ok: false, error: validated.error, message: validated.message };
  }

  const now = new Date().toISOString();
  const payload = {
    seller_id: sellerId,
    category_code: DAILY_SALES_SUMMARY_CATEGORY,
    type_key: DAILY_SALES_SUMMARY_TYPE,
    enabled: validated.rule.enabled,
    config: validated.rule.config,
    updated_at: now,
  };

  const { data, error } = await supabase
    .from("s7_notification_automation_rules")
    .upsert(payload, { onConflict: "seller_id,category_code,type_key" })
    .select("*")
    .maybeSingle();

  if (error) throw error;

  await syncDailySalesSummaryChannelPreferences(supabase, sellerId, validated.rule.config.channels);

  return { ok: true, rule: mapDailySalesSummaryAutomationRule(data) };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {{ in_app?: boolean; popup?: boolean }} channels
 */
async function syncDailySalesSummaryChannelPreferences(supabase, sellerId, channels) {
  const updates = [
    { channel: "in_app", enabled: channels.in_app !== false },
    { channel: "push", enabled: channels.popup !== false },
  ];

  for (const u of updates) {
    await supabase.from("s7_notification_preferences").upsert(
      {
        seller_id: sellerId,
        category_code: DAILY_SALES_SUMMARY_CATEGORY,
        type_key: DAILY_SALES_SUMMARY_TYPE,
        channel: u.channel,
        enabled: u.enabled,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "seller_id,category_code,type_key,channel" },
    );
  }
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
export async function listActiveDailySalesSummaryAutomationRules(supabase) {
  const { data, error } = await supabase
    .from("s7_notification_automation_rules")
    .select("*")
    .eq("category_code", DAILY_SALES_SUMMARY_CATEGORY)
    .eq("type_key", DAILY_SALES_SUMMARY_TYPE)
    .eq("enabled", true);

  if (error) throw error;
  return (data ?? []).map((row) => mapDailySalesSummaryAutomationRule(row)).filter(Boolean);
}
