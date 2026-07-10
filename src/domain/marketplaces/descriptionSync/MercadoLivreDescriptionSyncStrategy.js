// ======================================================================
// Mercado Livre — Strategy de sincronização de descrição produto → anúncio
// Envio como plain_text; preserva quebras de linha; sem HTML rico.
// ======================================================================

import { ML_MARKETPLACE_SLUG } from "../../../handlers/ml/_helpers/mlMarketplace.js";
import {
  postMercadoLibreItemDescription,
  putMercadoLibreItemDescription,
} from "../../../handlers/ml/_helpers/mercadoLibreItemsApi.js";
import { MLB_DESCRIPTION_MAX_LENGTH } from "./MarketplaceDescriptionSyncStrategy.js";

/**
 * @param {unknown} error
 */
function mensagemErroMercadoLivre(error) {
  if (!error || typeof error !== "object") {
    return error instanceof Error ? error.message : String(error);
  }
  const body = /** @type {{ message?: unknown; cause?: unknown[] }} */ (error).body;
  if (body && typeof body === "object") {
    if (body.message != null && String(body.message).trim() !== "") {
      return String(body.message);
    }
    if (Array.isArray(body.cause) && body.cause.length > 0) {
      const first = body.cause[0];
      if (first && typeof first === "object" && first.message != null) {
        return String(first.message);
      }
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/** @type {import("./MarketplaceDescriptionSyncStrategy.js").MarketplaceDescriptionSyncStrategy} */
export const MercadoLivreDescriptionSyncStrategy = {
  marketplaceSlug: ML_MARKETPLACE_SLUG,
  descriptionMaxLength: MLB_DESCRIPTION_MAX_LENGTH,

  canUpdateDescription(context) {
    const itemId = String(context.externalListingId ?? "").trim();
    if (!itemId) {
      return {
        canUpdateDescription: false,
        reason: "Anúncio sem identificador externo no marketplace.",
      };
    }
    return { canUpdateDescription: true };
  },

  validateDescription(description) {
    const value = String(description ?? "");
    if (!value.trim()) {
      return { valid: false, reason: "Descrição não pode ser vazia." };
    }
    if (value.length > MLB_DESCRIPTION_MAX_LENGTH) {
      return {
        valid: false,
        reason: `Descrição excede o limite de ${MLB_DESCRIPTION_MAX_LENGTH} caracteres do Mercado Livre.`,
      };
    }
    return { valid: true };
  },

  async updateListingDescription(accessToken, context, description) {
    const itemId = String(context.externalListingId ?? "").trim();
    if (!itemId) {
      return { ok: false, status: "failed", errorMessage: "external_listing_id inválido." };
    }

    const plainText = String(description ?? "");
    try {
      const rawDescription = await putMercadoLibreItemDescription(accessToken, itemId, plainText);
      return { ok: true, status: "synced", rawDescription };
    } catch (putError) {
      const status =
        putError && typeof putError === "object" && "status" in putError
          ? Number(/** @type {{ status?: number }} */ (putError).status)
          : null;
      if (status === 404) {
        try {
          const rawDescription = await postMercadoLibreItemDescription(accessToken, itemId, plainText);
          return { ok: true, status: "synced", rawDescription };
        } catch (postError) {
          return {
            ok: false,
            status: "failed",
            errorMessage: mensagemErroMercadoLivre(postError),
          };
        }
      }
      return {
        ok: false,
        status: "failed",
        errorMessage: mensagemErroMercadoLivre(putError),
      };
    }
  },
};
