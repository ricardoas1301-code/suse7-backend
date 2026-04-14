// ======================================================
// Extração monetária do payload ML (items / listing_prices enriquecido).
// GET /items muitas vezes não traz sale_fee_details; taxas vêm de listing_prices.
// ======================================================

import {
  logPricingEvent,
  PRICING_EVENT_CODE,
  PRICING_LOG_LEVEL,
} from "../../../domain/pricing/pricingInconsistencyLog.js";

/** @param {unknown} v */
export function toFiniteNumber(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s0 = v.trim();
    if (!s0) return null;
    // Alguns payloads vêm como "R$ 48,05", "BRL 48.05" ou com texto auxiliar.
    // Mantemos apenas dígitos, sinal e separadores decimais para parse monetário seguro.
    let s = s0.replace(/[^\d,.\-]/g, "");
    if (!s) return null;
    if (s.includes(",") && !s.includes(".")) {
      s = s.replace(",", ".");
    } else if (s.includes(",") && s.includes(".")) {
      s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
    }
    const nStr = Number(s);
    return Number.isFinite(nStr) ? nStr : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Valor monetário de taxa no payload ML: número direto ou objeto `{ amount }` / `{ value }` / `{ total }`.
 * Sem isso, `selling_fee` aninhado é ignorado e o banco grava só o bruto (`sale_fee_amount`).
 *
 * @param {unknown} v
 * @returns {number | null}
 */
export function toFiniteFeeScalar(v) {
  if (v == null || v === "") return null;
  if (typeof v === "object" && !Array.isArray(v) && v !== null) {
    const o = /** @type {Record<string, unknown>} */ (v);
    const inner = o.amount ?? o.value ?? o.total;
    if (inner != null && inner !== "") {
      return toFiniteNumber(inner);
    }
    return null;
  }
  return toFiniteNumber(v);
}

/** @param {unknown[]} vals */
function coalescePositiveFeeAmountVals(...vals) {
  for (const v of vals) {
    const n = toFiniteFeeScalar(v);
    if (n != null && n > 0) return n;
  }
  return null;
}

/**
 * Logs [ML_FEE_FINAL_DECISION] — `ML_FEE_FINAL_DECISION=1` ou `ML_FEE_FINAL_DECISION_EXT_ID` contendo o id.
 */
export function mlFeeFinalDecisionLogEnabled(extId) {
  if (process.env.ML_FEE_FINAL_DECISION === "1") return true;
  const needle = String(process.env.ML_FEE_FINAL_DECISION_EXT_ID ?? "").trim();
  return needle !== "" && extId != null && String(extId).includes(needle);
}

/**
 * Logs [ML_FEE_BASE_RULE] — base de cálculo (sale_price_effective × % = gross).
 * `ML_FEE_BASE_RULE=1` ou `ML_FEE_BASE_RULE_EXT_ID` contendo o listing id.
 */
export function mlFeeBaseRuleLogEnabled(extId) {
  if (process.env.ML_FEE_BASE_RULE === "1") return true;
  const needle = String(process.env.ML_FEE_BASE_RULE_EXT_ID ?? "").trim();
  return needle !== "" && extId != null && String(extId).includes(needle);
}

/**
 * Taxa efetiva a persistir a partir da linha GET /sites/.../listing_prices.
 * O ML costuma enviar `sale_fee_amount` (tabela/bruto) e `selling_fee` / `selling_fee_amount` (efetivo após benefícios).
 * Coalescer na ordem antiga (sale_fee primeiro) ignorava o subsídio e gravava o valor cru (ex.: 4,93 vs 3,52).
 *
 * @param {Record<string, unknown> | null | undefined} listingPricesRow
 * @returns {number | null}
 */
/**
 * ML às vezes coloca `selling_fee` / `net_fee` só dentro de `sale_fee_details` (não no root da linha).
 * Escolhe o **menor** valor plausível ≤ tarifa bruta — costuma ser a tarifa efetiva após subsídio.
 * @param {unknown} d
 * @param {number | null | undefined} grossHint — `sale_fee_amount` bruto; filtra ruídos &lt; 1% do bruto.
 * @returns {number | null}
 */
function extractMinNetSellerFeeNestedInSaleFeeDetails(d, grossHint) {
  if (d == null) return null;
  /** @type {number[]} */
  const candidates = [];
  const walk = (node, depth) => {
    if (node == null || depth > 22) return;
    if (Array.isArray(node)) {
      for (const el of node) walk(el, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    const o = /** @type {Record<string, unknown>} */ (node);
    for (const k of [
      "selling_fee",
      "selling_fee_amount",
      "net_selling_fee",
      "final_selling_fee",
      "charged_fee",
      "fee_to_pay",
      "net_fee",
      "total_selling_fee",
    ]) {
      if (!(k in o)) continue;
      const n = toFiniteFeeScalar(o[k]);
      if (n != null && n > 0.005 && n < 1e6) candidates.push(n);
    }
    for (const v of Object.values(o)) {
      if (v != null && typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(d, 0);
  if (candidates.length === 0) return null;
  const cap = grossHint != null && grossHint > 0 ? grossHint + 0.05 : null;
  const floor = grossHint != null && grossHint > 0 ? Math.max(0.05, grossHint * 0.15) : 0.05;
  const filtered =
    cap != null ? candidates.filter((c) => c >= floor && c <= cap) : candidates;
  if (filtered.length === 0) return null;
  return Math.min(...filtered);
}

/**
 * Soma valores em chaves que indicam desconto/subsídio explícito no JSON do ML
 * (quando o breakdown não classifica como crédito, mas há campo `promotional_discount`, etc.).
 * @param {unknown} d
 * @returns {number | null}
 */
function sumDiscountLikeKeyedAmountsInTree(d) {
  if (d == null) return null;
  let sum = 0;
  let hits = 0;
  /** @param {unknown} node @param {number} depth */
  const walk = (node, depth) => {
    if (node == null || depth > 20) return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (node))) {
      const kl = k.toLowerCase();
      if (
        /\b(discount|reduction|rebate|credit|benefit|subsidy|adjustment|promo|desconto|cr[ée]dito)\b/i.test(
          kl,
        ) ||
        /_discount$|_credit$|_reduction$|_rebate$/i.test(kl)
      ) {
        if (typeof v === "number" && Number.isFinite(v) && v > 0 && v < 500) {
          sum += v;
          hits += 1;
          continue;
        }
        const n = toFiniteFeeScalar(v);
        if (n != null && n > 0 && n < 500) {
          sum += n;
          hits += 1;
        }
        continue;
      }
      if (v != null && typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(d, 0);
  return hits > 0 && sum > 0.001 ? sum : null;
}

export function coalesceListingPricesPersistedFeeAmount(listingPricesRow) {
  if (!listingPricesRow || typeof listingPricesRow !== "object") return null;
  const r = /** @type {Record<string, unknown>} */ (listingPricesRow);
  const grossLike = coalescePositiveFeeAmountVals(r.sale_fee_amount, r.sale_fee);
  const sellingLike = coalescePositiveFeeAmountVals(
    r.selling_fee_amount,
    r.selling_fee,
    r.net_selling_fee,
    r.final_selling_fee,
    r.total_selling_fee
  );
  /** @type {number | null} */
  let primary;
  if (sellingLike != null && grossLike != null) {
    primary = sellingLike <= grossLike + 0.05 ? sellingLike : grossLike;
  } else {
    primary = sellingLike ?? grossLike;
  }
  const detailAmt = normalizeSaleFeeDetailsShape(r.sale_fee_details).amount;
  if (detailAmt != null && detailAmt > 0) {
    if (primary == null) return detailAmt;
    if (detailAmt < primary - 0.001) return detailAmt;
  }
  const nestedNet = extractMinNetSellerFeeNestedInSaleFeeDetails(r.sale_fee_details, grossLike);
  if (nestedNet != null && primary != null && nestedNet < primary - 0.001) {
    return nestedNet;
  }

  const rootDisc = coalescePositiveFeeAmountVals(
    r.promotional_discount_amount,
    r.discount_amount,
    r.meli_discount_amount,
    r.meli_discount,
    r.cost_reduction_amount,
    r.seller_cost_reduction,
    r.seller_cost_reduction_amount,
  );
  if (
    rootDisc != null &&
    rootDisc > 0.001 &&
    grossLike != null &&
    grossLike > rootDisc + 0.001 &&
    primary != null &&
    Math.abs(primary - grossLike) < 0.02
  ) {
    return Math.round((grossLike - rootDisc) * 100) / 100;
  }

  const treeDisc = sumDiscountLikeKeyedAmountsInTree(r.sale_fee_details);
  if (
    treeDisc != null &&
    grossLike != null &&
    grossLike > treeDisc + 0.05 &&
    primary != null &&
    Math.abs(primary - grossLike) < 0.02 &&
    treeDisc < grossLike - 0.05
  ) {
    const inferred = Math.round((grossLike - treeDisc) * 100) / 100;
    if (inferred > 0.01 && inferred < grossLike - 0.001) return inferred;
  }

  return primary;
}

/**
 * Referência de bruto na linha (para auditoria de desconto = gross − final), quando ambos existem.
 *
 * @param {Record<string, unknown> | null | undefined} listingPricesRow
 * @returns {number | null}
 */
export function extractListingPricesGrossReferenceAmount(listingPricesRow) {
  if (!listingPricesRow || typeof listingPricesRow !== "object") return null;
  const r = /** @type {Record<string, unknown>} */ (listingPricesRow);
  const grossLike = coalescePositiveFeeAmountVals(r.sale_fee_amount, r.sale_fee);
  const sellingLike = coalescePositiveFeeAmountVals(
    r.selling_fee_amount,
    r.selling_fee,
    r.net_selling_fee,
    r.final_selling_fee,
    r.total_selling_fee
  );
  if (grossLike != null && sellingLike != null && grossLike > sellingLike + 0.001) return grossLike;
  return grossLike;
}

/**
 * Subsídio / redução de custos do ML (rodapé do Raio-X: "redução de R$ X aplicada aos seus custos").
 * Fonte oficial: mesma linha de GET `/sites/{site_id}/listing_prices` — Δ entre tarifa bruta e efetiva,
 * ou breakdown em `sale_fee_details` quando o ML não expõe `selling_fee` isolado.
 *
 * @param {Record<string, unknown> | null | undefined} listingPricesRow
 * @returns {{
 *   amount_brl: number | null;
 *   gross_fee_brl: number | null;
 *   net_fee_brl: number | null;
 *   source: string | null;
 * }}
 */
export function extractMercadoLivreMarketplaceCostReductionFromListingPricesRow(listingPricesRow) {
  if (!listingPricesRow || typeof listingPricesRow !== "object") {
    return { amount_brl: null, gross_fee_brl: null, net_fee_brl: null, source: null };
  }
  const r = /** @type {Record<string, unknown>} */ (listingPricesRow);
  const grossScalar = coalescePositiveFeeAmountVals(r.sale_fee_amount, r.sale_fee);
  const sellingScalar = coalescePositiveFeeAmountVals(
    r.selling_fee_amount,
    r.selling_fee,
    r.net_selling_fee,
    r.final_selling_fee
  );
  const grossRef = extractListingPricesGrossReferenceAmount(r) ?? grossScalar;
  const netFee = coalesceListingPricesPersistedFeeAmount(r);

  if (grossRef != null && netFee != null && grossRef > netFee + 0.001) {
    return {
      amount_brl: Math.round((grossRef - netFee) * 100) / 100,
      gross_fee_brl: grossRef,
      net_fee_brl: netFee,
      source: "ml_listing_prices_gross_minus_effective_fee",
    };
  }
  if (
    grossScalar != null &&
    sellingScalar != null &&
    grossScalar > sellingScalar + 0.001
  ) {
    return {
      amount_brl: Math.round((grossScalar - sellingScalar) * 100) / 100,
      gross_fee_brl: grossScalar,
      net_fee_brl: sellingScalar,
      source: "ml_listing_prices_sale_fee_minus_selling_fee",
    };
  }
  return {
    amount_brl: null,
    gross_fee_brl: grossRef,
    net_fee_brl: netFee,
    source: null,
  };
}

const FEE_DEEP_MAX_DEPTH = 20;
const FEE_DEEP_MAX_JSON_STRING = 500_000;

/** Ignora subárvores enormes / irrelevantes para taxa. */
const FEE_DEEP_SKIP_KEYS = new Set([
  "pictures",
  "thumbnail",
  "secure_thumbnail",
  "descriptions",
  "attributes",
  "variations",
  "seller_address",
  "seller_contact",
  "location",
]);

/**
 * Campo de preço do item — nunca tratar como tarifa (evita confundir preço com fee).
 */
const FEE_DEEP_PRICE_KEYS = new Set([
  "price",
  "base_price",
  "original_price",
  "regular_amount",
  "list_price",
]);

const FEE_DEEP_PERCENT_KEYS = new Set([
  "percentage_fee",
  "meli_percentage_fee",
  "percentage",
  "percent",
]);

/** Chaves que, com número > 0, quase sempre são valor monetário de taxa no contexto ML. */
const FEE_DEEP_DIRECT_AMOUNT_KEYS = new Set([
  "sale_fee_amount",
  "sale_fee",
  "selling_fee",
  "total_fee",
  "gross_amount",
  "marketplace_fee",
  "variable_fee",
  "fixed_fee",
  "financing_add_on_fee",
  "commission",
  "fee_amount",
  "selling_fees",
]);

/** amount / total / fee / value — só contam se o caminho indicar contexto de taxa. */
const FEE_DEEP_GENERIC_KEYS = new Set(["amount", "total", "fee", "value"]);

/** @param {string} path */
function feeDeepPathLooksFeeish(path) {
  const p = path.toLowerCase();
  return (
    p.includes("sale_fee") ||
    p.includes("fee_details") ||
    p.includes("listing_prices") ||
    p.includes("selling_fee") ||
    p.includes("marketplace_fee") ||
    p.includes("breakdown") ||
    p.includes("charges") ||
    p.includes("components") ||
    p.includes(".fees") ||
    p.includes("[\"fees\"]") ||
    p.endsWith(".details") ||
    p.includes("details[")
  );
}

/**
 * @param {Record<string, unknown> | null | undefined} item
 */
export function mlFeeDeepExtractDebugEnabled(item) {
  if (process.env.ML_FEE_DEEP_EXTRACT === "1") return true;
  const id =
    item && typeof item === "object"
      ? item.id != null
        ? String(item.id)
        : item.external_listing_id != null
          ? String(item.external_listing_id)
          : ""
      : "";
  const needle = String(process.env.ML_FEE_DEEP_EXTRACT_EXT_ID ?? "4473596489").trim();
  return needle !== "" && id.includes(needle);
}

/**
 * Busca recursiva por valores de tarifa em shapes não documentados do ML.
 * Não percorre campos de preço do anúncio; chaves genéricas (amount/total) só com path “fee-ish”.
 *
 * @param {unknown} root — tipicamente `sale_fee_details` ou sub-objeto
 * @param {string} [rootPath]
 * @param {Record<string, unknown> | null | undefined} [ctxItem] — para log / flag de debug
 * @returns {{ found_amount: number | null; source_path: string | null; raw_snippet: string | null }}
 */
export function extractFeeAmountDeep(root, rootPath = "sale_fee_details", ctxItem = null) {
  /** @type {{ v: number; path: string; key: string; bucket: "direct" | "generic" }[]} */
  const hits = [];

  /** @param {unknown} node @param {string} path @param {number} depth */
  function walk(node, path, depth) {
    if (node == null || depth > FEE_DEEP_MAX_DEPTH) return;

    if (typeof node === "string") {
      const t = node.trim();
      if (
        (t.startsWith("{") || t.startsWith("[")) &&
        t.length > 0 &&
        t.length <= FEE_DEEP_MAX_JSON_STRING
      ) {
        try {
          walk(JSON.parse(t), `${path}«json»`, depth + 1);
        } catch {
          /* ignore */
        }
      }
      return;
    }

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        walk(node[i], `${path}[${i}]`, depth + 1);
      }
      return;
    }

    if (typeof node !== "object") return;

    const rec = /** @type {Record<string, unknown>} */ (node);
    const keys = Object.keys(rec);
    for (const k of keys) {
      if (FEE_DEEP_SKIP_KEYS.has(k)) continue;
      const v = rec[k];
      const nextPath = path ? `${path}.${k}` : k;

      if (FEE_DEEP_PRICE_KEYS.has(k)) {
        continue;
      }

      if (typeof v === "number" && Number.isFinite(v) && v > 0) {
        const lk = k.toLowerCase();
        if (FEE_DEEP_PERCENT_KEYS.has(lk)) continue;
        if (FEE_DEEP_DIRECT_AMOUNT_KEYS.has(lk)) {
          hits.push({ v, path: nextPath, key: lk, bucket: "direct" });
          continue;
        }
        if (FEE_DEEP_GENERIC_KEYS.has(lk) && feeDeepPathLooksFeeish(path)) {
          hits.push({ v, path: nextPath, key: lk, bucket: "generic" });
        }
        continue;
      }

      walk(v, nextPath, depth + 1);
    }
  }

  walk(root, rootPath, 0);

  /** @param {typeof hits} list */
  function pickAmount(list) {
    if (!list.length) return { found_amount: null, source_path: null };
    const direct = list.filter((h) => h.bucket === "direct");
    const gens = list.filter((h) => h.bucket === "generic");

    const gross = direct.filter((h) => h.key === "gross_amount");
    const fixed = direct.filter((h) => h.key === "fixed_fee");
    const fin = direct.filter((h) => h.key === "financing_add_on_fee");
    const varf = direct.filter((h) => h.key === "variable_fee");

    if (gross.length > 0 || fixed.length > 0 || fin.length > 0 || varf.length > 0) {
      const parts = [...gross, ...fixed, ...fin, ...varf];
      const sum = parts.reduce((a, h) => a + h.v, 0);
      if (sum > 0) {
        return {
          found_amount: sum,
          source_path: parts.map((p) => p.path).join("|"),
        };
      }
    }

    const prefOrder = [
      "sale_fee_amount",
      "total_fee",
      "marketplace_fee",
      "sale_fee",
      "selling_fee",
      "gross_amount",
      "fixed_fee",
      "variable_fee",
      "financing_add_on_fee",
      "commission",
      "fee_amount",
    ];
    for (const pk of prefOrder) {
      const m = direct.find((h) => h.key === pk);
      if (m) return { found_amount: m.v, source_path: m.path };
    }

    if (direct.length === 1) {
      return { found_amount: direct[0].v, source_path: direct[0].path };
    }

    if (gens.length === 1) {
      return { found_amount: gens[0].v, source_path: gens[0].path };
    }

    if (direct.length > 1) {
      const sorted = [...direct].sort((a, b) => a.v - b.v);
      return { found_amount: sorted[0].v, source_path: `${sorted[0].path}«pick_smallest_direct_conflict»` };
    }

    return { found_amount: null, source_path: null };
  }

  const picked = pickAmount(hits);
  let raw_snippet = null;
  try {
    const s = JSON.stringify(root);
    raw_snippet = s != null && s.length > 700 ? `${s.slice(0, 700)}…` : s;
  } catch {
    raw_snippet = "[unserializable]";
  }

  const verbose = mlFeeDeepExtractDebugEnabled(ctxItem);
  if (picked.found_amount != null || verbose) {
    let snippetOut = raw_snippet;
    if (!verbose && typeof snippetOut === "string" && snippetOut.length > 360) {
      snippetOut = `${snippetOut.slice(0, 360)}…`;
    }
    console.info("[ML_FEE_DEEP_EXTRACT]", {
      found_amount: picked.found_amount,
      source_path: picked.source_path,
      raw_snippet: snippetOut,
      hits_count: hits.length,
      root_path: rootPath,
    });
  }

  return { ...picked, raw_snippet };
}

/**
 * Encontra primeiro `sale_fee_details` (ou `fees`) em profundidade limitada no JSON do listing/health.
 * @param {unknown} root
 * @param {string} basePath
 * @param {number} depth
 * @returns {Generator<{ blob: unknown; path: string }>}
 */
function* iterSaleFeeDetailBlobs(root, basePath = "", depth = 0) {
  if (root == null || depth > 12) return;
  if (typeof root === "string") {
    const t = root.trim();
    if (
      (t.startsWith("{") || t.startsWith("[")) &&
      t.length > 0 &&
      t.length <= FEE_DEEP_MAX_JSON_STRING
    ) {
      try {
        yield* iterSaleFeeDetailBlobs(JSON.parse(t), `${basePath}«json»`, depth + 1);
      } catch {
        /* ignore */
      }
    }
    return;
  }
  if (Array.isArray(root)) {
    for (let i = 0; i < root.length; i++) {
      yield* iterSaleFeeDetailBlobs(root[i], `${basePath}[${i}]`, depth + 1);
    }
    return;
  }
  if (typeof root !== "object") return;
  const rec = /** @type {Record<string, unknown>} */ (root);

  const sfd = rec.sale_fee_details;
  if (sfd != null && sfd !== "") {
    yield { blob: sfd, path: basePath ? `${basePath}.sale_fee_details` : "sale_fee_details" };
  }
  const fees = rec.fees;
  if (fees != null && fees !== "" && typeof fees === "object") {
    yield { blob: fees, path: basePath ? `${basePath}.fees` : "fees" };
  }

  for (const k of Object.keys(rec)) {
    if (FEE_DEEP_SKIP_KEYS.has(k) || k === "sale_fee_details" || k === "fees") continue;
    const v = rec[k];
    const p = basePath ? `${basePath}.${k}` : k;
    if (v && (typeof v === "object" || typeof v === "string")) {
      yield* iterSaleFeeDetailBlobs(v, p, depth + 1);
    }
  }
}

/**
 * Aplica extractFeeAmountDeep em `sale_fee_details` e, se preciso, em blobs aninhados
 * de `listing.raw_json` (ou no próprio listing se for payload ML sem wrapper) e `health.raw_json` (incl. item_excerpt).
 * @param {Record<string, unknown>} coalescedItem — após coalesceMercadoLibreItemForMoneyExtract
 * @param {Record<string, unknown> | null | undefined} listing
 * @param {Record<string, unknown> | null | undefined} health
 * @returns {number | null}
 */
export function extractSaleFeeAmountWithDeepSources(coalescedItem, listing, health) {
  const item = coalescedItem;
  if (!item || typeof item !== "object") return null;

  /** IDs para ML_FEE_DEEP_EXTRACT / mlFeeDeepExtractDebugEnabled (moneyShape às vezes não traz id). */
  const logCtx = /** @type {Record<string, unknown>} */ ({
    ...item,
    id:
      item.id != null
        ? item.id
        : listing && typeof listing === "object" && listing.external_listing_id != null
          ? listing.external_listing_id
          : listing && typeof listing === "object" && listing.id != null
            ? listing.id
            : undefined,
    external_listing_id:
      item.external_listing_id != null
        ? item.external_listing_id
        : listing && typeof listing === "object" && listing.external_listing_id != null
          ? listing.external_listing_id
          : undefined,
  });

  const tryBlob = (blob, pathLabel) => {
    if (blob == null || blob === "") return null;
    const r = extractFeeAmountDeep(blob, pathLabel, logCtx);
    return r.found_amount != null && r.found_amount > 0 ? r.found_amount : null;
  };

  const sfd = item.sale_fee_details;
  let n = tryBlob(sfd, "coalesced.sale_fee_details");
  if (n != null) return n;

  /** Árvore do anúncio: DB (`raw_json`) ou resposta direta da API ML. */
  let listingTree = null;
  let listingBase = "";
  if (listing && typeof listing === "object") {
    if (listing.raw_json && typeof listing.raw_json === "object") {
      listingTree = /** @type {Record<string, unknown>} */ (listing.raw_json);
      listingBase = "listing.raw_json";
    } else {
      listingTree = /** @type {Record<string, unknown>} */ (listing);
      listingBase = "listing";
    }
  }
  if (listingTree) {
    for (const { blob, path } of iterSaleFeeDetailBlobs(listingTree, listingBase)) {
      n = tryBlob(blob, path);
      if (n != null) return n;
    }
  }

  const hr =
    health && typeof health === "object" && health.raw_json && typeof health.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (health.raw_json)
      : null;
  if (hr) {
    const ex =
      hr.item_excerpt && typeof hr.item_excerpt === "object" && !Array.isArray(hr.item_excerpt)
        ? /** @type {Record<string, unknown>} */ (hr.item_excerpt)
        : null;
    if (ex?.sale_fee_details != null) {
      n = tryBlob(
        ex.sale_fee_details,
        "health.raw_json.item_excerpt.sale_fee_details"
      );
      if (n != null) return n;
    }
    for (const { blob, path } of iterSaleFeeDetailBlobs(hr, "health.raw_json")) {
      n = tryBlob(blob, path);
      if (n != null) return n;
    }
  }

  return null;
}

/**
 * Taxa da linha oficial **GET /sites/:site_id/listing_prices** (sem deduzir % por preço do item).
 * `percentage_fee` / `meli_percentage_fee` / etc. vêm em `sale_fee_details`; valor em R$ na linha ou no breakdown.
 * @param {Record<string, unknown> | null | undefined} listingPricesRow — linha escolhida por `pickBestListingPricesRow`
 * @returns {{ percent: number | null; amount: number | null }}
 */
export function extractOfficialMercadoLibreListingPricesFee(listingPricesRow) {
  if (!listingPricesRow || typeof listingPricesRow !== "object") {
    return { percent: null, amount: null };
  }
  const r = /** @type {Record<string, unknown>} */ (listingPricesRow);
  const fromDetails = normalizeSaleFeeDetailsShape(r.sale_fee_details);
  let percent = fromDetails.percent != null && fromDetails.percent > 0 ? fromDetails.percent : null;
  /** Tarifa efetiva: mesma regra que coalesceListingPricesPersistedFeeAmount (subsídio ML na tarifa). */
  const coalescedEffective = coalesceListingPricesPersistedFeeAmount(r);
  let amount =
    coalescedEffective != null && coalescedEffective > 0
      ? coalescedEffective
      : fromDetails.amount != null && fromDetails.amount > 0
        ? fromDetails.amount
        : null;
  if (amount == null) {
    const raw = r.selling_fee ?? r.selling_fee_amount ?? r.sale_fee_amount ?? r.sale_fee;
    const a = toFiniteFeeScalar(raw);
    if (a != null && a > 0) amount = a;
  }
  return { percent, amount };
}

/**
 * @param {unknown} d — objeto ou array (ML documenta array em alguns contextos)
 * @returns {{ percent: number | null; amount: number | null }}
 */
function normalizeSaleFeeDetailsShape(d) {
  if (d == null) return { percent: null, amount: null };
  if (typeof d === "string") {
    const t = d.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        return normalizeSaleFeeDetailsShape(JSON.parse(d));
      } catch {
        return { percent: null, amount: null };
      }
    }
    return { percent: null, amount: null };
  }
  if (Array.isArray(d)) {
    let percent = null;
    let amount = null;
    for (const part of d) {
      if (!part || typeof part !== "object") continue;
      const rec = /** @type {Record<string, unknown>} */ (part);
      if (mlFeePartIsLikelyShippingOrLogistics(rec)) continue;
      const p = toFiniteNumber(
        rec.percentage_fee ??
          rec.meli_percentage_fee ??
          rec.percentage ??
          rec.percent
      );
      const gross = toFiniteNumber(rec.gross_amount ?? rec.total_amount);
      const fixed = toFiniteNumber(rec.fixed_fee);
      const fin = toFiniteNumber(rec.financing_add_on_fee);
      const saleFeePart = toFiniteNumber(rec.sale_fee ?? rec.sale_fee_amount);
      let pieceAmt =
        gross ?? (fixed != null && fixed > 0 ? fixed : null) ?? fin ?? saleFeePart;
      if (mlFeePartIsLikelyMarketplaceCostCredit(rec) && pieceAmt != null && pieceAmt !== 0) {
        pieceAmt = -Math.abs(pieceAmt);
      }
      if (p != null) percent = percent ?? p;
      if (pieceAmt != null && pieceAmt !== 0) {
        amount = (amount ?? 0) + pieceAmt;
      }
    }
    if (amount != null && amount <= 0) amount = null;
    return { percent, amount };
  }
  if (typeof d !== "object") return { percent: null, amount: null };
  const rec = /** @type {Record<string, unknown>} */ (d);
  if (Array.isArray(rec.elements)) {
    return normalizeSaleFeeDetailsShape(rec.elements);
  }
  if (Array.isArray(rec.breakdown)) {
    return normalizeSaleFeeDetailsShape(rec.breakdown);
  }
  if (Array.isArray(rec.fees)) {
    return normalizeSaleFeeDetailsShape(rec.fees);
  }
  if (Array.isArray(rec.selling_fees)) {
    return normalizeSaleFeeDetailsShape(rec.selling_fees);
  }
  if (Array.isArray(rec.charges)) {
    return normalizeSaleFeeDetailsShape(rec.charges);
  }
  if (Array.isArray(rec.benefits)) {
    return normalizeSaleFeeDetailsShape(rec.benefits);
  }
  if (Array.isArray(rec.discounts)) {
    return normalizeSaleFeeDetailsShape(rec.discounts);
  }
  let nested = rec.components ?? rec.details;
  if (typeof nested === "string") {
    const t = nested.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        nested = JSON.parse(nested);
      } catch {
        nested = null;
      }
    }
  }
  if (Array.isArray(nested)) {
    return normalizeSaleFeeDetailsShape(nested);
  }
  if (nested && typeof nested === "object") {
    return normalizeSaleFeeDetailsShape(nested);
  }
  const percent = toFiniteNumber(
    rec.percentage_fee ?? rec.meli_percentage_fee ?? rec.percentage ?? rec.percent
  );
  const amount = toFiniteNumber(
    rec.gross_amount ??
      rec.sale_fee ??
      rec.sale_fee_amount ??
      rec.selling_fee ??
      rec.total_fee ??
      rec.total_amount ??
      rec.marketplace_fee ??
      rec.variable_fee ??
      rec.fixed_fee ??
      rec.financing_add_on_fee
  );
  return { percent, amount: amount != null && amount > 0 ? amount : null };
}

const ML_FEE_BREAKDOWN_NESTED_KEYS = /** @type {const} */ ([
  "elements",
  "breakdown",
  "fees",
  "selling_fees",
  "charges",
  "lines",
  "line_items",
  "items",
  "segments",
  "children",
  "sub_fees",
  "fee_lines",
  "operations",
  "buckets",
  "details_list",
  "components",
]);

/** @param {Record<string, unknown>} part */
function mercadoLivreFeePartDescriptorString(part) {
  const bits = [
    part.type,
    part.component,
    part.detailing,
    part.name,
    part.label,
    part.title,
    part.category,
    part.fee_type,
    part.concept,
    part.group,
    part.service_type,
    part.operation_type,
    part.channel,
    part.id,
    part.reference_id,
    part.description,
    part.detail,
  ];
  return bits
    .filter((x) => x != null && x !== "")
    .map((x) => String(x).toLowerCase())
    .join(" ");
}

/** @param {Record<string, unknown>} part */
function mlFeePartIsLikelyVariableCommission(part) {
  const pct = toFiniteNumber(
    part.percentage_fee ?? part.meli_percentage_fee ?? part.percentage ?? part.percent
  );
  if (pct != null && pct > 0.001) return true;
  const t = mercadoLivreFeePartDescriptorString(part);
  return /variable|percentage|commission|tarifa.?vari|sale_fee_percent/i.test(t);
}

/** Parcela de frete/logística no breakdown — não entra na tarifa de venda nem no subsídio de comissão. */
function mlFeePartIsLikelyShippingOrLogistics(part) {
  const t = mercadoLivreFeePartDescriptorString(part);
  return /ship|logist|envio|fulfillment|xd|handling|frete|delivery|meli_ship|shipment|mdd|cross_docking|postagem|correios|carrier|last_mile|coleta|colecta|meli_env|warehouse|armaz|turbo|flex|place|full|distribution|distribui|pickup|pack/i.test(
    t
  );
}

/** Chaves típicas de payload ML para logística sem depender só de texto em type/name. */
function mlFeePartHasShippingKeyHints(part) {
  const keys = Object.keys(part)
    .join(" ")
    .toLowerCase();
  return /shipping|logist|frete|fulfillment|delivery|envio|meli_env|xd_|postagem|logistic_type|shipping_mode|handling/i.test(
    keys
  );
}

/**
 * Crédito / redução de custos sobre a tarifa (painel ML: subsídio aplicado à comissão).
 * `type` / texto costumam indicar discount, benefit, subsidy, etc.
 */
function mlFeePartIsLikelyMarketplaceCostCredit(part) {
  const t = mercadoLivreFeePartMarketCostCreditString(part);
  const typeStr = String(part.type ?? "").toLowerCase();
  return (
    /discount|reduction|deduction|benefit|bonus|subsidy|credit|cr[eé]dito|promo[cç][aã]o|rebate|incentiv|ajuste.?cust|cost.?reduc|desconto|subs[ií]dio|redu[cç][aã]o|meli.?discount|seller.?discount|fee.?adjust|cost.?shar/i.test(
      t
    ) ||
    /discount|reduction|deduction|benefit|bonus|subsidy|credit|rebate|incentive|adjustment|seller_discount|fee_discount|meli_discount/i.test(
      typeStr
    )
  );
}

/** @param {Record<string, unknown>} part */
function mercadoLivreFeePartMarketCostCreditString(part) {
  const bits = [
    part.type,
    part.component,
    part.detailing,
    part.name,
    part.id,
    part.reference_id,
    part.description,
    part.detail,
  ];
  return bits
    .filter((x) => x != null && x !== "")
    .map((x) => String(x).toLowerCase())
    .join(" ");
}

/**
 * Descobre folhas com valores monetários no breakdown de taxa ML (sem somar comissão variável).
 * @param {unknown} d
 * @param {Record<string, unknown>[]} acc
 * @param {number} depth
 */
function collectSaleFeeBreakdownLeafParts(d, acc, depth) {
  if (depth > 25 || d == null) return;
  if (typeof d === "string") {
    const t = d.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        collectSaleFeeBreakdownLeafParts(JSON.parse(t), acc, depth + 1);
      } catch {
        /* ignore */
      }
    }
    return;
  }
  if (Array.isArray(d)) {
    for (const x of d) collectSaleFeeBreakdownLeafParts(x, acc, depth + 1);
    return;
  }
  if (typeof d !== "object") return;
  const rec = /** @type {Record<string, unknown>} */ (d);
  /** Varrer todas as chaves com array não vazio — evita parar em `elements: []` e ignorar `breakdown: [...]`. */
  let foundAnyNestedArray = false;
  for (const k of ML_FEE_BREAKDOWN_NESTED_KEYS) {
    const v = rec[k];
    if (Array.isArray(v) && v.length > 0) {
      foundAnyNestedArray = true;
      for (const x of v) collectSaleFeeBreakdownLeafParts(x, acc, depth + 1);
    }
  }
  if (foundAnyNestedArray) return;
  let nestedObj = rec.components ?? rec.details;
  if (typeof nestedObj === "string") {
    const t = nestedObj.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        nestedObj = JSON.parse(nestedObj);
      } catch {
        nestedObj = null;
      }
    }
  }
  if (nestedObj && typeof nestedObj === "object") {
    collectSaleFeeBreakdownLeafParts(nestedObj, acc, depth + 1);
    return;
  }
  if (
    rec.gross_amount != null ||
    rec.total_amount != null ||
    rec.fixed_fee != null ||
    rec.percentage_fee != null ||
    rec.meli_percentage_fee != null ||
    rec.type != null ||
    rec.amount != null ||
    rec.value != null
  ) {
    acc.push(rec);
  }
}

