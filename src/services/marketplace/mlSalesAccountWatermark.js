// ======================================================================
// Marca d'água de vendas ML por conta (ml_sales_last_sync_at) — usado pelo
// worker de sync, polling incremental e inbound leve do T11 (sem import circular).
//
// created_to = cursor de reconciliação ML (não avançar no webhook).
// last_sync_at = marcador inbound: só depois de persistência durável.
// ======================================================================

/**
 * Persistência durável confirmada → pode tocar o marcador inbound.
 * @param {{ ok?: unknown } | null | undefined} persistResult
 */
export function shouldTouchSalesInboundWatermark(persistResult) {
  return Boolean(persistResult && persistResult.ok === true);
}

/**
 * Máximo lexicográfico ISO-8601. Sem float. Null se nenhuma conta sincronizou.
 * @param {Array<{ ml_sales_last_sync_at?: unknown }> | null | undefined} rows
 */
export function composeSalesInboundWatermarkFromAccountRows(rows) {
  let max = null;
  for (const row of rows || []) {
    const raw = row?.ml_sales_last_sync_at;
    if (raw == null) continue;
    const iso = String(raw).trim();
    if (!iso) continue;
    if (!max || iso > max) max = iso;
  }
  return max;
}

/**
 * Atualiza só last_sync_at. Não mexe em ml_sales_last_synced_order_created_to.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} accountId
 * @param {string} nowIso
 */
export async function touchSalesInboundWatermark(supabase, accountId, nowIso) {
  const id = accountId != null ? String(accountId).trim() : "";
  if (!id) return;
  const ts = nowIso != null && String(nowIso).trim() !== "" ? String(nowIso).trim() : new Date().toISOString();
  const { error } = await supabase
    .from("marketplace_accounts")
    .update({
      ml_sales_last_sync_at: ts,
      updated_at: ts,
    })
    .eq("id", id);
  if (error) throw error;
}

/**
 * Leitura O(contas) por user_id — não varre sales_orders.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string | null} [marketplaceAccountId]
 */
export async function readSalesInboundWatermark(supabase, userId, marketplaceAccountId = null) {
  const uid = userId != null ? String(userId).trim() : "";
  if (!uid) return { watermark: null, account_count: 0 };
  let q = supabase
    .from("marketplace_accounts")
    .select("id,ml_sales_last_sync_at")
    .eq("user_id", uid);
  const acc = marketplaceAccountId != null ? String(marketplaceAccountId).trim() : "";
  if (acc) q = q.eq("id", acc);
  const { data, error } = await q;
  if (error) throw error;
  const rows = data || [];
  return {
    watermark: composeSalesInboundWatermarkFromAccountRows(rows),
    account_count: rows.length,
  };
}

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
