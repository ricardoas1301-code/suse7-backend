#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { listSellerNotificationInbox } from "../src/domain/notifications/central/seller/sellerNotificationInboxService.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function brtNow() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" })
  );
}

function hhmmBrtFromNow(addMinutes) {
  const d = new Date(Date.now() + addMinutes * 60_000);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

function buildBrtScheduledAtUtcToday(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  const now = brtNow();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return new Date(`${y}-${mo}-${d}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-03:00`);
}

const env = {
  ...parseDotEnv(path.join(root, ".env.vercel")),
  ...parseDotEnv(path.join(root, ".env.local")),
  ...parseDotEnv(path.join(root, ".env")),
};

const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE env ausente");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SELLER_ID = process.argv[2] || "c8a62ec6-cfbe-4ad9-98ea-49fadebeda50"; // RF
const START_IN_MIN = Number.isFinite(Number(process.argv[3])) ? Number(process.argv[3]) : 3;
const STEP_MIN = Number.isFinite(Number(process.argv[4])) ? Number(process.argv[4]) : 3;
const MAX_WAIT_MS = Number.isFinite(Number(process.argv[5])) ? Number(process.argv[5]) : 7 * 60_000;
const ONLY_SCENARIO = String(process.argv[6] ?? "").trim().toLowerCase();

const scenarios = [
  { key: "c1", name: "Sininho ON / Pop-up OFF", channels: { in_app: true, popup: false }, expected: { bell: true, popup: false } },
  { key: "c2", name: "Sininho OFF / Pop-up ON", channels: { in_app: false, popup: true }, expected: { bell: false, popup: true } },
  { key: "c3", name: "Sininho ON / Pop-up ON", channels: { in_app: true, popup: true }, expected: { bell: true, popup: true } },
  { key: "c4", name: "Sininho OFF / Pop-up OFF", channels: { in_app: false, popup: false }, expected: { bell: false, popup: false } },
];
const selectedScenarios =
  ONLY_SCENARIO && scenarios.some((s) => s.key === ONLY_SCENARIO)
    ? scenarios.filter((s) => s.key === ONLY_SCENARIO)
    : scenarios;

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadRule() {
  const { data, error } = await supabase
    .from("s7_notification_automation_rules")
    .select("id,seller_id,enabled,config,updated_at")
    .eq("seller_id", SELLER_ID)
    .eq("category_code", "SALES")
    .eq("type_key", "DAILY_SALES_SUMMARY")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("regra DAILY_SALES_SUMMARY nao encontrada");
  return data;
}

async function updateRuleForScenario(baseRule, slotBrt, scenario) {
  const cfg = baseRule.config && typeof baseRule.config === "object" ? { ...baseRule.config } : {};
  const prevChannels = cfg.channels && typeof cfg.channels === "object" ? { ...cfg.channels } : {};
  cfg.channels = {
    ...prevChannels,
    in_app: scenario.channels.in_app,
    popup: scenario.channels.popup,
  };
  cfg.times = [slotBrt];
  // Garante sábado para os cenários 1-4 (o teste de sábado desmarcado é auditado separadamente).
  cfg.weekdays = [1, 2, 3, 4, 5, 6];

  const { data, error } = await supabase
    .from("s7_notification_automation_rules")
    .update({ config: cfg, enabled: true, updated_at: new Date().toISOString() })
    .eq("id", baseRule.id)
    .select("id,seller_id,enabled,config,updated_at")
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function waitRun(scheduledAtIso) {
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT_MS) {
    const { data, error } = await supabase
      .from("s7_notification_automation_runs")
      .select("id,seller_id,scheduled_at,created_at,status,event_id,error_message")
      .eq("seller_id", SELLER_ID)
      .eq("type_key", "DAILY_SALES_SUMMARY")
      .eq("scheduled_at", scheduledAtIso)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data) return data;
    await sleep(5000);
  }
  return null;
}

