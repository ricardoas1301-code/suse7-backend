import { requireAuthUser } from "./_helpers/requireAuthUser.js";
import { getValidMLToken } from "./_helpers/mlToken.js";
import {
  putMercadoLibreItemDescription,
  putMercadoLibreItemTitle,
} from "./_helpers/mercadoLibreItemsApi.js";
import { resolveListingEditorAdapter } from "./_helpers/listingEditor/listingEditorAdapters.js";

/**
 * @param {unknown} value
 */
function textoOuVazio(value) {
  return value != null ? String(value).trim() : "";
}

/**
 * @param {unknown} value
 * @param {number} max
 */
function resumirValorAuditoria(value, max = 140) {
  const text = textoOuVazio(value);
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export default async function handleListingEditorContentUpdate(req, res) {
  if (req.method !== "PUT" && req.method !== "PATCH" && req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    return res.status(400).json({ ok: false, error: "JSON inválido" });
  }

  const listingId = textoOuVazio(body.listing_id ?? body.listingId);
  const titleNext = textoOuVazio(body.title);
  const descriptionNext = textoOuVazio(body.description);

  if (!listingId) {
    return res.status(400).json({ ok: false, error: "Informe listing_id." });
  }
  if (!titleNext && !descriptionNext) {
    return res.status(400).json({ ok: false, error: "Informe ao menos título ou descrição." });
  }

  const { user, supabase } = auth;
  const { data: listingRow, error: listingErr } = await supabase
    .from("marketplace_listings")
    .select("id, user_id, marketplace, marketplace_account_id, external_listing_id, title, raw_json")
    .eq("id", listingId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (listingErr || !listingRow) {
    return res.status(404).json({ ok: false, error: "Anúncio não encontrado." });
  }

  const adapter = resolveListingEditorAdapter(listingRow.marketplace);
  if (!adapter) {
    return res.status(422).json({
      ok: false,
      error: "Marketplace ainda não suportado para edição básica neste MVP.",
    });
  }

  const externalItemId = textoOuVazio(listingRow.external_listing_id);
  if (!externalItemId) {
    return res.status(422).json({
      ok: false,
      error: "Anúncio sem external_listing_id. Sincronize e tente novamente.",
    });
  }

  const { data: descCurrentRow } = await supabase
    .from("marketplace_listing_descriptions")
    .select("id, plain_text, html_text")
    .eq("listing_id", listingId)
    .maybeSingle();

  const rawCurrent =
    listingRow.raw_json && typeof listingRow.raw_json === "object" && !Array.isArray(listingRow.raw_json)
      ? /** @type {Record<string, unknown>} */ (listingRow.raw_json)
      : {};
  const titleCurrent = textoOuVazio(rawCurrent.title) || textoOuVazio(listingRow.title);
  const descriptionCurrent =
    textoOuVazio(descCurrentRow?.plain_text) ||
    textoOuVazio(descCurrentRow?.html_text) ||
    textoOuVazio(rawCurrent.description);

  const token = await getValidMLToken(user.id, {
    marketplaceAccountId: textoOuVazio(listingRow.marketplace_account_id) || null,
  });

  const changedFields = [];
  if (titleNext && titleNext !== titleCurrent) {
    await putMercadoLibreItemTitle(token, externalItemId, titleNext);
    changedFields.push("title");
  }
  if (descriptionNext && descriptionNext !== descriptionCurrent) {
    await putMercadoLibreItemDescription(token, externalItemId, descriptionNext);
    changedFields.push("description");
  }

  if (changedFields.length === 0) {
    return res.status(200).json({
      ok: true,
      updated: false,
      message: "Nenhuma alteração detectada para salvar.",
      fields: [],
    });
  }

  const nowIso = new Date().toISOString();
  const rawNext = { ...rawCurrent };
  if (changedFields.includes("title")) rawNext.title = titleNext;
  if (changedFields.includes("description")) rawNext.description = descriptionNext;

  const { error: listingUpdErr } = await supabase
    .from("marketplace_listings")
    .update({
      title: changedFields.includes("title") ? titleNext : listingRow.title,
      raw_json: rawNext,
      updated_at: nowIso,
    })
    .eq("id", listingId)
    .eq("user_id", user.id);
  if (listingUpdErr) {
    return res.status(500).json({ ok: false, error: "Falha ao atualizar dados locais do anúncio." });
  }

  if (changedFields.includes("description")) {
    if (descCurrentRow?.id) {
      await supabase
        .from("marketplace_listing_descriptions")
        .update({
          plain_text: descriptionNext,
          html_text: descriptionNext,
          raw_json: { plain_text: descriptionNext },
          updated_at: nowIso,
        })
        .eq("id", descCurrentRow.id);
    } else {
      await supabase.from("marketplace_listing_descriptions").insert({
        listing_id: listingId,
        user_id: user.id,
        plain_text: descriptionNext,
        html_text: descriptionNext,
        raw_json: { plain_text: descriptionNext },
        updated_at: nowIso,
      });
    }
  }

  console.info("[LISTING_CONTENT_EDIT_AUDIT]", {
    user_id: user.id,
    marketplace_account_id: listingRow.marketplace_account_id ?? null,
    item_id: externalItemId,
    campo_alterado: changedFields,
    valor_anterior_resumido: {
      title: changedFields.includes("title") ? resumirValorAuditoria(titleCurrent) : null,
      description: changedFields.includes("description") ? resumirValorAuditoria(descriptionCurrent) : null,
    },
    valor_novo_resumido: {
      title: changedFields.includes("title") ? resumirValorAuditoria(titleNext) : null,
      description: changedFields.includes("description") ? resumirValorAuditoria(descriptionNext) : null,
    },
    data_hora: nowIso,
    status_operacao: "success",
  });

  return res.status(200).json({
    ok: true,
    updated: true,
    fields: changedFields,
    listing_id: listingId,
    listing_external_id: externalItemId,
    content: {
      title: changedFields.includes("title") ? titleNext : titleCurrent,
      description: changedFields.includes("description") ? descriptionNext : descriptionCurrent,
    },
  });
}