/** @param {Record<string, unknown>} part @returns {number | null} */
function mlLogisticsAmountFromFeePart(part) {
  const absPos = (n) => {
    if (n == null || !Number.isFinite(n)) return null;
    const a = Math.abs(n);
    return a > 0.001 ? a : null;
  };
  const pickLogisticsMoney = () =>
    absPos(
      toFiniteNumber(
        part.gross_amount ??
          part.total_amount ??
          part.net_amount ??
          part.fixed_fee ??
          part.amount ??
          part.value ??
          part.charge ??
          part.seller_cost ??
          part.seller_amount ??
          part.debit_amount ??
          part.cost ??
          part.total_cost
      )
    );

  if (mlFeePartIsLikelyVariableCommission(part)) return null;

  const descriptor = mercadoLivreFeePartDescriptorString(part);
  const hasShippingHints =
    mlFeePartIsLikelyShippingOrLogistics(part) ||
    mlFeePartHasShippingKeyHints(part) ||
    /ship|logist|envio|fulfillment|xd|handling|frete|delivery|meli_ship|shipment|mdd|cross_docking|postagem|correios|carrier|meli_env/i.test(
      descriptor
    );

  const fixed = toFiniteNumber(part.fixed_fee);
  if (fixed != null && Math.abs(fixed) > 0.001 && hasShippingHints) return absPos(fixed);

  if (hasShippingHints) {
    const a = pickLogisticsMoney();
    if (a != null) return a;
  }

  // Heurística segura: no breakdown do ML, parcelas sem percentual (não-comissão)
  // com valor monetário positivo costumam representar a linha de custo de envio.
  // Mantemos essa captura como fallback quando os descritores não vierem preenchidos.
  const pct = toFiniteNumber(
    part.percentage_fee ?? part.meli_percentage_fee ?? part.percentage ?? part.percent
  );
  if (pct == null || Math.abs(pct) <= 0.001) {
    const generic = toFiniteNumber(
      part.gross_amount ?? part.total_amount ?? part.amount ?? part.value ?? part.charge
    );
    const gAbs = absPos(generic);
    if (gAbs != null) {
      // Evita capturar resíduos espúrios (ex.: 1.35) em linhas sem indício de logística.
      if (gAbs < 2 && !hasShippingHints) return null;
      return gAbs;
    }
  }
  return null;
}

