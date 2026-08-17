#!/usr/bin/env node
/**
 * Seed controlado de amostras SSOT no DEV:
 * - 1 item -> onboarding_import / reconstructed / estimated=true
 * - 1 item -> post_suse7_sale / historical / estimated=false
 *
 * Uso:
 *   node scripts/seed_ssot_hist_target_samples.mjs
 *   node scripts/seed_ssot_hist_target_samples.mjs --onboarding-item <uuid> --post-item <uuid>
 */

import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { getValidMLToken } from "../src/handlers/ml/_helpers/mlToken.js";
import { enrichMercadoLivreSaleFinancialSnapshot } from "../src/services/marketplace/mercadoLivreSaleFinancialEnrichment.js";

dotenv.config({ path: ".env.vercel" });
dotenv.config({ path: ".env.local" });
dotenv.config();

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  return args[i + 1] != null ? String(args[i + 1]) : fallback;
};

const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY obrigatorios.");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function pickFin(raw) {
  if (!raw || typeof raw !== "object") return null;
  const fin = raw._s7_financial;
  return fin && typeof fin === "object" ? fin : null;
}

async function fetchItem(itemId) {
  const { data, error } = await sb.from("sales_order_items").select("*").eq("id", itemId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`Item nao encontrado: ${itemId}`);
  return data;
}

async function fetchOrder(orderId) {
  const { data, error } = await sb.from("sales_orders").select("*").eq("id", orderId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`Pedido nao encontrado: ${orderId}`);
  return data;
}

async function pickCandidateItems() {
  const { data, error } = await sb
    .from("sales_order_items")
    .select("id,user_id,marketplace,marketplace_account_id,sales_order_id,raw_json,updated_at")
    .eq("marketplace", "mercado_livre")
    .order("updated_at", { ascending: false })
    .limit(400);
  if (error) throw error;

  const candidates = [];
  for (const row of data ?? []) {
    if (!row.marketplace_account_id || !row.user_id || !row.sales_order_id) continue;
    const fin = pickFin(row.raw_json);
    if (!fin) continue;
    const origin = String(fin.snapshot_origin ?? "").trim();
    if (origin) continue; // preferimos origem vazia para seed limpo
    candidates.push(row);
  }
  if (candidates.length < 2) {
    throw new Error(`Nao ha candidatos suficientes com _s7_financial e snapshot_origin vazio (encontrados=${candidates.length}).`);
  }
  return { onboarding: candidates[0], post: candidates[1] };
}

async function forceSnapshotOrigin(itemId, scenario) {
  const item = await fetchItem(itemId);
  const order = await fetchOrder(item.sales_order_id);

  const marketplaceAccountId = String(item.marketplace_account_id).trim();
  const userId = String(item.user_id).trim();
  const accessToken = await getValidMLToken(userId, { marketplaceAccountId });

  const snapshotOrigin = scenario === "onboarding" ? "onboarding_import" : "post_suse7_sale";
  const reconstructionReferenceDate = scenario === "onboarding" ? new Date().toISOString() : null;

  await enrichMercadoLivreSaleFinancialSnapshot(sb, userId, order.raw_json ?? {}, {
    accessToken,
    marketplaceAccountId,
    salesOrderId: String(order.id),
    logContext: `ssot_seed_${scenario}`,
    force: true,
    snapshotOrigin,
    reconstructionReferenceDate,
  });

  const after = await fetchItem(itemId);
  const fin = pickFin(after.raw_json);
  return {
    item_id: itemId,
    sales_order_id: order.id,
    external_order_id: order.external_order_id ?? null,
    user_id: userId,
    marketplace_account_id: marketplaceAccountId,
    snapshot_origin: fin?.snapshot_origin ?? null,
    snapshot_quality: fin?.snapshot_quality ?? null,
    estimated: fin?.estimated ?? null,
    reconstructed_at: fin?.reconstructed_at ?? null,
    reconstruction_reference_date: fin?.reconstruction_reference_date ?? null,
    snapshot_created_at: fin?.snapshot_created_at ?? null,
    immutable_since: fin?.immutable_since ?? null,
  };
}

async function main() {
  const onboardingArg = arg("--onboarding-item", null);
  const postArg = arg("--post-item", null);

  let onboardingItemId = onboardingArg;
  let postItemId = postArg;

  if (!onboardingItemId || !postItemId) {
    const picked = await pickCandidateItems();
    onboardingItemId = onboardingItemId || picked.onboarding.id;
    postItemId = postItemId || picked.post.id;
  }

  if (onboardingItemId === postItemId) {
    throw new Error("onboarding-item e post-item precisam ser diferentes.");
  }

  console.log("[SSOT SEED] onboarding_item =", onboardingItemId);
  console.log("[SSOT SEED] post_item =", postItemId);

  const onboarding = await forceSnapshotOrigin(onboardingItemId, "onboarding");
  const post = await forceSnapshotOrigin(postItemId, "post");

  console.log("\n[SSOT SEED] RESULT");
  console.table([
    {
      scenario: "onboarding_import",
      item_id: onboarding.item_id,
      snapshot_origin: onboarding.snapshot_origin,
      snapshot_quality: onboarding.snapshot_quality,
      estimated: onboarding.estimated,
      immutable_since: onboarding.immutable_since ? "ok" : "missing",
    },
    {
      scenario: "post_suse7_sale",
      item_id: post.item_id,
      snapshot_origin: post.snapshot_origin,
      snapshot_quality: post.snapshot_quality,
      estimated: post.estimated,
      immutable_since: post.immutable_since ? "ok" : "missing",
    },
  ]);

  console.log("\n[SSOT SEED] onboarding_detail =", JSON.stringify(onboarding, null, 2));
  console.log("[SSOT SEED] post_detail =", JSON.stringify(post, null, 2));
}

main().catch((e) => {
  console.error("[SSOT SEED] fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});

