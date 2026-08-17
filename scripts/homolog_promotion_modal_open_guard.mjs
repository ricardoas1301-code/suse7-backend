#!/usr/bin/env node
/**
 * S1.PROMO-LIVE-ON-OPEN-GLOBAL-PARITY-GUARD — aceite modal PI sem sync manual
 * Uso: node suse7-backend/scripts/homolog_promotion_modal_open_guard.mjs [MLB...]
 */
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDir, "..");
const require = createRequire(path.join(backendRoot, "package.json"));
const { createClient } = require("@supabase/supabase-js");

function parseDotEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const out = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = {
  ...parseDotEnv(path.join(backendRoot, ".env.vercel")),
  ...parseDotEnv(path.join(backendRoot, ".env.local")),
  ...process.env,
};
for (const [k, v] of Object.entries(env)) {
  if (v && !process.env[k]) process.env[k] = v;
}

import { buildMercadoLivreListingPricingScenariosPayload } from "../src/domain/pricing/mercadoLivreListingPricingScenarios.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function resolveUserIdForListing(supabase, listingExternalId) {
  const fromEnv = process.env.S7_HOMOLOG_USER_ID ?? process.env.HOMOLOG_USER_ID;
  if (fromEnv) return String(fromEnv);
  const { data: listing } = await supabase
    .from("marketplace_listings")
    .select("user_id")
    .eq("external_listing_id", listingExternalId)
    .maybeSingle();
  return listing?.user_id != null ? String(listing.user_id) : null;
}

const HOMOLOGADOS = ["MLB6086602390", "MLB6086986228", "MLB6784329822"];
const ALEATORIOS_DEFAULT = [
  "MLB6415546858",
  "MLB6487881250",
  "MLB6248404078",
  "MLB3734084847",
  "MLB6415478372",
];

const argvListings = process.argv.slice(2).filter(Boolean);
const TARGETS =
  argvListings.length > 0
    ? argvListings
    : [...HOMOLOGADOS, ...ALEATORIOS_DEFAULT.filter((id) => !HOMOLOGADOS.includes(id))];

/** @param {unknown} row */
function cardFromScenario(row) {
  if (row == null || typeof row !== "object") return null;
  const c = /** @type {Record<string, unknown>} */ (row).promotion_card_contract;
  return c != null && typeof c === "object" ? /** @type {Record<string, unknown>} */ (c) : null;
}

async function homologListing(supabase, userId, listingExternalId) {
  const result = await buildMercadoLivreListingPricingScenariosPayload(supabase, userId, {
    listingExternalId,
    // Sem scenarioScope — espelha frontend PI (handler default pricing_opportunities)
  });

  if (!result.ok) {
    return {
      listing_id: listingExternalId,
      ok: false,
      error: result.error,
      promo_count: 0,
      live_ok: false,
      stale_silent: false,
      sources: [],
    };
  }

  const promos = Array.isArray(result.data?.promotion_scenarios)
    ? /** @type {Record<string, unknown>[]} */ (result.data.promotion_scenarios)
    : [];

  /** @type {string[]} */
  const sources = [];
  let staleSilent = false;
  let liveOk = false;

  for (const row of promos) {
    const card = cardFromScenario(row);
    if (!card) continue;
    const src = card.promotion_payload_source != null ? String(card.promotion_payload_source) : "missing";
    sources.push(src);
    if (src === "live" || src === "cache_fresh") liveOk = liveOk || true;
    if (src === "cache_stale_blocked") staleSilent = false;
    if (
      src !== "live" &&
      src !== "cache_fresh" &&
      src !== "cache_stale_blocked" &&
      card.promotion_payload_stale_blocked !== true
    ) {
      staleSilent = true;
    }
    const selectedSource = card.selected_source ?? card.selected_source_path;
    if (selectedSource == null || String(selectedSource).trim() === "") {
      staleSilent = true;
    }
  }

  const anyLive = sources.includes("live");
  const anyFresh = sources.includes("cache_fresh");
  const anyBlocked = sources.includes("cache_stale_blocked");
  const acceptable = promos.length === 0 || anyLive || anyFresh || anyBlocked;

  return {
    listing_id: listingExternalId,
    ok: acceptable && !staleSilent,
    promo_count: promos.length,
    live_ok: anyLive,
    cache_fresh: anyFresh,
    stale_blocked: anyBlocked,
    stale_silent: staleSilent,
    sources: [...new Set(sources)],
    sample: promos.slice(0, 2).map((row) => {
      const card = cardFromScenario(row);
      return {
        promotion_name: card?.promotion_name ?? row.promotion_name ?? null,
        selected_final_price: card?.selected_final_price ?? null,
        selected_source: card?.selected_source ?? null,
        promotion_payload_source: card?.promotion_payload_source ?? null,
        promotion_payload_age_ms: card?.promotion_payload_age_ms ?? null,
      };
    }),
  };
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY");
    process.exit(2);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log("[HOMOLOG_MODAL_OPEN_GUARD] listings:", TARGETS.join(", "));
  console.log("");

  /** @type {Awaited<ReturnType<typeof homologListing>>[]} */
  const rows = [];
  for (const listingId of TARGETS) {
    process.stdout.write(`→ ${listingId} ... `);
    try {
      const userId = await resolveUserIdForListing(supabase, listingId);
      if (!userId) {
        rows.push({
          listing_id: listingId,
          ok: false,
          error: "user_id não encontrado para listing",
          promo_count: 0,
          live_ok: false,
          stale_silent: true,
          sources: [],
        });
        console.log("FAIL (sem user_id)");
        continue;
      }
      const row = await homologListing(supabase, userId, listingId);
      rows.push(row);
      console.log(row.ok ? "OK" : "FAIL", `(promos=${row.promo_count}, sources=${row.sources.join("|")})`);
      if (row.sample?.length) {
        for (const s of row.sample) {
          console.log(
            `    ${s.promotion_name}: ${s.selected_final_price} | src=${s.promotion_payload_source} | rule_src=${s.selected_source}`
          );
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      rows.push({
        listing_id: listingId,
        ok: false,
        error: msg,
        promo_count: 0,
        live_ok: false,
        stale_silent: true,
        sources: [],
      });
      console.log("ERROR", msg);
    }
  }

  console.log("\n| Listing | Promos | Live | Fresh | Stale blocked | Aceite |");
  console.log("|---------|--------|------|-------|---------------|--------|");
  for (const r of rows) {
    console.log(
      `| ${r.listing_id} | ${r.promo_count} | ${r.live_ok ? "✓" : "—"} | ${r.cache_fresh ? "✓" : "—"} | ${r.stale_blocked ? "✓" : "—"} | ${r.ok ? "✓" : "✗"} |`
    );
  }

  const failed = rows.filter((r) => !r.ok).length;
  if (failed > 0) process.exit(1);
}

main();