/**
 * @param {unknown} d
 * @returns {unknown}
 */
function unwrapSaleFeeDetailsForLogistics(d) {
  if (d == null) return d;
  if (Array.isArray(d)) return d;
  if (typeof d !== "object") return d;
  const r = /** @type {Record<string, unknown>} */ (d);
  const inner = r.data ?? r.result ?? r.payload ?? r.fee_details ?? r.body;
  if (inner != null && inner !== d && typeof inner === "object") {
    return unwrapSaleFeeDetailsForLogistics(inner);
  }
  return d;
}

/**
 * @param {unknown} d
 * @returns {boolean}
 */
function saleFeeDetailsLooksNonEmptyForAudit(d) {
  if (d == null) return false;
  if (Array.isArray(d)) return d.length > 0;
  if (typeof d === "string") return d.trim().length > 0;
  if (typeof d !== "object") return false;
  return Object.keys(/** @type {Record<string, unknown>} */ (d)).length > 0;
}

/**
 * @param {unknown} d
 * @param {number} [maxLen]
 */
function safeSaleFeeDetailsExcerpt(d, maxLen) {
  const max = maxLen ?? 2200;
  try {
    const s = JSON.stringify(d);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return "[unserializable]";
  }
}

/**
 * Valor da linha que o ML mostra como “Custo de envio do Mercado Livre” no Raio-X: costuma vir
 * como segunda parcela em `sale_fee_details` (`fixed_fee` ou componente logístico), não em `shipping.cost`.
 *
 * @param {unknown} saleFeeDetails
 * @param {{
 *   listing_id?: string | null;
 *   logContext?: string;
 *   auditLog?: boolean;
 * }} [opts] `auditLog: false` evita log de auditoria em chamada duplicada no mesmo row.
 * @returns {number | null}
 */
