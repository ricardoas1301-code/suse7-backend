// ======================================================================
// Sincroniza product_variants após UPDATE do produto pai (upsert modo edit).
// Antes: o upsert só gravava public.products; linhas de variação nunca atualizavam.
// ======================================================================

function toNum(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim().replace(",", ".");
  if (s === "") return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function toInt(v) {
  if (v == null || v === "") return null;
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {{ supabase: import("@supabase/supabase-js").SupabaseClient; userId: string; productId: string; variants: object[] }} ctx
 * @returns {Promise<{ ok: boolean; message?: string }>}
 */
export async function syncProductVariantsAfterParentUpdate({ supabase, userId, productId, variants }) {
  if (!productId || !Array.isArray(variants) || variants.length === 0) {
    return { ok: true };
  }

  const { data: existingRows, error: listErr } = await supabase
    .from("product_variants")
    .select("id")
    .eq("product_id", productId);

  if (listErr) {
    return { ok: false, message: listErr.message || "Falha ao listar variações" };
  }

  const existingIds = new Set((existingRows || []).map((r) => r.id).filter(Boolean));

  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    const sku = String(v?.sku ?? "").trim();
    if (!sku) {
      return { ok: false, message: "Cada variação precisa de SKU." };
    }

    const row = {
      sku,
      gtin: v.gtin == null || v.gtin === "" ? null : String(v.gtin),
      cost_price: toNum(v.cost_price),
      stock_quantity: toInt(v.stock_quantity) ?? 0,
      stock_minimum: toInt(v.stock_minimum) ?? 0,
      use_virtual_stock: Boolean(v.use_virtual_stock),
      virtual_stock_quantity: toInt(v.virtual_stock_quantity) ?? 0,
      active: v.active !== false,
      attributes: v.attributes && typeof v.attributes === "object" ? v.attributes : {},
      sort_order: i,
    };

    const rawId = v.id != null ? String(v.id).trim() : "";
    const isExisting = rawId && existingIds.has(rawId);

    if (isExisting) {
      const { error } = await supabase
        .from("product_variants")
        .update(row)
        .eq("id", rawId)
        .eq("product_id", productId);
      if (error) {
        return { ok: false, message: error.message || "Falha ao atualizar variação" };
      }
    } else {
      const insertRow = {
        ...row,
        product_id: productId,
        user_id: userId,
      };
      const { error } = await supabase.from("product_variants").insert(insertRow);
      if (error) {
        return { ok: false, message: error.message || "Falha ao inserir variação" };
      }
    }
  }

  return { ok: true };
}
