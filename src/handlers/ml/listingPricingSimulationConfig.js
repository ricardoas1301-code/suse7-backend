// ======================================================

// GET/POST /api/ml/listings/pricing-simulation-config

// Fonte canônica: marketplace_listing_health (colunas comerciais).

// Fallback legado: raw_json._s7_pricing_simulation.

// ======================================================



import { requireAuthUser } from "./_helpers/requireAuthUser.js";

import {

  mergePricingSimulationConfigIntoRawJson,

  readPricingSimulationConfigFromRawJson,

} from "../../domain/pricing/listingPricingSimulationConfig.js";

import {

  fetchListingHealthCommercialRow,

  persistListingHealthCommercial,

  readCommercialFlagsFromHealthRow,

} from "../../domain/pricing/listingHealthCommercial.js";



/**

 * @param {unknown} body

 */

function parseConfigFromBody(body) {

  const b = body && typeof body === "object" ? /** @type {Record<string, unknown>} */ (body) : {};

  const src = b.config && typeof b.config === "object" ? /** @type {Record<string, unknown>} */ (b.config) : b;

  /** @type {Record<string, { enabled: boolean; percent: string | null; amount: string | null }>} */

  const out = {};

  for (const key of ["planned_promo", "ml_ads", "affiliates", "safety_reserve"]) {

    const node = src[key];

    if (!node || typeof node !== "object") continue;

    const n = /** @type {Record<string, unknown>} */ (node);

    out[key] = {

      enabled: n.enabled === true || String(n.enabled ?? "").toLowerCase() === "true",

      percent: n.percent != null && String(n.percent).trim() !== "" ? String(n.percent).trim() : null,

      amount: n.amount != null && String(n.amount).trim() !== "" ? String(n.amount).trim() : null,

    };

  }

  return out;

}



/**

 * @param {import("../../domain/pricing/listingPricingSimulationConfig.js").PricingSimulationConfig} healthConfig

 * @param {import("../../domain/pricing/listingPricingSimulationConfig.js").PricingSimulationConfig} rawConfig

 */

function mergeConfigPreferHealth(healthConfig, rawConfig) {

  /** @type {import("../../domain/pricing/listingPricingSimulationConfig.js").PricingSimulationConfig} */

  const out = { ...rawConfig };

  for (const [key, val] of Object.entries(healthConfig)) {

    if (val && (val.enabled === true || val.percent != null)) {

      out[key] = val;

    }

  }

  return out;

}



export default async function handleListingPricingSimulationConfig(req, res) {

  if (req.method !== "GET" && req.method !== "POST") {

    return res.status(405).json({ ok: false, error: "Método não permitido" });

  }



  const auth = await requireAuthUser(req);

  if (auth.error) {

    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });

  }



  const listingId =

    req.method === "GET"

      ? req.query?.listing_id != null

        ? String(req.query.listing_id).trim()

        : ""

      : "";



  let body = {};

  if (req.method === "POST") {

    try {

      body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

    } catch {

      return res.status(400).json({ ok: false, error: "JSON inválido" });

    }

  }



  const listingIdFromBody = body.listing_id != null ? String(body.listing_id).trim() : "";

  const resolvedListingId = listingId || listingIdFromBody;



  if (!resolvedListingId) {

    return res.status(400).json({ ok: false, error: "Informe listing_id." });

  }



  const { user, supabase } = auth;



  const { data: row, error: qErr } = await supabase

    .from("marketplace_listings")

    .select("id, raw_json, marketplace, external_listing_id, marketplace_account_id, seller_company_id")

    .eq("id", resolvedListingId)

    .eq("user_id", user.id)

    .maybeSingle();



  if (qErr || !row) {

    return res.status(404).json({ ok: false, error: "Anúncio não encontrado." });

  }



  const rawConfig = readPricingSimulationConfigFromRawJson(row.raw_json);

  const marketplace = row.marketplace != null ? String(row.marketplace).trim() : "";

  const externalListingId =

    row.external_listing_id != null ? String(row.external_listing_id).trim() : "";



  let healthConfig = {};

  if (marketplace && externalListingId) {

    try {

      const healthRow = await fetchListingHealthCommercialRow(supabase, user.id, marketplace, externalListingId);

      healthConfig = readCommercialFlagsFromHealthRow(

        healthRow && typeof healthRow === "object" ? healthRow : null,

      );

    } catch (err) {

      console.warn("[ml/listings/pricing-simulation-config] health_read_failed", {

        listing_id: resolvedListingId,

        message: err && typeof err === "object" && "message" in err ? String(err.message) : String(err),

      });

    }

  }



  const config = mergeConfigPreferHealth(healthConfig, rawConfig);



  if (req.method === "GET") {

    return res.status(200).json({

      ok: true,

      listing_id: resolvedListingId,

      config,

      source: Object.keys(healthConfig).length > 0 ? "marketplace_listing_health" : "raw_json",

    });

  }



  const parsedConfig = parseConfigFromBody(body);

  const nextRaw = mergePricingSimulationConfigIntoRawJson(row.raw_json, parsedConfig);



  const { error: upErr } = await supabase

    .from("marketplace_listings")

    .update({ raw_json: nextRaw })

    .eq("id", resolvedListingId)

    .eq("user_id", user.id);



  if (upErr) {

    console.error("[ml/listings/pricing-simulation-config] raw_json_update_failed", upErr);

    return res.status(500).json({ ok: false, error: "Não foi possível salvar a configuração." });

  }



  if (marketplace && externalListingId) {

    const healthPersist = await persistListingHealthCommercial(supabase, user.id, row, parsedConfig);

    if (!healthPersist.ok && healthPersist.error === "health_commercial_columns_missing") {

      console.warn("[ml/listings/pricing-simulation-config] health_columns_missing", {

        listing_id: resolvedListingId,

      });

    } else if (!healthPersist.ok) {

      console.error("[ml/listings/pricing-simulation-config] health_persist_failed", {

        listing_id: resolvedListingId,

        error: healthPersist.error,

      });

    }

  }



  const savedHealthRow =

    marketplace && externalListingId

      ? await fetchListingHealthCommercialRow(supabase, user.id, marketplace, externalListingId)

      : null;

  const savedHealthConfig = readCommercialFlagsFromHealthRow(

    savedHealthRow && typeof savedHealthRow === "object" ? savedHealthRow : null,

  );



  return res.status(200).json({

    ok: true,

    listing_id: resolvedListingId,

    config: mergeConfigPreferHealth(savedHealthConfig, readPricingSimulationConfigFromRawJson(nextRaw)),

    source: Object.keys(savedHealthConfig).length > 0 ? "marketplace_listing_health" : "raw_json",

  });

}

