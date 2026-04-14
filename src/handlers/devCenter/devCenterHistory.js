// ======================================================
// Dev Center — histórico de eventos (dev_history)
// ======================================================

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ missionId: string; eventType: string; content?: Record<string, unknown> | null; userId?: string | null }} p
 */
export async function insertDevHistory(supabase, { missionId, eventType, content, userId }) {
  const { error } = await supabase.from("dev_history").insert({
    mission_id: missionId,
    event_type: eventType,
    content: content ?? null,
    created_by: userId ?? null,
  });
  if (error) {
    console.warn("[dev-center] insertDevHistory", eventType, error);
  }
}
