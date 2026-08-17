// =============================================================================
// Categorias + tipos para UI seller
// =============================================================================

import { isCategoryVisibleToSeller, SELLER_CATEGORY_UI, SELLER_CHANNEL_UI } from "./sellerNotificationUiCatalog.js";
import { logNotificationUi } from "./sellerNotificationObservability.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ includeDevCenter?: boolean }} [ctx]
 */
export async function listSellerNotificationCategories(supabase, ctx = {}) {
  const includeDevCenter = ctx.includeDevCenter === true;

  const { data: categories, error: catErr } = await supabase
    .from("s7_notification_categories")
    .select("code, label, description, sort_order")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  if (catErr) throw catErr;

  const { data: types, error: typeErr } = await supabase
    .from("s7_notification_event_types")
    .select(
      "category_code, type_key, label, description, severity_default, is_mandatory, default_channels, supported_channels"
    )
    .eq("is_active", true);

  if (typeErr) throw typeErr;

  /** @type {Map<string, Array<Record<string, unknown>>>} */
  const typesByCategory = new Map();
  for (const t of types ?? []) {
    const code = String(t.category_code);
    const list = typesByCategory.get(code) ?? [];
    list.push({
      type_key: t.type_key,
      label: t.label,
      description: t.description ?? "",
      severity: t.severity_default,
      is_mandatory: Boolean(t.is_mandatory),
      default_channels: Array.isArray(t.default_channels) ? t.default_channels : [],
      supported_channels: Array.isArray(t.supported_channels) ? t.supported_channels : [],
    });
    typesByCategory.set(code, list);
  }

  const result = (categories ?? [])
    .filter((c) => isCategoryVisibleToSeller(c.code, includeDevCenter))
    .map((c) => {
      const ui = SELLER_CATEGORY_UI[c.code] ?? {};
      return {
        code: c.code,
        label: ui.label ?? c.label,
        description: ui.description ?? c.description ?? "",
        sort_order: ui.sortOrder ?? c.sort_order ?? 0,
        types: (typesByCategory.get(String(c.code)) ?? []).sort((a, b) =>
          String(a.label).localeCompare(String(b.label))
        ),
      };
    })
    .sort((a, b) => Number(a.sort_order) - Number(b.sort_order));

  logNotificationUi("CATEGORIES_LISTED", { count: result.length, include_dev_center: includeDevCenter });

  return {
    categories: result,
    channels: SELLER_CHANNEL_UI,
  };
}