export function extractMercadoLivreLogisticsSellerCost(saleFeeDetails, opts = {}) {
  const listingId = opts.listing_id != null ? String(opts.listing_id) : null;
  const logContext = opts.logContext ?? "extract_mercado_livre_logistics_seller_cost";
  const auditLog = opts.auditLog !== false;

  const raw = unwrapSaleFeeDetailsForLogistics(saleFeeDetails);
  /** @type {Record<string, unknown>[]} */
  const parts = [];
  collectSaleFeeBreakdownLeafParts(raw, parts, 0);

  /** @type {number[]} */
  const candidates = [];
  let commissionIdx = -1;
  for (let i = 0; i < parts.length; i++) {
    if (mlFeePartIsLikelyVariableCommission(parts[i])) {
      commissionIdx = i;
      continue;
    }
    const a = mlLogisticsAmountFromFeePart(parts[i]);
    if (a != null && a > 0.001) candidates.push(a);
  }
  let sum = candidates.reduce((s, x) => s + x, 0);

  if (sum <= 0.001 && parts.length === 2 && commissionIdx >= 0) {
    const other = parts[commissionIdx === 0 ? 1 : 0];
    if (!mlFeePartIsLikelyVariableCommission(other)) {
      const otherLooksShipping =
        mlFeePartIsLikelyShippingOrLogistics(other) || mlFeePartHasShippingKeyHints(other);
      const g = toFiniteNumber(
        other.gross_amount ?? other.total_amount ?? other.fixed_fee ?? other.amount
      );
      if (g != null && g > 0.001 && (otherLooksShipping || g >= 2)) sum = g;
    }
  }

  if (sum <= 0.001 && parts.length === 2) {
    const p0 = parts[0];
    const p1 = parts[1];
    const pct0 = toFiniteNumber(
      p0.percentage_fee ?? p0.meli_percentage_fee ?? p0.percentage ?? p0.percent
    );
    const pct1 = toFiniteNumber(
      p1.percentage_fee ?? p1.meli_percentage_fee ?? p1.percentage ?? p1.percent
    );
    const p0HasPct = pct0 != null && Math.abs(pct0) > 0.001;
    const p1HasPct = pct1 != null && Math.abs(pct1) > 0.001;
    if (p0HasPct !== p1HasPct) {
      const nonPct = p0HasPct ? p1 : p0;
      if (!mlFeePartIsLikelyVariableCommission(nonPct)) {
        const nonPctLooksShipping =
          mlFeePartIsLikelyShippingOrLogistics(nonPct) || mlFeePartHasShippingKeyHints(nonPct);
        const g = toFiniteNumber(
          nonPct.gross_amount ??
            nonPct.total_amount ??
            nonPct.fixed_fee ??
            nonPct.amount ??
            nonPct.value
        );
        if (g != null && g > 0.001 && (nonPctLooksShipping || g >= 2)) sum = g;
      }
    }
  }

  if (sum <= 0.001 && parts.length > 0) {
    let shipSum = 0;
    for (const p of parts) {
      if (mlFeePartIsLikelyVariableCommission(p)) continue;
      if (!mlFeePartIsLikelyShippingOrLogistics(p) && !mlFeePartHasShippingKeyHints(p)) continue;
      const a = mlLogisticsAmountFromFeePart(p);
      if (a != null && a > 0.001) shipSum += a;
    }
    if (shipSum > 0.001) sum = shipSum;
  }

  const result = sum > 0.001 ? Math.round(sum * 100) / 100 : null;

  let excerptLen = 0;
  try {
    excerptLen = saleFeeDetails != null ? JSON.stringify(saleFeeDetails).length : 0;
  } catch {
    excerptLen = 99;
  }
  if (
    result == null &&
    auditLog &&
    saleFeeDetailsLooksNonEmptyForAudit(saleFeeDetails) &&
    (parts.length > 0 || excerptLen > 80)
  ) {
    logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.SHIPPING_COST_PARSE_FAILED_FROM_SALE_FEE_DETAILS, {
      marketplace: "mercado_livre",
      listing_id: listingId,
      context: logContext,
      reason: parts.length === 0 ? "no_leaf_parts_collected" : "no_logistics_amount_in_breakdown",
      leaf_parts_count: parts.length,
      sale_fee_details_excerpt: safeSaleFeeDetailsExcerpt(saleFeeDetails, 2200),
    });
  }

  return result;
}

