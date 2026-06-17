/**
 * Smoke test — janela e slot (BRT). Uso: node scripts/validate_daily_sales_summary_window.mjs
 */

const BRT_OFFSET_MS = -3 * 60 * 60 * 1000;

function toBrtParts(dateUtc) {
  const localMs = dateUtc.getTime() + BRT_OFFSET_MS;
  const d = new Date(localMs);
  return {
    weekday: d.getUTCDay(),
    dateKey: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`,
    hours: d.getUTCHours(),
    minutes: d.getUTCMinutes(),
  };
}

function buildBrtScheduledAtUtc(dateKey, timeHHmm) {
  const [h, m] = String(timeHHmm).split(":").map(Number);
  const iso = `${dateKey}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000-03:00`;
  return new Date(iso);
}

function calculateDailySalesSummaryWindow(input) {
  const scheduledAt = input.scheduledAt instanceof Date ? input.scheduledAt : new Date(input.scheduledAt);
  const period_end = scheduledAt;
  const lastRaw = input.lastSuccessfulRunAt;
  if (lastRaw != null && String(lastRaw).trim() !== "") {
    const last = lastRaw instanceof Date ? lastRaw : new Date(String(lastRaw));
    if (Number.isFinite(last.getTime())) {
      return { period_start: new Date(last.getTime() + 1000), period_end, fallback: "last_run" };
    }
  }
  return {
    period_start: new Date(scheduledAt.getTime() - 24 * 60 * 60 * 1000),
    period_end,
    fallback: "last_24h",
  };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const slotNow = buildBrtScheduledAtUtc("2026-06-05", "16:00");
const winFirst = calculateDailySalesSummaryWindow({ scheduledAt: slotNow });
assert(winFirst.fallback === "last_24h", "fallback last_24h");
console.log("validate_daily_sales_summary_window: OK");
