import Decimal from "decimal.js";
import { fetchItemSalePrice } from "../../handlers/ml/_helpers/mercadoLibreItemsApi.js";

function normalizeMoney(value) {
  if (value == null) return null;
  try {
    const d = new Decimal(String(value));
    if (!d.isFinite() || d.lte(0)) return null;
    return d.toFixed(2);
  } catch {
    return null;
  }
}

function pickFallbackPrice(itemBody, fallbackPrice) {
  const fromItem =
    normalizeMoney(itemBody?.price) ??
    normalizeMoney(itemBody?.base_price) ??
    normalizeMoney(itemBody?.original_price);
  return fromItem ?? normalizeMoney(fallbackPrice);
}

/**
 * Fonte oficial de preço do concorrente ML:
 * 1) /items/{id}/sale_price?context=channel_marketplace
 * 2) fallback técnico de /items (price/base_price/original_price) ou discovery.
 */
export async function resolveMlCompetitorEffectivePrice({
  itemId,
  accessToken,
  itemBody = null,
  fallbackPrice = null,
  fallbackCurrency = null,
  fallbackSource = "items_fallback",
}) {
  const listingId = itemId != null ? String(itemId).trim() : "";
  const currencyFromItem =
    itemBody?.currency_id != null ? String(itemBody.currency_id).trim() : null;
  const currency = currencyFromItem || (fallbackCurrency != null ? String(fallbackCurrency).trim() : "") || "BRL";

  if (listingId && accessToken) {
    const salePayload = await fetchItemSalePrice(accessToken, listingId, {
      context: "channel_marketplace",
    });
    const amount = normalizeMoney(salePayload?.amount);
    const regularAmount = normalizeMoney(salePayload?.regular_amount);
    if (amount) {
      return {
        effective_price: amount,
        regular_price: regularAmount,
        currency_id:
          salePayload?.currency_id != null && String(salePayload.currency_id).trim() !== ""
            ? String(salePayload.currency_id).trim()
            : currency,
        price_source: "sale_price",
        has_promotion: Boolean(regularAmount && regularAmount !== amount),
        sale_price_checked: true,
      };
    }
  }

  const fallback = pickFallbackPrice(itemBody, fallbackPrice);
  return {
    effective_price: fallback,
    regular_price: null,
    currency_id: currency,
    price_source: fallback ? fallbackSource : "none",
    has_promotion: false,
    sale_price_checked: Boolean(listingId && accessToken),
  };
}

