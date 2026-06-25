/**
 * Auditoria PI — promoções por anúncio MLB (API real + pipeline pricing-scenarios).
 *
 * Uso:
 *   node scripts/audit_pi_promotions_listing.mjs MLB6086959274
 *   node scripts/audit_pi_promotions_listing.mjs MLB6086959274 MLB6600675912
 *
 * Requer suse7-backend/.env com SUPABASE_* e credenciais ML.
 * Opcional: S7_PI_AUDIT_USER_ID=<uuid> (senão usa primeiro user com listing).
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

function loadEnv() {
  const root = resolve(process.cwd());
  for (const rel of [resolve(root, ".env"), resolve(root, "../.env")]) {
    if (!existsSync(rel)) continue;
    for (const line of readFileSync(rel, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (!m) continue;
      const k = m[1].trim();
      const v = m[2].trim().replace(/^["']|["']$/g, "");
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

loadEnv();

const listingIds = process.argv.slice(2).filter(Boolean);
if (listingIds.length === 0) {
  console.error("Informe ao menos um MLB. Ex.: node scripts/audit_pi_promotions_listing.mjs MLB6086959274");
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

process.env.S7_PROMOTIONS_PI_AUDIT = "1";

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const { buildMercadoLivreListingPricingScenariosPayload } = await import(
  "../src/domain/pricing/mercadoLivreListingPricingScenarios.js"
);

async function resolveUserIdForListing(externalId) {
  const forced = process.env.S7_PI_AUDIT_USER_ID?.trim();
  if (forced) return forced;
  const { data } = await supabase
    .from("marketplace_listings")
    .select("user_id")
    .eq("external_listing_id", externalId)
    .limit(1)
    .maybeSingle();
  return data?.user_id != null ? String(data.user_id) : null;
}

for (const listingExternalId of listingIds) {
  console.log("\n============================================================");
  console.log("AUDIT PI PROMOTIONS", listingExternalId);
  console.log("============================================================");

  const userId = await resolveUserIdForListing(listingExternalId);
  if (!userId) {
    console.error("Listing não encontrado ou S7_PI_AUDIT_USER_ID ausente:", listingExternalId);
    continue;
  }

  const result = await buildMercadoLivreListingPricingScenariosPayload(supabase, userId, {
    listingExternalId,
    scenarioScope: "pricing_opportunities",
  });

  if (!result.ok) {
    console.error("build failed:", result.error, result.status ?? "");
    continue;
  }

  const promos = Array.isArray(result.data?.promotion_scenarios) ? result.data.promotion_scenarios : [];
  const pipeline = result.data?.promotions_pipeline ?? null;

  console.log("\n--- promotions_pipeline ---");
  console.log(JSON.stringify(pipeline, null, 2));

  console.log("\n--- promotion_scenarios (summary) ---");
  for (const p of promos) {
    if (!p || typeof p !== "object") continue;
    console.log({
      promotion_id: p.promotion_id ?? null,
      promotion_name: p.promotion_name ?? null,
      status: p.status ?? null,
      ml_promotion_raw_status: p.ml_promotion_raw_status ?? null,
      sale_price_brl: p.marketplace?.sale_price_brl ?? p.sale_price_brl ?? null,
    });
  }

  console.log("\nTOTAL:", promos.length);
}
