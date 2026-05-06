/**
 * Validação Clientes 360 — enriquecimento de contato (pós-migration).
 * Não imprime e-mail/telefone completos; apenas amostras mascaradas e contagens.
 *
 * Uso (na pasta suse7-backend): node scripts/runContactEnrichmentValidation.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function loadEnv() {
  for (const name of [".env.local", ".env"]) {
    try {
      const p = join(root, name);
      const raw = readFileSync(p, "utf8");
      for (const line of raw.split("\n")) {
        const m = line.match(/^([^#=]+)=(.*)$/);
        if (!m) continue;
        const k = m[1].trim();
        let v = m[2].trim().replace(/^["']|["']$/g, "");
        if (!(k in process.env)) process.env[k] = v;
      }
    } catch {
      /* ignore */
    }
  }
}

function maskEmail(email) {
  if (!email || typeof email !== "string") return null;
  const [loc, dom] = email.split("@");
  if (!dom) return "***";
  const head = loc.slice(0, Math.min(2, loc.length));
  return `${head}***@${dom}`;
}

function maskPhoneDigits(e164) {
  if (!e164 || typeof e164 !== "string") return null;
  const d = e164.replace(/\D/g, "");
  if (d.length < 4) return "***";
  return `***…${d.slice(-4)} (E.164)`;
}

loadEnv();

const url = process.env.SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!url || !key) {
  console.error("[validate] Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env / .env.local");
  process.exit(2);
}

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const { data: probe, error: probeErr } = await supabase
  .from("marketplace_customers")
  .select("id, email, email_is_masked, phone_area_code, phone_number, whatsapp_e164, contact_source, contact_updated_at")
  .limit(1);

if (probeErr) {
  const msg = probeErr.message || String(probeErr);
  console.error("[validate] Falha ao ler marketplace_customers:", msg);
  if (/column|schema|does not exist/i.test(msg)) {
    console.error("[validate] Provável causa: migration 20260505183000_marketplace_customers_contact_enrichment.sql não aplicada.");
  }
  process.exit(1);
}

async function countExact(builder) {
  const { count, error } = await builder.select("id", { count: "exact", head: true });
  if (error) throw error;
  return count ?? 0;
}

const total = await countExact(supabase.from("marketplace_customers"));
const withEmail = await countExact(supabase.from("marketplace_customers").not("email", "is", null));
const withWa = await countExact(supabase.from("marketplace_customers").not("whatsapp_e164", "is", null));
const semContato = await countExact(
  supabase
    .from("marketplace_customers")
    .is("email", null)
    .is("phone", null)
    .is("whatsapp", null)
    .is("whatsapp_e164", null)
);

const { data: sampleMasked } = await supabase
  .from("marketplace_customers")
  .select("id, email, email_is_masked, whatsapp_e164, contact_source")
  .eq("email_is_masked", true)
  .limit(5);

const { data: sampleWa } = await supabase
  .from("marketplace_customers")
  .select("id, whatsapp_e164, contact_source")
  .not("whatsapp_e164", "is", null)
  .limit(3);

console.log("=== Clientes 360 — validação enriquecimento de contato ===");
console.log("Migration esperada: 20260505183000_marketplace_customers_contact_enrichment.sql");
console.log("Colunas novas: OK (select de teste retornou sem erro de schema)");
console.log("");
console.log("Contagens (marketplace_customers):");
console.log(`  total_clientes: ${total}`);
console.log(`  com_email: ${withEmail}`);
console.log(`  com_whatsapp_e164: ${withWa}`);
console.log(`  sem_contato (sem email, phone, whatsapp, whatsapp_e164): ${semContato}`);
console.log("");
console.log("Amostra mascarada (até 3 linhas com e-mail mascarado ou flag):");
for (const row of sampleMasked ?? []) {
  console.log(
    `  id=${row.id} email=${maskEmail(row.email)} email_is_masked=${row.email_is_masked} wa=${maskPhoneDigits(row.whatsapp_e164)} source=${row.contact_source ?? "null"}`
  );
}
if (!(sampleMasked ?? []).length) console.log("  (nenhum registro com indicador de mascaramento encontrado)");
console.log("");
console.log("Amostra WhatsApp E.164 (até 3, só dígitos finais):");
for (const row of sampleWa ?? []) {
  console.log(`  id=${row.id} whatsapp_e164=${maskPhoneDigits(row.whatsapp_e164)} source=${row.contact_source ?? "null"}`);
}
if (!(sampleWa ?? []).length) console.log("  (nenhum whatsapp_e164 preenchido — normal se o ML nao enviou telefone nos pedidos)");

console.log("");
console.log("Próximos passos manuais:");
console.log("  1) SQL Editor: aplicar migration se ainda não aplicada.");
console.log("  2) POST /api/customers/ingest-from-sales (autenticado) ou sync de vendas com ingestão ligada.");
console.log("  3) Frontend /clientes: checar grid + drawer + link wa.me.");
