// ============================================================
// S7 — Concorrência: logs DEV do parser de links ML
// ============================================================

export function competitionLinkParseLogEnabled() {
  const explicit = String(process.env.S7_COMPETITION_DEBUG ?? "").trim();
  if (explicit === "1") return true;
  const audit = String(process.env.S7_COMPETITION_SALES_AUDIT ?? "").trim();
  if (audit === "1") return true;
  return process.env.NODE_ENV !== "production";
}

export function logCompetitionLinkParse(payload = {}) {
  if (!competitionLinkParseLogEnabled()) return;
  console.info("[S7_COMPETITION_LINK_PARSE]", {
    at: new Date().toISOString(),
    ...payload,
  });
}

export function logCompetitionLinkParseWarning(payload = {}) {
  if (!competitionLinkParseLogEnabled()) return;
  console.warn("[S7_COMPETITION_LINK_PARSE_WARNING]", {
    at: new Date().toISOString(),
    ...payload,
  });
}
