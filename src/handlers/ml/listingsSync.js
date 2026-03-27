// ======================================================
// POST /api/ml/sync-listings
// Importa anúncios do Mercado Livre do vendedor autenticado e persiste
// em marketplace_* (raw_json + snapshot por item).
// ======================================================

import { requireAuthUser } from "./_helpers/requireAuthUser.js";
import { getValidMLToken } from "./_helpers/mlToken.js";
import { ML_MARKETPLACE_SLUG } from "./_helpers/mlMarketplace.js";
import {
  fetchUserItemIdsPage,
  fetchItem,
  fetchItemDescription,
} from "./_helpers/mercadoLibreItemsApi.js";
import { persistMercadoLibreListing } from "./_helpers/mlListingsPersist.js";

const PAGE_LIMIT = 100;
const MAX_ITEMS = Math.min(10000, Math.max(1, parseInt(process.env.ML_SYNC_MAX_ITEMS || "3000", 10) || 3000));
const BATCH_CONCURRENCY = Math.min(
  12,
  Math.max(1, parseInt(process.env.ML_SYNC_BATCH_CONCURRENCY || "4", 10) || 4)
);

export default async function handleMlListingsSync(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  const userId = user.id;
  const logPrefix = "[ml/sync-listings]";
  const failures = [];

  try {
    // ------------------------------
    // Vendedor ML (ml_user_id salvo no OAuth)
    // ------------------------------
    const { data: tokRow, error: tokErr } = await supabase
      .from("ml_tokens")
      .select("ml_user_id")
      .eq("user_id", userId)
      .eq("marketplace", ML_MARKETPLACE_SLUG)
      .maybeSingle();

    if (tokErr || !tokRow?.ml_user_id) {
      console.error(logPrefix, "no_ml_tokens", { tokErr, userId });
      return res.status(400).json({
        ok: false,
        error:
          "Conta Mercado Livre não conectada. Conclua o OAuth em Perfil → Integrações antes de sincronizar.",
      });
    }

    let accessToken;
    try {
      accessToken = await getValidMLToken(userId);
    } catch (e) {
      console.error(logPrefix, "token_error", { message: e?.message, userId });
      return res.status(401).json({
        ok: false,
        error: "Não foi possível obter token válido do Mercado Livre. Reconecte a integração.",
      });
    }

    const sellerId = String(tokRow.ml_user_id);
    console.log(logPrefix, "start", { userId, sellerId, maxItems: MAX_ITEMS, batch: BATCH_CONCURRENCY });

    // ------------------------------
    // Coletar IDs (paginação até esgotar ou MAX_ITEMS)
    // ------------------------------
    const allIds = [];
    let offset = 0;

    while (allIds.length < MAX_ITEMS) {
      const page = await fetchUserItemIdsPage(accessToken, sellerId, offset, PAGE_LIMIT);
      const batch = page.results || [];
      if (batch.length === 0) break;

      for (const id of batch) {
        if (allIds.length >= MAX_ITEMS) break;
        allIds.push(String(id));
      }

      offset += batch.length;
      console.log(logPrefix, "search_page", { offset, collected: allIds.length, pageSize: batch.length });

      if (batch.length < PAGE_LIMIT) break;
    }

    console.log(logPrefix, "ids_ready", { total: allIds.length });

    const started = Date.now();
    let imported = 0;

    const logItem = (msg, extra) => console.log(logPrefix, msg, extra || {});

    async function processOne(itemId) {
      const item = await fetchItem(accessToken, itemId);
      let description = null;
      try {
        description = await fetchItemDescription(accessToken, itemId);
      } catch (de) {
        logItem("description_skip", { itemId, reason: de?.message, status: de?.status });
      }

      await persistMercadoLibreListing(supabase, userId, item, description, {
        log: (m, x) => logItem(m, { itemId, ...x }),
      });
    }

    // ------------------------------
    // Importação em lotes (controle de taxa / paralelismo)
    // ------------------------------
    for (let i = 0; i < allIds.length; i += BATCH_CONCURRENCY) {
      const chunk = allIds.slice(i, i + BATCH_CONCURRENCY);
      const results = await Promise.allSettled(chunk.map((id) => processOne(id)));

      results.forEach((r, j) => {
        const itemId = chunk[j];
        if (r.status === "fulfilled") {
          imported += 1;
        } else {
          const errMsg = r.reason?.message || String(r.reason);
          failures.push({ item_id: itemId, error: errMsg });
          console.error(logPrefix, "item_failed", { itemId, error: errMsg });
        }
      });
    }

    const duration_ms = Date.now() - started;
    console.log(logPrefix, "done", {
      scanned: allIds.length,
      imported,
      failed: failures.length,
      duration_ms,
    });

    return res.status(200).json({
      ok: true,
      summary: {
        scanned: allIds.length,
        imported,
        failed: failures.length,
        duration_ms,
      },
      failures: failures.slice(0, 100),
    });
  } catch (err) {
    console.error(logPrefix, "fatal", { message: err?.message, stack: err?.stack });
    return res.status(500).json({
      ok: false,
      error: err?.message || "Erro ao sincronizar anúncios",
    });
  }
}