/**
 * @param {Record<string, unknown> | null | undefined} item
 * @param {{
 *   deriveFromPercent?: boolean;
 *   listing?: Record<string, unknown> | null;
 *   health?: Record<string, unknown> | null;
 *   skipDeepExtract?: boolean;
 * }} [opts] — default true; false para decidir se precisa chamar listing_prices (só amount “explícito”).
 *   `listing` / `health`: opcionais para varrer raw_json quando a taxa está aninhada fora do shape habitual.
 *   `skipDeepExtract`: quando true, não usa busca profunda — use ao decidir se deve chamar listing_prices
 *   (evita “falso positivo” em campos numéricos do item que não são tarifa e fariam pular a API oficial).
 * @returns {{ percent: number | null; amount: number | null }}
 */
export function extractSaleFee(item, opts = {}) {
  const derive = opts.deriveFromPercent !== false;
  if (!item || typeof item !== "object") return { percent: null, amount: null };
  const rootAmount = toFiniteNumber(item.sale_fee_amount);
  const fromDetails = normalizeSaleFeeDetailsShape(item.sale_fee_details);
  let amount =
    fromDetails.amount != null && fromDetails.amount > 0
      ? fromDetails.amount
      : rootAmount != null && rootAmount > 0
        ? rootAmount
        : null;
  let percent = fromDetails.percent;

  if (opts.skipDeepExtract !== true && (amount == null || amount <= 0)) {
    const deepAmt = extractSaleFeeAmountWithDeepSources(
      /** @type {Record<string, unknown>} */ (item),
      opts.listing ?? undefined,
      opts.health ?? undefined
    );
    if (deepAmt != null && deepAmt > 0) amount = deepAmt;
  }

  const price = toFiniteNumber(item.price);
  if (!derive) {
    return { percent, amount: amount != null && amount > 0 ? amount : null };
  }
  if (percent == null && amount != null && amount > 0 && price != null && price > 0) {
    percent = (amount / price) * 100;
  }
  if ((amount == null || amount <= 0) && percent != null && price != null && price > 0) {
    amount = (price * percent) / 100;
  }
  return { percent, amount: amount != null && amount > 0 ? amount : null };
}

