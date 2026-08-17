// ============================================================
// Observabilidade — logs mascarados (Fase 2 Delivery Engine)
// Prefixo padronizado: [S7_NOTIFICATION]
// ============================================================

const PREFIX = "[S7_NOTIFICATION]";

/** @param {string | null | undefined} phoneDigits */
export function maskPhoneForLog(phoneDigits) {
  const d = String(phoneDigits ?? "").replace(/\D/g, "");
  if (d.length <= 4) return d ? "****" : "";
  return `${d.slice(0, 2)}••••${d.slice(-2)}`;
}

/** @param {string | null | undefined} email */
export function maskEmailForLog(email) {
  const e = String(email ?? "").trim().toLowerCase();
  if (!e.includes("@")) return e ? "•••@•••" : "";
  const [box, dom] = e.split("@");
  const ob =
    box.length <= 2 ? `${box.slice(0, 1)}•` : `${box.slice(0, 2)}•••${box.slice(-1)}`;
  return `${ob}@${dom}`;
}

/**
 * Log estruturado — nunca incluir PII completa (use máscaras para destination).
 * @param {string} eventSuffix — ex.: EVENT_CREATED
 * @param {Record<string, unknown>} [payload]
 */
export function logNotification(eventSuffix, payload = {}) {
  const safe = { ...payload };
  if (safe.destination_masked == null && typeof safe.destination === "string") {
    safe.destination_masked =
      safe.notification_channel === "email"
        ? maskEmailForLog(safe.destination)
        : maskPhoneForLog(safe.destination);
    delete safe.destination;
  }
  console.info(`${PREFIX}_${eventSuffix}`, safe);
}
