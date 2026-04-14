#!/usr/bin/env node
/**
 * Evidência no banco (service role): lista linhas em public.product_variants para um product_id.
 *
 * Uso (na pasta suse7-backend, com .env contendo SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY):
 *   node scripts/inspect-product-variants.mjs <uuid_do_produto>
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const productId = process.argv[2];
if (!productId || String(productId).trim() === "") {
  console.error("Uso: node scripts/inspect-product-variants.mjs <product_uuid>");
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env da raiz do backend.");
  process.exit(1);
}

const supabase = createClient(url, key);
const pid = String(productId).trim();

const { data: rows, error } = await supabase
  .from("product_variants")
  .select("*")
  .eq("product_id", pid)
  .order("sort_order", { ascending: true });

if (error) {
  console.error("Erro Supabase:", error);
  process.exit(1);
}

const list = rows || [];
console.log("--- product_variants ---");
console.log("product_id:", pid);
console.log("quantidade de linhas:", list.length);
if (list.length === 0) {
  console.log("Resposta objetiva: NÃO há linhas para este product_id.");
  process.exit(0);
}

console.log("Resposta objetiva: SIM, há linhas.");
list.forEach((r, i) => {
  console.log(`\n[#${i + 1}]`, {
    id: r.id,
    product_id: r.product_id,
    user_id: r.user_id,
    sku: r.sku,
    stock_quantity: r.stock_quantity,
    stock_minimum: r.stock_minimum,
    cost_price: r.cost_price,
    attributes: r.attributes,
    attributesType: typeof r.attributes,
    sort_order: r.sort_order,
  });
});
