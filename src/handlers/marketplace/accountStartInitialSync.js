// ======================================================================
// POST /api/marketplace/accounts/:id/start-initial-sync
// Enfileira onda inicial (jobs) — idempotente via createMlInitialSyncJobsIfAbsent.
// ======================================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { ML_MARKETPLACE_SLUG } from "../ml/_helpers/mlMarketplace.js";
import { createMlInitialSyncJobsIfAbsent } from "../../services/marketplace/createMlInitialSyncJobs.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {string} path
 */
export default async function handleMarketplaceAccountStartInitialSync(req, res, path) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  const m = path.match(/^\/api\/marketplace\/accounts\/([^/]+)\/start-initial-sync$/);
  const accountId = m?.[1] ?? null;
  if (!accountId || !UUID_REGEX.test(accountId)) {
    return res.status(400).json({ ok: false, error: "ID inválido." });
  }

  try {
    const { data: acc, error: accErr } = await supabase
      .from("marketplace_accounts")
      .select("id, seller_company_id, marketplace, status")
      .eq("id", accountId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (accErr) {
      console.error("[marketplace/start-initial-sync] account_query", accErr);
      return res.status(500).json({ ok: false, error: "Erro ao carregar conta." });
    }
    if (!acc?.id) {
      return res.status(404).json({ ok: false, error: "Conta não encontrada." });
    }

    const mp = String(acc.marketplace || "").trim();
    if (mp !== ML_MARKETPLACE_SLUG) {
      return res.status(400).json({ ok: false, error: "Tipo de marketplace não suportado nesta rota." });
    }

    if (String(acc.status || "").toLowerCase() !== "active") {
      return res.status(400).json({ ok: false, error: "Conta inativa; reconecte o Mercado Livre." });
    }

    const sellerCompanyId =
      acc.seller_company_id != null && String(acc.seller_company_id).trim() !== ""
        ? String(acc.seller_company_id).trim()
        : null;

    const result = await createMlInitialSyncJobsIfAbsent(supabase, {
      userId: user.id,
      marketplaceAccountId: accountId,
      sellerCompanyId,
    });

    return res.status(200).json({
      ok: true,
      marketplace_account_id: accountId,
      created: result.created,
      skipped: result.skipped,
    });
  } catch (e) {
    console.error("[marketplace/start-initial-sync]", e);
    return res.status(500).json({ ok: false, error: "Erro interno." });
  }
}
