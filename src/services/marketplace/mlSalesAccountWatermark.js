// ======================================================================
// Marca d'água de vendas ML por conta (ml_sales_last_sync_at) — usado pelo
// worker de sync e pelo polling incremental (sem import circular).
// ======================================================================

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} accountId
 * @param {string | null} detailMaxCreated
 * @param {string} nowIso
 */
export async function advanceMlSalesWatermark(supabase, accountId, detailMaxCreated, nowIso) {
  const { data: row, error } = await supabase
    .from("marketplace_accounts")
    .select("ml_sales_last_synced_order_created_to")
    .eq("id", accountId)
    .maybeSingle();

  if (error) throw error;

  const prev =
    row?.ml_sales_last_synced_order_created_to != null
      ? String(row.ml_sales_last_synced_order_created_to)
      : null;
  let next = prev;
  const c = detailMaxCreated ? String(detailMaxCreated) : null;
  if (c && (!prev || Date.parse(c) > Date.parse(prev))) next = c;

  const { error: uErr } = await supabase
    .from("marketplace_accounts")
    .update({
      ml_sales_last_sync_at: nowIso,
      ml_sales_last_synced_order_created_to: next,
      updated_at: nowIso,
    })
    .eq("id", accountId);

  if (uErr) throw uErr;
}
