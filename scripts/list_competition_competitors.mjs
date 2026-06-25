#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]]) continue;
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}
for (const f of [".env.local", ".env.vercel", ".env"]) loadEnv(path.join(root, f));

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const item = process.argv[2] ? String(process.argv[2]).trim() : null;

if (item) {
  const { data: comp } = await sb
    .from("competition_competitors")
    .select("*")
    .eq("competitor_listing_id", item)
    .limit(1)
    .maybeSingle();
  const { data: snap } = comp?.id
    ? await sb
        .from("competition_snapshots")
        .select("id,sales_hint,sales_hint_source,captured_at,raw_snapshot")
        .eq("competitor_id", comp.id)
        .order("captured_at", { ascending: false })
        .limit(3)
    : { data: [] };
  console.log(JSON.stringify({ competitor: comp, snapshots: snap }, null, 2));
} else {
  const { data } = await sb
    .from("competition_competitors")
    .select("id,competitor_listing_id,competitor_title,source_strategy,competitor_permalink,created_at")
    .order("created_at", { ascending: false })
    .limit(10);
  console.log(JSON.stringify(data, null, 2));
}
