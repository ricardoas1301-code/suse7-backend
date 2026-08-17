// ======================================================================
// Relatório de cobertura — importação histórica de vendas ML por job.
// Tabela opcional: se não existir no projeto, upsert falha silenciosamente no worker.
// ======================================================================

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} row
 */
export async function upsertMarketplaceSalesImportCoverage(supabase, row) {
  const payload = {
    ...row,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("marketplace_account_sales_import_coverage").upsert(payload, {
    onConflict: "source_job_id",
  });
  if (error) throw error;
}