/**
 * @param {Record<string, unknown> | null | undefined} item
 */
export function extractShippingCost(item) {
  if (!item || typeof item !== "object") return null;
  const sh = item.shipping;
  if (!sh || typeof sh !== "object") return null;
  const c = toFiniteNumber(
    sh.cost ??
      sh.list_cost ??
      sh.default_cost ??
      sh.paid_cost ??
      sh.seller_cost ??
      sh.consolidated_price ??
      sh.base_cost
  );
  if (c != null) return c;
  const fm = sh.free_methods;
  if (Array.isArray(fm) && fm[0] && typeof fm[0] === "object") {
    return toFiniteNumber(fm[0].cost ?? fm[0].rule?.default_cost);
  }
  const opts = sh.options;
  if (Array.isArray(opts)) {
    let best = null;
    for (const o of opts) {
      if (!o || typeof o !== "object") continue;
      const oc = toFiniteNumber(o.cost ?? o.list_cost);
      if (oc != null && oc > 0) best = best == null ? oc : Math.min(best, oc);
    }
    if (best != null) return best;
  }
  /** busca profunda para payloads com chaves não padronizadas (to_pay/seller_cost etc) */
  const stack = [{ v: sh, p: "shipping", d: 0 }];
  /** @type {{ score: number; amount: number } | null} */
  let bestDeep = null;
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || cur.d > 8) continue;
    const { v, p, d } = cur;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) stack.push({ v: v[i], p: `${p}[${i}]`, d: d + 1 });
      continue;
    }
    if (!v || typeof v !== "object") continue;
    const rec = /** @type {Record<string, unknown>} */ (v);
    for (const [k, raw] of Object.entries(rec)) {
      const kp = `${p}.${k}`.toLowerCase();
      if (raw && typeof raw === "object") {
        stack.push({ v: raw, p: `${p}.${k}`, d: d + 1 });
      }
      const n = toFiniteNumber(raw);
      if (n == null || n <= 0) continue;
      let score = 0;
      if (/ship|envio|frete|logist|delivery/.test(kp)) score += 3;
      if (/seller|to_pay|payer|cost|amount|charge|subsid/.test(kp)) score += 3;
      if (/percent|rate|free_shipping|mode|status/.test(kp)) score -= 4;
      if (score <= 0) continue;
      if (!bestDeep || score > bestDeep.score || (score === bestDeep.score && n > bestDeep.amount)) {
        bestDeep = { score, amount: n };
      }
    }
  }
  if (bestDeep?.amount != null && bestDeep.amount > 0) return bestDeep.amount;
  return null;
}

