// ============================================================
// Fingerprint determinístico para dedupe de notification_events
// ============================================================

import crypto from "crypto";

/**
 * @param {{
 *   notificationType: string,
 *   marketplaceAccountId?: string | null,
 *   entityType?: string | null,
 *   entityId?: string | null,
 *   relevanceKey?: string | null,
 * }} parts
 */
export function buildNotificationFingerprint(parts) {
  const raw = [
    String(parts.notificationType ?? "").trim(),
    parts.marketplaceAccountId != null ? String(parts.marketplaceAccountId).trim() : "",
    parts.entityType != null ? String(parts.entityType).trim() : "",
    parts.entityId != null ? String(parts.entityId).trim() : "",
    parts.relevanceKey != null ? String(parts.relevanceKey).trim() : "",
  ].join("|");

  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}