async function waitRunReady(runId) {
  const started = Date.now();
  while (Date.now() - started < 4 * 60_000) {
    const { data, error } = await supabase
      .from("s7_notification_automation_runs")
      .select("id,seller_id,scheduled_at,created_at,status,event_id,error_message,completed_at")
      .eq("id", runId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const hasTerminalStatus = data.status === "completed" || data.status === "failed";
    if (data.event_id || hasTerminalStatus) return data;
    await sleep(4000);
  }
  return null;
}

async function fetchEvidence(run) {
  const eventId = run?.event_id ?? null;
  let event = null;
  let dispatches = [];
  if (eventId) {
    const evRes = await supabase
      .from("s7_notification_events")
      .select("id,created_at,payload,metadata")
      .eq("id", eventId)
      .maybeSingle();
    if (evRes.error) throw evRes.error;
    event = evRes.data;

    const dRes = await supabase
      .from("s7_notification_dispatches")
      .select("id,channel,status,created_at,sent_at,event_id")
      .eq("event_id", eventId)
      .order("created_at", { ascending: true });
    if (dRes.error) throw dRes.error;
    dispatches = Array.isArray(dRes.data) ? dRes.data : [];
  }

  const inboxDefault = await listSellerNotificationInbox(supabase, {
    sellerId: SELLER_ID,
    limit: 50,
    includePopupOnly: false,
  });
  const inboxPopupAware = await listSellerNotificationInbox(supabase, {
    sellerId: SELLER_ID,
    limit: 50,
    includePopupOnly: true,
  });

  const hasInDefaultInbox = Boolean(
    eventId && (inboxDefault.items ?? []).some((item) => String(item.event_id ?? "") === String(eventId))
  );
  const hasInPopupAwareInbox = Boolean(
    eventId && (inboxPopupAware.items ?? []).some((item) => String(item.event_id ?? "") === String(eventId))
  );

  return { event, dispatches, hasInDefaultInbox, hasInPopupAwareInbox };
}

function summaryLine(scenario, slotBrt, scheduledAtIso, run, evidence) {
  const channels = evidence.event?.payload?.channels ?? null;
  const internalDispatches = (evidence.dispatches ?? []).filter((d) => String(d.channel) === "in_app");
  return {
    scenario: scenario.name,
    seller_id: SELLER_ID,
    slot_brt: slotBrt,
    scheduled_at: scheduledAtIso,
    run_id: run?.id ?? null,
    created_at: run?.created_at ?? null,
    status: run?.status ?? "not_created",
    payload_channels: channels,
    internal_dispatch_count: internalDispatches.length,
    internal_dispatch_statuses: internalDispatches.map((d) => d.status),
    in_default_inbox: evidence.hasInDefaultInbox,
    in_popup_aware_inbox: evidence.hasInPopupAwareInbox,
    expected_bell: scenario.expected.bell,
    expected_popup: scenario.expected.popup,
  };
}

async function main() {
  console.log(`[START] seller=${SELLER_ID} now_utc=${new Date().toISOString()}`);
  const base = await loadRule();
  console.log(`[BASE_RULE] weekdays=${JSON.stringify(base?.config?.weekdays)} times=${JSON.stringify(base?.config?.times)} channels=${JSON.stringify(base?.config?.channels)}`);
  const baseStartMin = START_IN_MIN;

  /** @type {Array<Record<string, unknown>>} */
  const results = [];
  for (let i = 0; i < selectedScenarios.length; i += 1) {
    const scenario = selectedScenarios[i];
    const slotBrt = hhmmBrtFromNow(baseStartMin + i * STEP_MIN);
    const scheduledAtUtc = buildBrtScheduledAtUtcToday(slotBrt);
    if (!scheduledAtUtc) throw new Error(`slot invalido: ${slotBrt}`);
    const scheduledIso = scheduledAtUtc.toISOString();

    console.log(`\n[SCENARIO_START] ${scenario.key} ${scenario.name}`);
    console.log(`[SCENARIO_CONFIG] slot_brt=${slotBrt} scheduled_utc=${scheduledIso} channels=${JSON.stringify(scenario.channels)}`);
    const updated = await updateRuleForScenario(base, slotBrt, scenario);
    console.log(`[RULE_UPDATED] updated_at=${updated.updated_at} times=${JSON.stringify(updated?.config?.times)} weekdays=${JSON.stringify(updated?.config?.weekdays)} channels=${JSON.stringify(updated?.config?.channels)}`);

    const run = await waitRun(scheduledIso);
    if (!run) {
      const fail = {
        scenario: scenario.name,
        seller_id: SELLER_ID,
        slot_brt: slotBrt,
        scheduled_at: scheduledIso,
        run_id: null,
        created_at: null,
        status: "not_created_within_timeout",
      };
      console.log(`[SCENARIO_TIMEOUT] ${JSON.stringify(fail)}`);
      results.push(fail);
      continue;
    }

    const readyRun = await waitRunReady(run.id);
    const effectiveRun = readyRun ?? run;
    const evidence = await fetchEvidence(effectiveRun);
    const summary = summaryLine(scenario, slotBrt, scheduledIso, effectiveRun, evidence);
    console.log(`[SCENARIO_RESULT] ${JSON.stringify(summary)}`);
    results.push(summary);
  }

  console.log(`\n[FINAL_RESULTS] ${JSON.stringify(results, null, 2)}`);
}

main().catch((err) => {
  console.error("[FATAL]", err?.stack || err?.message || String(err));
  process.exit(1);
});

