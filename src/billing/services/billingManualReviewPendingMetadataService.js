// ======================================================================
// P0.3-C.1B-R — metadata de pending sem upsert (preserva cycle_key identity)
// ======================================================================

/**
 * Atualiza metadata operacional de pending existente — não altera cycle_key.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} admissionId
 * @param {{
 *   period_class?: string | null;
 *   classification_reason?: string | null;
 *   snapshot_origin?: string | null;
 *   official_order_at?: string | Date | null;
 *   next_recovery_at?: string | Date | null;
 * }} fields
 */
export async function touchManualReviewPendingMetadata(supabase, admissionId, fields) {
  /** @type {Record<string, unknown>} */
  const patch = { updated_at: new Date().toISOString() };

  if (fields.period_class != null) patch.period_class = String(fields.period_class);
  if (fields.classification_reason != null) {
    patch.classification_reason = String(fields.classification_reason);
  }
  if (fields.snapshot_origin != null) patch.snapshot_origin = String(fields.snapshot_origin);
  if (fields.official_order_at instanceof Date) {
    patch.official_order_at = fields.official_order_at.toISOString();
  } else if (fields.official_order_at != null) {
    patch.official_order_at = String(fields.official_order_at);
  }
  if (fields.next_recovery_at instanceof Date) {
    patch.next_recovery_at = fields.next_recovery_at.toISOString();
  } else if (fields.next_recovery_at != null) {
    patch.next_recovery_at = String(fields.next_recovery_at);
  }

  const { error } = await supabase
    .from("billing_billable_sale_admissions")
    .update(patch)
    .eq("id", admissionId)
    .eq("admission_result", "PENDING_MANUAL_REVIEW");

  if (error) throw error;
}

/**
 * Ciclo comercial determinável para materialização — null = indeterminado (não inventar).
 *
 * @param {Record<string, unknown>} classified
 * @param {Record<string, unknown>} metadata
 */
export function resolvePendingMaterializationCycleKey(classified, metadata) {
  if (classified.cycle_key != null && String(classified.cycle_key).trim() !== "") {
    return String(classified.cycle_key);
  }

  if (classified.manual_review_required === true) {
    return null;
  }

  if (
    classified.reason === "cycle_window_unresolved" ||
    classified.reason === "quota_counting_started_at_missing"
  ) {
    return null;
  }

  const quotaStartRaw = metadata.quota_counting_started_at;
  if (quotaStartRaw == null || String(quotaStartRaw).trim() === "") {
    return null;
  }

  return null;
}

/**
 * @param {string | null | undefined} rowCycleKey
 * @param {string | null | undefined} targetCycleKey
 */
export function pendingCycleKeysAligned(rowCycleKey, targetCycleKey) {
  const row = rowCycleKey != null ? String(rowCycleKey).trim() : "";
  const target = targetCycleKey != null ? String(targetCycleKey).trim() : "";
  if (!row || !target) return false;
  return row === target;
}
