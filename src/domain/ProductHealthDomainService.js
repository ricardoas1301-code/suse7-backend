// ======================================================================
// SUSE7 — Product Health Domain Service
// Avaliação de saúde/qualidade do cadastro do produto
// ======================================================================

const TITLE_MAX_CHARS = 60;
const DESCRIPTION_MIN_CHARS = 50;

// ----------------------------------------------------------------------
// Avaliação
// ----------------------------------------------------------------------

/**
 * Avalia saúde do produto e retorna blocking, warnings e readyToPublish.
 *
 * @param {object} product - produto (product_name, sku, format, status, etc.)
 * @param {object[]} [variants] - variações (quando format=variants)
 * @param {object[]} [adTitles] - títulos alternativos (product_ad_titles)
 * @param {object[]} [imagesLinks] - links de imagens (product_image_links)
 * @returns {{
 *   readyToPublish: boolean;
 *   blocking: Array<{ code: string; message: string; field: string }>;
 *   warnings: Array<{ code: string; message: string; field: string }>;
 *   meta: { format: string; hasVariations: boolean; titlesCount: number; imagesCount: number };
 * }}
 */
export function evaluateProductHealth(product, variants = [], adTitles = [], imagesLinks = []) {
  const blocking = [];
  const warnings = [];
  const format = (product?.format || "simple").toLowerCase();
  const status = (product?.status || "draft").toLowerCase();
  const variantsArr = Array.isArray(variants) ? variants : [];
  const titlesArr = Array.isArray(adTitles) ? adTitles : [];
  const imagesArr = Array.isArray(imagesLinks) ? imagesLinks : [];

  const hasVariations = format === "variants" && variantsArr.length > 0;

  // ------------------------------------------------------------------
  // BLOCKING
  // ------------------------------------------------------------------

  const name = product?.product_name ?? product?.name ?? "";
  if (!name || String(name).trim() === "") {
    blocking.push({
      code: "NAME_REQUIRED",
      message: "Nome do produto é obrigatório.",
      field: "product_name",
    });
  }

  if (format === "simple") {
    const sku = product?.sku ?? "";
    if (!sku || String(sku).trim() === "") {
      blocking.push({
        code: "SKU_REQUIRED",
        message: "SKU é obrigatório no formato simples.",
        field: "sku",
      });
    }
  } else if (format === "variants") {
    if (variantsArr.length === 0) {
      blocking.push({
        code: "VARIATIONS_REQUIRED",
        message: "Cadastre pelo menos uma variação.",
        field: "variants",
      });
    } else {
      const withoutSku = variantsArr.filter((v) => !v?.sku || String(v.sku).trim() === "");
      if (withoutSku.length > 0) {
        blocking.push({
          code: "VARIANT_SKU_REQUIRED",
          message: "Todas as variações precisam de SKU.",
          field: "variants",
        });
      }
    }
  }

  if (!["draft", "ready", "published", "blocked"].includes(status)) {
    blocking.push({
      code: "STATUS_INVALID",
      message: "Status do produto inválido.",
      field: "status",
    });
  }

  if (imagesArr.length === 0) {
    blocking.push({
      code: "IMAGES_REQUIRED",
      message: "Adicione pelo menos uma imagem para publicar.",
      field: "images",
    });
  }

  // ------------------------------------------------------------------
  // WARNINGS
  // ------------------------------------------------------------------

  const mainTitle = name;
  if (mainTitle && mainTitle.length > TITLE_MAX_CHARS) {
    warnings.push({
      code: "TITLE_TOO_LONG",
      message: `Título principal com mais de ${TITLE_MAX_CHARS} caracteres (${mainTitle.length}).`,
      field: "product_name",
    });
  }

  for (let i = 0; i < titlesArr.length; i++) {
    const t = titlesArr[i]?.title ?? "";
    if (t && t.length > TITLE_MAX_CHARS) {
      warnings.push({
        code: "AD_TITLE_TOO_LONG",
        message: `Título alternativo #${i + 1} com mais de ${TITLE_MAX_CHARS} caracteres.`,
        field: "ad_titles",
      });
    }
  }

  const desc = product?.description ?? "";
  if (desc && desc.length > 0 && desc.length < DESCRIPTION_MIN_CHARS) {
    warnings.push({
      code: "DESCRIPTION_SHORT",
      message: `Descrição muito curta (${desc.length} caracteres). Recomendado: ${DESCRIPTION_MIN_CHARS}+.`,
      field: "description",
    });
  }

  const minStock = product?.min_stock_quantity ?? product?.stock_minimum;
  const currentStock = product?.stock_quantity ?? product?.stock_real;
  if (minStock != null && minStock !== "" && currentStock != null && currentStock !== "") {
    const min = parseInt(String(minStock), 10);
    const curr = parseInt(String(currentStock), 10);
    if (!Number.isNaN(min) && !Number.isNaN(curr) && curr <= min) {
      warnings.push({
        code: "STOCK_AT_OR_BELOW_MIN",
        message: "Estoque atual está igual ou abaixo do mínimo.",
        field: "stock",
      });
    }
  }

  if (format === "variants") {
    for (let i = 0; i < variantsArr.length; i++) {
      const v = variantsArr[i];
      const vMin = v?.min_stock_quantity ?? v?.stock_minimum;
      const vCurr = v?.stock_quantity ?? v?.stock_real;
      if (vMin != null && vMin !== "" && vCurr != null && vCurr !== "") {
        const min = parseInt(String(vMin), 10);
        const curr = parseInt(String(vCurr), 10);
        if (!Number.isNaN(min) && !Number.isNaN(curr) && curr <= min) {
          warnings.push({
            code: "VARIANT_STOCK_AT_OR_BELOW_MIN",
            message: `Variação "${Object.values(v?.attributes || {}).join(" / ") || i + 1}" com estoque no mínimo.`,
            field: "variants",
          });
          break;
        }
      }
    }
  }

  if (titlesArr.length === 0) {
    warnings.push({
      code: "NO_AD_TITLES",
      message: "Nenhum título alternativo. Recomendado para estratégia ML.",
      field: "ad_titles",
    });
  }

  // ------------------------------------------------------------------
  // readyToPublish
  // ------------------------------------------------------------------

  const readyToPublish = blocking.length === 0 && status === "ready";

  return {
    readyToPublish,
    blocking,
    warnings,
    meta: {
      format,
      hasVariations,
      titlesCount: titlesArr.length,
      imagesCount: imagesArr.length,
      variantsCount: variantsArr.length,
    },
  };
}