/**
 * Valor oficial de custo de envio no payload do endpoint listing_prices quando disponível em chaves de frete.
 *
 * Prioridade: mesma linha do Raio-X / taxa — parcela logística em `sale_fee_details` (igual ao que a tarifa
 * ignora em `normalizeSaleFeeDetailsShape`). O scan heurístico profundo costuma falhar porque qualquer
 * caminho sob `sale_fee_details` contém o substring `sale_fee` e recebe penalidade, descartando `fixed_fee`
 * / valores da logística.
 *
 * @param {Record<string, unknown> | null | undefined} row
 * @param {{
 *   listing_id?: string | null;
 *   logContext?: string;
 *   auditLog?: boolean;
 *   logisticsSellerCostPrecalculated?: number | null;
 * }} [opts] Se `logisticsSellerCostPrecalculated` vier do caller, evita segundo parse do mesmo `sale_fee_details`.
 * @returns {number | null}
 */
export function extractMercadoLivreOfficialShippingFromListingPricesRow(row, opts = {}) {
  if (!row || typeof row !== "object") return null;
  const root = /** @type {Record<string, unknown>} */ (row);
  let fromBreakdown;
  if (opts != null && typeof opts === "object" && "logisticsSellerCostPrecalculated" in opts) {
    fromBreakdown = opts.logisticsSellerCostPrecalculated;
  } else {
    fromBreakdown = extractMercadoLivreLogisticsSellerCost(root.sale_fee_details, {
      listing_id: opts?.listing_id ?? null,
      logContext: opts?.logContext ?? "listing_prices_official_ship_row",
      auditLog: opts?.auditLog !== false,
    });
  }
  if (fromBreakdown != null && fromBreakdown > 0) return fromBreakdown;

  const stack = [{ v: root, p: "listing_prices_row", d: 0 }];
  /** @type {{ score: number; amount: number } | null} */
  let best = null;
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || cur.d > 10) continue;
    const { v, p, d } = cur;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) stack.push({ v: v[i], p: `${p}[${i}]`, d: d + 1 });
      continue;
    }
    if (!v || typeof v !== "object") continue;
    const rec = /** @type {Record<string, unknown>} */ (v);
    for (const [k, raw] of Object.entries(rec)) {
      const kp = `${p}.${k}`.toLowerCase();
      if (raw && typeof raw === "object") stack.push({ v: raw, p: `${p}.${k}`, d: d + 1 });
      const n = toFiniteNumber(raw);
      if (n == null || n <= 0) continue;
      let score = 0;
      if (/shipping|ship|envio|frete|logist|delivery/.test(kp)) score += 4;
      if (/seller|to_pay|payer|cost|amount|charge|subsid|rebate|discount/.test(kp)) score += 3;
      if (/sale_fee|commission|percent|rate/.test(kp)) score -= 4;
      if (score <= 0) continue;
      if (!best || score > best.score || (score === best.score && n > best.amount)) {
        best = { score, amount: n };
      }
    }
  }
  return best?.amount != null && best.amount > 0 ? Math.round(best.amount * 100) / 100 : null;
}

