import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { listSellerNotificationInbox } from "../../src/domain/notifications/central/seller/sellerNotificationInboxService.js";

const sellerId = process.argv[2];
const eventId = process.argv[3];
if (!sellerId || !eventId) {
  console.error("uso: node scripts/output/_check_inbox_event.mjs <sellerId> <eventId>");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
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

const env = {
  ...parseDotEnv(path.join(root, ".env.vercel")),
  ...parseDotEnv(path.join(root, ".env.local")),
  ...parseDotEnv(path.join(root, ".env")),
};

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const defaultInbox = await listSellerNotificationInbox(supabase, {
  sellerId,
  limit: 100,
  includePopupOnly: false,
});
const popupAwareInbox = await listSellerNotificationInbox(supabase, {
  sellerId,
  limit: 100,
  includePopupOnly: true,
});

const inDefault = (defaultInbox.items ?? []).some((item) => String(item.event_id ?? "") === String(eventId));
const inPopupAware = (popupAwareInbox.items ?? []).some((item) => String(item.event_id ?? "") === String(eventId));

console.log(JSON.stringify({ sellerId, eventId, inDefault, inPopupAware }, null, 2));

