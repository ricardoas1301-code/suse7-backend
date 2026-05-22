// =============================================================================
// Interface de delivery providers — strategy pattern (Fase 3.1 mock)
// =============================================================================

/**
 * @typedef {Object} NotificationDeliveryContext
 * @property {string} dispatchId
 * @property {string} sellerId
 * @property {string} channel
 * @property {string | null} destination
 * @property {string} renderedSubject
 * @property {string} renderedBody
 * @property {Record<string, unknown>} [metadata]
 * @property {import("@supabase/supabase-js").SupabaseClient} [supabase]
 */

/**
 * @typedef {Object} NotificationDeliveryResult
 * @property {boolean} ok
 * @property {boolean} [skipped]
 * @property {string} [error]
 * @property {Record<string, unknown>} [providerResponse]
 * @property {boolean} [queued]
 */

export class NotificationDeliveryProvider {
  /** @param {string} providerKey */
  constructor(providerKey) {
    this.providerKey = providerKey;
  }

  /**
   * @param {NotificationDeliveryContext} _ctx
   * @returns {Promise<NotificationDeliveryResult>}
   */
  async deliver(_ctx) {
    throw new Error("NOT_IMPLEMENTED");
  }
}