/**
 * Unifica caminhos comuns do payload ML antes de extractSaleFee / shipping / promo.
 * GET /items multiget ou variações podem trazer sale_fee_details como string JSON ou taxas em `fees`.
 * @param {Record<string, unknown> | null | undefined} item
 */
export function coalesceMercadoLibreItemForMoneyExtract(item) {
  if (!item || typeof item !== "object") return /** @type {Record<string, unknown>} */ ({});
  const o = /** @type {Record<string, unknown>} */ ({ ...item });
  let sfd = o.sale_fee_details;
  if (typeof sfd === "string") {
    const t = sfd.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        sfd = JSON.parse(sfd);
        o.sale_fee_details = sfd;
      } catch {
        /* manter string */
      }
    }
  }
  if ((sfd == null || sfd === "") && Array.isArray(o.fees)) {
    o.sale_fee_details = o.fees;
  }
  if (
    (o.sale_fee_details == null || o.sale_fee_details === "") &&
    o.fees &&
    typeof o.fees === "object" &&
    !Array.isArray(o.fees)
  ) {
    o.sale_fee_details = o.fees;
  }
  return o;
}

/**
 * Preço efetivo em promoção (valor riscado > preço atual).
 * @param {Record<string, unknown> | null | undefined} item
 */
export function extractPromotionPrice(item) {
  if (!item || typeof item !== "object") return null;

  const prices = item.prices;
  if (Array.isArray(prices)) {
    for (const p of prices) {
      if (!p || typeof p !== "object") continue;
      const amt = toFiniteNumber(p.amount ?? p.price);
      const reg = toFiniteNumber(p.regular_amount ?? p.metadata?.promotion_price);
      if (reg != null && amt != null && reg > amt) return amt;
    }
  }

  const orig = toFiniteNumber(item.original_price);
  const price = toFiniteNumber(item.price);
  if (orig != null && price != null && orig > price) return price;

  const base = toFiniteNumber(item.base_price);
  if (base != null && price != null && base > price) return price;

  return null;
}

/**
 * ML move “você recebe” para objetos aninhados em sale_fee_details; varredura limitada por profundidade.
 * @param {unknown} blob
 * @param {number} depth
 * @returns {number | null}
 */
function deepExtractNetReceivableFromFeeBlob(blob, depth = 0) {
  if (depth > 12 || blob == null) return null;
  /** @type {readonly string[]} */
  const keys = /** @type {readonly string[]} */ ([
    "net_amount",
    "seller_net_amount",
    "net_sale_amount",
    "seller_receivable",
    "net_received_amount",
    "net_receive_amount",
    "received_amount",
    "seller_receive_amount",
    "seller_net",
    "net_credit",
  ]);
  if (Array.isArray(blob)) {
    for (const part of blob) {
      const n = deepExtractNetReceivableFromFeeBlob(part, depth + 1);
      if (n != null) return n;
    }
    return null;
  }
  if (typeof blob === "object") {
    const rec = /** @type {Record<string, unknown>} */ (blob);
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(rec, key)) {
        const n = toFiniteNumber(rec[key]);
        if (n != null && n >= 0) return n;
      }
    }
    for (const k of Object.keys(rec)) {
      const v = rec[k];
      if (v != null && typeof v === "object") {
        const n = deepExtractNetReceivableFromFeeBlob(v, depth + 1);
        if (n != null) return n;
      }
    }
  }
  return null;
}

/**
 * Valor explícito de “Você recebe” no payload ML (`sale_fee_details.net_amount` / `seller_net_amount` / `net_sale_amount`).
 * Fonte oficial usada no sync para `marketplace_listing_health.marketplace_payout_amount` quando disponível.
 *
 * @param {Record<string, unknown> | null | undefined} item
 */
export function extractNetReceivableExplicit(item) {
  if (!item || typeof item !== "object") return null;
  const d = item.sale_fee_details;
  if (Array.isArray(d)) {
    for (const part of d) {
      if (!part || typeof part !== "object") continue;
      const n = toFiniteNumber(
        /** @type {Record<string, unknown>} */ (part).net_amount ??
          /** @type {Record<string, unknown>} */ (part).seller_net_amount ??
          /** @type {Record<string, unknown>} */ (part).net_sale_amount
      );
      if (n != null) return n;
    }
  } else if (d && typeof d === "object") {
    const rec = /** @type {Record<string, unknown>} */ (d);
    const n = toFiniteNumber(rec.net_amount ?? rec.seller_net_amount ?? rec.net_sale_amount);
    if (n != null) return n;
  }
  if (d != null && d !== "") {
    const deepN = deepExtractNetReceivableFromFeeBlob(d);
    if (deepN != null) return deepN;
  }
  return toFiniteNumber(item.seller_net_amount ?? item.net_sale_amount);
}

/**
 * Mesmo que {@link extractNetReceivableExplicit} no item coalescido; se null, tenta a linha crua de listing_prices (campos às vezes só no row).
 *
 * @param {Record<string, unknown> | null | undefined} coalescedItem
 * @param {Record<string, unknown> | null | undefined} listingPricesRow
 * @returns {number | null}
 */
export function extractNetReceivableExplicitWithListingPricesRow(coalescedItem, listingPricesRow) {
  const a = extractNetReceivableExplicit(coalescedItem);
  if (a != null) return a;
  if (listingPricesRow && typeof listingPricesRow === "object") {
    return extractNetReceivableExplicit(/** @type {Record<string, unknown>} */ (listingPricesRow));
  }
  return null;
}

/**
 * Tenta ler preço de atacado (quantidade mínima + valor) do array `prices` do item ML.
 * Estrutura varia; quando não houver condição clara, retorna null.
 * @param {Record<string, unknown> | null | undefined} item
 * @returns {{ minQuantity: number; amount: number } | null}
 */
export function extractWholesalePriceTier(item) {
  if (!item || typeof item !== "object") return null;
  const prices = item.prices;
  if (!Array.isArray(prices)) return null;
  /** @type {{ minQuantity: number; amount: number } | null} */
  let best = null;
  for (const p of prices) {
    if (!p || typeof p !== "object") continue;
    const conds = p.conditions;
    if (!Array.isArray(conds)) continue;
    let minQ = null;
    for (const c of conds) {
      if (!c || typeof c !== "object") continue;
      const id = String(c.name ?? c.type ?? "").toUpperCase();
      if (id.includes("MIN_QUANTITY") || id.includes("QUANTITY")) {
        const raw = c.value ?? (Array.isArray(c.values) ? c.values[0] : null);
        const v = toFiniteNumber(raw);
        if (v != null && v > 1) minQ = Math.trunc(v);
      }
    }
    const amt = toFiniteNumber(p.amount ?? p.price);
    if (minQ != null && amt != null && amt > 0) {
      if (best == null || minQ < best.minQuantity) best = { minQuantity: minQ, amount: amt };
    }
  }
  return best;
}
