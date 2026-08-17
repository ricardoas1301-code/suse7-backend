// ======================================================================
// Contagem canônica — produtos com custos obrigatórios pendentes
// SSOT alinhado a GET /api/products/costs/pending (total)
// ======================================================================

import { buildMissingRequiredProductCostsPostgrestOrFilter } from "../productCatalogCompleteness.js";
import { countSkuDependencyPendingForUser } from "../listings/skuDependencyPending.js";
import {
  avatarLojaPresente,
  enderecoEmpresaMinimoCompleto,
} from "../seller/enderecoEmpresaCompleto.js";

export { countSkuDependencyPendingForUser };

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<number>}
 */
export async function countMissingProductCostsForUser(supabase, userId) {
  const uid = String(userId || "").trim();
  if (!uid) return 0;

  const { count, error } = await supabase
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("user_id", uid)
    .or(buildMissingRequiredProductCostsPostgrestOrFilter());

  if (error) throw error;
  return Math.max(0, Number(count) || 0);
}

/**
 * @param {number} count
 */
export function buildMissingProductCostsDescription(count) {
  const n = Math.max(0, Number(count) || 0);
  if (n === 1) return "1 produto aguarda cadastro de custos";
  return `${n.toLocaleString("pt-BR")} produtos aguardam cadastro de custos`;
}

/**
 * @param {number} count
 * @returns {{ tasks: Record<string, unknown>[]; total_tasks: number }}
 */
export function buildOperationalTasksPayloadFromMissingCostsCount(count) {
  return buildOperationalTasksPayload({ missingProductCostsCount: count });
}

/** @param {number} count */
export function buildSkuDependencyPendingDescription(count) {
  const n = Math.max(0, Number(count) || 0);
  return `${n.toLocaleString("pt-BR")} anúncios aguardam cadastro ou vínculo de SKU`;
}

/**
 * @param {{
 *   skuDependencyPendingCount?: number;
 *   missingProductCostsCount?: number;
 *   universeStable?: boolean;
 *   mlInitialSyncPhase?: "none" | "awaiting_start" | "in_progress";
 *   mlMarketplaceAccountId?: string | null;
 *   profilePhotoUrl?: string | null;
 *   companyLogoUrl?: string | null;
 *   primaryCompany?: Record<string, unknown> | null;
 * }} counts
 * @returns {{ tasks: Record<string, unknown>[]; total_tasks: number; initial_sync_universe_stable?: boolean }}
 */
