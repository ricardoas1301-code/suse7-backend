// ============================================================
// S7 — Concorrência: loja + medalha em candidatos discover
// Complementa o enrich de /items quando o catálogo não traz seller.
// ============================================================

import { fetchMercadoLivreSellerPublicProfile } from "./competitionListingEnricher.js";
import { fetchMercadoLivreCategoryPath } from "../../handlers/ml/_helpers/mercadoLibreItemsApi.js";

function temMedalha(reputation) {
  const s = reputation?.power_seller_status;
  return s != null && String(s).trim() !== "";
}

function precisaSellerMeta(cand) {
  if (!cand || typeof cand !== "object") return false;
  const sellerId = cand.competitor_seller_id != null ? String(cand.competitor_seller_id).trim() : "";
  if (!sellerId) return false;
  const loja = cand.competitor_store_name != null ? String(cand.competitor_store_name).trim() : "";
  return !loja || !temMedalha(cand.reputation);
}

/**
 * Preenche competitor_store_name e reputation via GET /users/{seller_id}.
 * @param {string | null | undefined} accessToken
 * @param {object[]} candidates
 * @param {{ concurrency?: number; max?: number }} [opts]
 */
export async function resolveSellerMetaForDiscoverCandidates(accessToken, candidates, opts = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!accessToken || !list.length) return list;

  const concurrency = Number.isFinite(Number(opts.concurrency)) ? Math.min(Number(opts.concurrency), 5) : 3;
  const max = Number.isFinite(Number(opts.max)) ? Math.min(Number(opts.max), 50) : list.length;
  const targets = list.filter(precisaSellerMeta).slice(0, max);

  for (let i = 0; i < targets.length; i += concurrency) {
    const chunk = targets.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (cand) => {
        const sellerId = String(cand.competitor_seller_id || "").trim();
        if (!sellerId) return;
        const profile = await fetchMercadoLivreSellerPublicProfile(accessToken, sellerId);
        if (!profile) return;
        const lojaAtual = cand.competitor_store_name != null ? String(cand.competitor_store_name).trim() : "";
        if (!lojaAtual && profile.nickname) {
          cand.competitor_store_name = profile.nickname;
        }
        if (!temMedalha(cand.reputation) && profile.reputation) {
          cand.reputation = {
            level_id: profile.reputation.level_id ?? cand.reputation?.level_id ?? null,
            power_seller_status:
              profile.reputation.power_seller_status ?? cand.reputation?.power_seller_status ?? null,
            transactions_completed:
              profile.reputation.transactions_completed ??
              cand.reputation?.transactions_completed ??
              null,
          };
        } else if (profile.reputation?.transactions_completed != null && cand.reputation) {
          cand.reputation = {
            ...cand.reputation,
            transactions_completed: profile.reputation.transactions_completed,
          };
        } else if (profile.reputation?.transactions_completed != null) {
          cand.reputation = {
            level_id: cand.reputation?.level_id ?? null,
            power_seller_status: cand.reputation?.power_seller_status ?? null,
            transactions_completed: profile.reputation.transactions_completed,
          };
        }
      })
    );
  }

  return list;
}

function precisaCategoria(cand) {
  if (!cand || typeof cand !== "object") return false;
  const path = cand.category_path != null ? String(cand.category_path).trim() : "";
  if (path) return false;
  const categoryId = cand.category_id != null ? String(cand.category_id).trim() : "";
  return Boolean(categoryId);
}

/**
 * Preenche category_path via GET /categories/{id} (API oficial ML).
 * @param {string | null | undefined} accessToken
 * @param {object[]} candidates
 * @param {{ concurrency?: number; max?: number }} [opts]
 */
export async function resolveCategoryPathForDiscoverCandidates(accessToken, candidates, opts = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!accessToken || !list.length) return list;

  const concurrency = Number.isFinite(Number(opts.concurrency)) ? Math.min(Number(opts.concurrency), 5) : 3;
  const max = Number.isFinite(Number(opts.max)) ? Math.min(Number(opts.max), 50) : list.length;
  const targets = list.filter(precisaCategoria).slice(0, max);

  for (let i = 0; i < targets.length; i += concurrency) {
    const chunk = targets.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (cand) => {
        const categoryId = String(cand.category_id || "").trim();
        if (!categoryId) return;
        const path = await fetchMercadoLivreCategoryPath(accessToken, categoryId);
        if (path) cand.category_path = path;
      })
    );
  }

  return list;
}
