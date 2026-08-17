// =============================================================================
// Dispatch Engine — nome público estável.
// Fase S5.2: delega ao Dispatcher Central consolidado (observabilidade +
// status por canal), que por sua vez roda o Notification Actions Engine.
// O contrato de retorno legado é preservado e apenas enriquecido.
// =============================================================================

import { runCentralDispatcher } from "../dispatcherCentral/centralDispatcher.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} event
 * @param {Record<string, unknown>} [options]
 */
export async function runNotificationDispatchEngine(supabase, event, options = {}) {
  return runCentralDispatcher(supabase, event, options);
}
