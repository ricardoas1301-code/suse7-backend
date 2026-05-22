// =============================================================================
// POST /api/internal/notifications/email/process — worker outbox e-mail (DEV/job)
// Header: X-S7-Internal-Secret ou X-Job-Secret
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { processEmailOutbox } from "../../domain/notifications/central/email/processEmailOutbox.js";

/**
 * @param {import("http").IncomingMessage} req
 */
function readSecret(req) {
  const h = req.headers ?? {};
  return String(h["x-s7-internal-secret"] ?? h["x-job-secret"] ?? "").trim();
}

export async function handleProcessEmailOutbox(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  const expected = String(config.internalNotificationSecret ?? "").trim();
  const provided = readSecret(req);

  if (expected && provided !== expected) {
    return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  }

  if (!config.supabaseUrl?.trim() || !config.supabaseServiceRoleKey?.trim()) {
    return res.status(503).json({ ok: false, error: "CONFIG_ERROR" });
  }

  let batchSize = 25;
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const raw = body.batch_size ?? body.limit;
    if (raw != null) batchSize = Math.min(100, Math.max(1, Number.parseInt(String(raw), 10) || 25));
  } catch {
    /* ignore */
  }

  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const result = await processEmailOutbox(supabase, { batchSize });
    if (!result.ok) {
      return res.status(500).json({ ok: false, ...result });
    }
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message ?? "INTERNAL" });
  }
}