export function buildOperationalTasksPayload(counts = {}) {
  const universeStable = counts.universeStable !== false;
  /** @type {Record<string, unknown>[]} */
  const tasks = [];

  const mlPhase = counts.mlInitialSyncPhase ?? "none";
  const mlAccountId =
    counts.mlMarketplaceAccountId != null && String(counts.mlMarketplaceAccountId).trim() !== ""
      ? String(counts.mlMarketplaceAccountId).trim()
      : null;

  if (mlPhase === "awaiting_start" && mlAccountId) {
    tasks.push({
      id: "ml_initial_sync_pending",
      type: "ml_initial_sync_pending",
      title: "Sincronizar Mercado Livre",
      description:
        "Importe seus dados do Mercado Livre para começar a trabalhar com suas vendas, anúncios e produtos no SUSE7.",
      status: "requires_action",
      priority: "critical",
      icon: "marketplace_sync",
      marketplace: "mercado_livre",
      marketplace_account_id: mlAccountId,
      action: {
        type: "open_ml_initial_sync_modal",
        label: "Iniciar sincronização",
      },
      scope: "marketplace",
      dedupe_key: "ml_initial_sync_pending",
      sort_order: 1,
    });
  } else if (mlPhase === "in_progress" && mlAccountId) {
    tasks.push({
      id: "ml_initial_sync_in_progress",
      type: "ml_initial_sync_in_progress",
      title: "Sincronizando Mercado Livre",
      description: "Estamos importando seus dados. Você pode continuar usando o SUSE7 enquanto isso.",
      status: "processing",
      priority: "high",
      icon: "marketplace_sync",
      marketplace: "mercado_livre",
      marketplace_account_id: mlAccountId,
      action: {
        type: "open_ml_sync_modal",
        label: "Ver sincronização",
      },
      scope: "marketplace",
      dedupe_key: "ml_initial_sync_in_progress",
      sort_order: 1,
    });
  } else if (!universeStable) {
    tasks.push({
      id: "initial_sync_in_progress",
      type: "initial_sync_in_progress",
      title: "Importando dados do Mercado Livre",
      description:
        "Estamos preparando anúncios e produtos. As pendências de SKU e custos aparecerão quando a base estiver estável.",
      status: "processing",
      priority: "medium",
      icon: "marketplace_sync",
      action: mlAccountId
        ? { type: "open_ml_sync_modal", label: "Ver sincronização" }
        : null,
      scope: "marketplace",
      dedupe_key: "initial_sync_in_progress",
      sort_order: 1,
    });
  }

  const photoUrl = counts.profilePhotoUrl != null ? String(counts.profilePhotoUrl).trim() : "";
  const logoUrl = counts.companyLogoUrl != null ? String(counts.companyLogoUrl).trim() : "";
  if (!avatarLojaPresente({ companyLogoUrl: logoUrl, profilePhotoUrl: photoUrl })) {
    tasks.push({
      id: "store_avatar_pending",
      type: "store_avatar_pending",
      title: "Cadastrar avatar da loja",
      description:
        "Adicione o avatar da sua loja para identificar suas vendas com mais facilidade nas listas do SUSE7.",
      status: "requires_action",
      priority: "medium",
      icon: "store_avatar",
      action: {
        type: "open_company_edit",
        label: "Cadastrar avatar",
      },
      scope: "profile",
      dedupe_key: "store_avatar_pending",
      sort_order: 2,
    });
  }

  const primaryCompany =
    counts.primaryCompany != null && typeof counts.primaryCompany === "object"
      ? counts.primaryCompany
      : null;
  if (!enderecoEmpresaMinimoCompleto(primaryCompany)) {
    tasks.push({
      id: "store_address_pending",
      type: "store_address_pending",
      title: "Cadastrar endereço da loja",
      description:
        "Complete o endereço da sua loja para manter seus dados comerciais e operacionais atualizados no SUSE7.",
      status: "requires_action",
      priority: "medium",
      icon: "store_address",
      action: {
        type: "open_company_edit",
        label: "Cadastrar endereço",
      },
      scope: "profile",
      dedupe_key: "store_address_pending",
      sort_order: 3,
    });
  }

  if (universeStable) {
    const skuCount = Math.max(0, Number(counts.skuDependencyPendingCount) || 0);
    const costsCount = Math.max(0, Number(counts.missingProductCostsCount) || 0);

    if (skuCount > 0) {
      tasks.push({
        id: "sku_dependency_pending",
        type: "sku_dependency_pending",
        title: "Cadastrar SKUs em lote",
        description: buildSkuDependencyPendingDescription(skuCount),
        status: "requires_action",
        priority: "high",
        count: skuCount,
        icon: "listing_sku",
        action: {
          type: "open_bulk_listing_skus",
          label: "Cadastrar SKUs",
        },
        scope: "listings",
        dedupe_key: "sku_dependency_pending",
        sort_order: 5,
      });
    }

    if (costsCount > 0) {
      tasks.push({
        id: "missing_product_costs",
        type: "missing_product_costs",
        title: "Cadastrar custos em lote",
        description: buildMissingProductCostsDescription(costsCount),
        status: "requires_action",
        priority: "high",
        count: costsCount,
        icon: "product_costs",
        action: {
          type: "open_bulk_product_costs",
          label: "Cadastrar custos",
        },
        scope: "products",
        dedupe_key: "missing_product_costs",
        sort_order: 10,
      });
    }
  }

  return {
    tasks: tasks.sort((a, b) => Number(a.sort_order) - Number(b.sort_order)),
    total_tasks: tasks.length,
    initial_sync_universe_stable: universeStable,
  };
}
