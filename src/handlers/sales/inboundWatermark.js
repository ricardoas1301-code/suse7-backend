// ======================================================================
// GET /api/sales/inbound-watermark — marcador leve tenant-aware (T11 Option B).
// Lê marketplace_accounts (O(contas do seller)). Sem scan da tabela de pedidos.
// ======================================================================

import { createHash } from "node:crypto";
import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { gatePremiumHandler } from "../../billing/middleware/requirePlanAccess.js";
import { readSalesInboundWatermark } from "../../services/marketplace/mlSalesAccountWatermark.js";

function buildEtag(watermark, scope, accountCount) {
  const payload = JSON.stringify({
    w: watermark ?? "",
    s: scope,
    n: accountCount,
  });
  return `"${createHash("sha1").update(payload).digest("hex")}"`;
}

export default async function handleSalesInboundWatermark(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    if (auth.error.code === "CONFIG_ERROR") {
      return res.status(200).json({ ok: true, watermark: null, scope: "all", account_count: 0 });
    }
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  if (await gatePremiumHandler(res, supabase, user.id, { module: "vendas" })) return;

  const marketplaceAccountId =
    req.query?.marketplace_account_id != null && String(req.query.marketplace_account_id).trim() !== ""
      ? String(req.query.marketplace_account_id).trim()
      : null;
  const scope = marketplaceAccountId ? "account" : "all";

  try {
    const { watermark, account_count } = await readSalesInboundWatermark(
      supabase,
      user.id,
      marketplaceAccountId
    );
    const etag = buildEtag(watermark, scope, account_count);
    const inm = req.headers?.["if-none-match"];
    if (inm != null && String(inm).trim() === etag) {
      res.setHeader("ETag", etag);
      res.setHeader("Cache-Control", "private, no-store");
      return res.status(304).end();
    }
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).json({
      ok: true,
      watermark,
      scope,
      account_count,
    });
  } catch (error) {
    console.error("[Suse7][API][sales-inbound-watermark] failed", {
      message: error?.message ?? String(error),
    });
    return res.status(200).json({
      ok: true,
      watermark: null,
      scope,
      account_count: 0,
      degraded: true,
    });
  }
}
