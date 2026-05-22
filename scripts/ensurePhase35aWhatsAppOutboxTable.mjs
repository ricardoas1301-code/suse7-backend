#!/usr/bin/env node
/**
 * Verifica se a outbox WhatsApp (3.5A) existe no Supabase DEV.
 * Se ausente, imprime o SQL para colar no SQL Editor do Supabase.
 */
import { config as loadEnv } from "dotenv";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
loadEnv({ path: resolve(root, ".env.local") });

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { error } = await sb.from("s7_notification_whatsapp_outbox").select("id").limit(1);
if (!error) {
  console.log("OK: s7_notification_whatsapp_outbox presente.");
  process.exit(0);
}

if (error.code !== "PGRST205" && error.code !== "42P01") {
  console.error("Erro ao verificar tabela:", error.message);
  process.exit(1);
}

const sqlPath = resolve(
  root,
  "supabase/migrations/20260522200000_s7_notification_whatsapp_outbox_phase35a.sql"
);
console.error("FALTA: tabela s7_notification_whatsapp_outbox no DEV.");
console.error("Aplique no Supabase SQL Editor:\n");
console.log(readFileSync(sqlPath, "utf8"));
process.exit(1);
