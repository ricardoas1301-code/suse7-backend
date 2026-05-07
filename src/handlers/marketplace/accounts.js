import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function pickSafeAccount(row) {
  const nickname =
    row?.ml_nickname != null && String(row.ml_nickname).trim() !== ""
      ? String(row.ml_nickname).trim()
      : row?.account_alias != null && String(row.account_alias).trim() !== ""
        ? String(row.account_alias).trim()
        : row?.external_seller_id != null
          ? String(row.external_seller_id)
          : null;

  return {
    marketplace_account_id: row?.id ?? null,
    id: row?.id ?? null,
    marketplace: row?.marketplace ?? "mercado_livre",
    nickname,
    ml_nickname: row?.ml_nickname ?? null,
    account_alias: row?.account_alias ?? null,
    seller_company_id: row?.seller_company_id ?? null,
    external_seller_id: row?.external_seller_id ?? null,
    status: row?.status ?? "unknown",
    token_expires_at: row?.token_expires_at ?? null,
    ml_sales_last_sync_at: row?.ml_sales_last_sync_at ?? null,
  };
}

async function loadAccounts(supabase, userId, marketplace) {
  const selectVariants = [
    "id, marketplace, seller_company_id, external_seller_id, status, ml_nickname, account_alias, token_expires_at, ml_sales_last_sync_at",
    "id, marketplace, seller_company_id, external_seller_id, status, ml_nickname, account_alias",
    "id, marketplace, seller_company_id, external_seller_id, status",
    "id, seller_company_id, external_seller_id, status",
  ];

  for (const selectExpr of selectVariants) {
    let q = supabase.from("marketplace_accounts").select(selectExpr).eq("user_id", userId);
    if (marketplace) q = q.eq("marketplace", marketplace);
    const { data, error } = await q.order("created_at", { ascending: false });
    if (!error) return { data: toArray(data), error: null };
    const nonShapeError =
      String(error?.code ?? "") !== "42703" &&
      !String(error?.message ?? "").toLowerCase().includes("column");
    if (nonShapeError) return { data: [], error };
  }
  return { data: [], error: null };
}

export default async function handleMarketplaceAccounts(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    if (auth.error.code === "CONFIG_ERROR") {
      return res.status(200).json({ ok: true, accounts: [] });
    }
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  const marketplace = req.query?.marketplace != null ? String(req.query.marketplace).trim() : "";
  const filterMarketplace = marketplace || null;

  try {
    const { data, error } = await loadAccounts(supabase, user.id, filterMarketplace);
    if (error) {
      console.error("[Suse7][API][marketplace-accounts] failed", {
        user_id: user.id,
        marketplace_filter: filterMarketplace,
        table: "marketplace_accounts",
        message: error?.message,
        code: error?.code,
        details: error?.details,
      });
      return res.status(200).json({ ok: true, accounts: [] });
    }

    const rows = data.map(pickSafeAccount);

    let mlTokensCount = null;
    let mlTokenUserId = null;
    try {
      const { data: tok, error: tokErr } = await supabase
        .from("ml_tokens")
        .select("id, ml_user_id")
        .eq("user_id", user.id)
        .eq("marketplace", "mercado_livre")
        .order("updated_at", { ascending: false })
        .limit(5);
      if (!tokErr && Array.isArray(tok)) {
        mlTokensCount = tok.length;
        mlTokenUserId = tok[0]?.ml_user_id != null ? String(tok[0].ml_user_id) : null;
      }
    } catch {
      // diagnóstico best-effort
    }

    console.info("[Suse7][API][marketplace-accounts] query_ok", {
      user_id: user.id,
      table: "marketplace_accounts",
      marketplace_filter: filterMarketplace,
      accounts_found: rows.length,
      accounts_with_seller_company_id: rows.filter((r) => r?.seller_company_id).length,
      first_account_id: rows[0]?.id ?? null,
      first_external_seller_id: rows[0]?.external_seller_id ?? null,
      ml_tokens_found_same_user: mlTokensCount,
      ml_tokens_top_ml_user_id: mlTokenUserId,
    });

    if (rows.length === 0 && mlTokensCount && mlTokensCount > 0) {
      console.warn("[Suse7][API][marketplace-accounts] divergence_ml_tokens_without_marketplace_accounts", {
        user_id: user.id,
        marketplace_filter: filterMarketplace,
        ml_tokens_found_same_user: mlTokensCount,
        ml_tokens_top_ml_user_id: mlTokenUserId,
      });
    }

    return res.status(200).json({
      ok: true,
      accounts: rows,
    });
  } catch (error) {
    console.error("[Suse7][API][marketplace-accounts] failed", {
      user_id: user.id,
      marketplace_filter: filterMarketplace,
      table: "marketplace_accounts",
      message: error?.message,
      code: error?.code,
      details: error?.details,
    });
    return res.status(200).json({ ok: true, accounts: [] });
  }
}
