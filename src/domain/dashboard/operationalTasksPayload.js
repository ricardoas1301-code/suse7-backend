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
 *   mlAccountSyncStates?: Array<{
 *     marketplace_account_id: string;
 *     phase: "none" | "awaiting_start" | "in_progress";
 *     seller_company_id?: string | null;
 *     account_label?: string | null;
 *     account_avatar_url?: string | null;
 *     store_name?: string | null;
 *     store_document_cnpj?: string | null;
 *     store_logo_url?: string | null;
 *     ml_nickname?: string | null;
 *     status?: string | null;
 *   }>;
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

  const accountStates = Array.isArray(counts.mlAccountSyncStates)
    ? counts.mlAccountSyncStates.filter(
        (s) => s?.marketplace_account_id && String(s.marketplace_account_id).trim() !== "",
      )
    : [];

  // S1.09 — sem conta ML: pendência flutuante "Conectar marketplace" (fora do modal M1–M5).
  if (accountStates.length === 0 && mlPhase === "none" && !mlAccountId) {
    tasks.push({
      id: "marketplace_connect_pending",
      type: "marketplace_connect_pending",
      title: "Conectar Mercado Livre",
      description:
        "Conecte sua conta do Mercado Livre para importar anúncios, produtos e vendas no SUSE7.",
      status: "requires_action",
      priority: "critical",
      icon: "marketplace_connect",
      marketplace: "mercado_livre",
      action: {
        type: "open_marketplace_connect",
        label: "Conectar",
      },
      scope: "marketplace",
      dedupe_key: "marketplace_connect_pending",
      sort_order: 0,
    });
  }

  // CPJ-2 T1 — uma pendência por connection/account (não singleton).
  if (accountStates.length > 0) {
    let sortBase = 1;
    for (const st of accountStates) {
      const accountId = String(st.marketplace_account_id).trim();
      const phase = String(st.phase ?? "none").trim();
      if (phase !== "awaiting_start" && phase !== "in_progress") continue;

      const storeName =
        (st.store_name != null && String(st.store_name).trim()) ||
        (st.account_label != null && String(st.account_label).trim()) ||
        null;
      const storeLogo =
        (st.store_logo_url != null && String(st.store_logo_url).trim()) ||
        (st.account_avatar_url != null && String(st.account_avatar_url).trim()) ||
        null;
      const storeDoc =
        st.store_document_cnpj != null && String(st.store_document_cnpj).trim() !== ""
          ? String(st.store_document_cnpj).replace(/\D/g, "")
          : null;

      const sellerCompanyId =
        st.seller_company_id != null && String(st.seller_company_id).trim() !== ""
          ? String(st.seller_company_id).trim()
          : null;

      if (phase === "awaiting_start") {
        const needsReauth = ["invalid", "expired", "error"].includes(
          String(st.status ?? "").trim().toLowerCase(),
        );
        tasks.push({
          id: `ml_initial_sync_pending:${accountId}`,
          type: "ml_initial_sync_pending",
          // Título = AÇÃO + MARKETPLACE (identidade da loja fica no bloco separado).
          title: needsReauth ? "Reconectar Mercado Livre" : "Sincronizar Mercado Livre",
          description: needsReauth
            ? "A conta precisa ser reautenticada antes de iniciar a sincronização inicial."
            : "Importe seus dados do Mercado Livre para começar a trabalhar com suas vendas, anúncios e produtos no SUSE7.",
          status: "requires_action",
          priority: "critical",
          icon: "marketplace_sync",
          marketplace: "mercado_livre",
          marketplace_account_id: accountId,
          seller_company_id: sellerCompanyId,
          account_label: storeName,
          account_avatar_url: storeLogo,
          store_name: storeName,
          store_document_cnpj: storeDoc,
          store_logo_url: storeLogo,
          action: {
            type: needsReauth ? "open_marketplace_connect" : "open_ml_initial_sync_modal",
            label: needsReauth ? "Reconectar" : "Sincronizar",
          },
          scope: "marketplace",
          dedupe_key: `ml_initial_sync_pending:${accountId}`,
          sort_order: sortBase++,
        });
      } else {
        tasks.push({
          id: `ml_initial_sync_in_progress:${accountId}`,
          type: "ml_initial_sync_in_progress",
          title: "Sincronizando Mercado Livre",
          description: "Estamos importando seus dados. Você pode continuar usando o SUSE7 enquanto isso.",
          status: "processing",
          priority: "high",
          icon: "marketplace_sync",
          marketplace: "mercado_livre",
          marketplace_account_id: accountId,
          seller_company_id: sellerCompanyId,
          account_label: storeName,
          account_avatar_url: storeLogo,
          store_name: storeName,
          store_document_cnpj: storeDoc,
          store_logo_url: storeLogo,
          action: {
            type: "open_ml_sync_modal",
            label: "Ver sincronização",
          },
          scope: "marketplace",
          dedupe_key: `ml_initial_sync_in_progress:${accountId}`,
          sort_order: sortBase++,
        });
      }
    }
  } else if (mlPhase === "awaiting_start" && mlAccountId) {
    // Compat single-account legado (sem array de estados).
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
