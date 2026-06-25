// ============================================================
// S7 — Concorrência: score leve de relevância para ordenar candidatos.
// Não descarta — apenas ordena (seller escolhe manualmente).
// ============================================================

const STOPWORDS = new Set([
  "de", "da", "do", "das", "dos", "com", "sem", "para", "pra", "e", "em",
  "a", "o", "as", "os", "no", "na", "nos", "nas", "por", "ao", "à", "the",
]);

/** Termos de material/tipo com peso maior na ordenação. */
export const STRONG_TERMS = new Set([
  "polipropileno", "madeira", "inox", "marmore", "mármore", "granito", "ceramica", "cerâmica",
  "plastico", "plástico", "acrilico", "acrílico", "aluminio", "alumínio", "vidro", "resina",
  "dobravel", "dobrável", "redonda", "retangular", "quadrada", "sobrepor", "encaixe",
  "tabua", "tábua", "cuba", "escorredor", "pia", "banheiro", "passar", "louca",
]);

/** Penalização leve quando busca material X e título destaca material divergente. */
const DIVERGENT_BY_QUERY_MATERIAL = {
  polipropileno: ["marmore", "mármore", "granito", "inox", "madeira", "ceramica", "cerâmica"],
  madeira: ["polipropileno", "plastico", "plástico", "inox", "marmore", "mármore"],
  inox: ["madeira", "polipropileno", "plastico", "plástico", "marmore", "mármore"],
  marmore: ["polipropileno", "plastico", "plástico", "madeira"],
  mármore: ["polipropileno", "plastico", "plástico", "madeira"],
};

function normalizeText(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ");
}

/** Palavras significativas da query (sem stopwords). */
export function significantQueryWords(query) {
  return normalizeText(query)
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * Score de relevância (maior = mais relevante). Não bloqueia candidatos.
 * @param {string} query
 * @param {{ competitor_title?: string | null }} candidate
 */
export function scoreCandidateRelevance(query, candidate) {
  const title = normalizeText(candidate?.competitor_title);
  if (!title) return 0;

  const words = significantQueryWords(query);
  if (!words.length) return 0;

  let score = 0;
  const matched = [];

  for (const w of words) {
    if (!title.includes(w)) continue;
    matched.push(w);
    if (STRONG_TERMS.has(w)) score += 12;
    else if (w.length >= 5) score += 4;
    else score += 2;
  }

  // Bônus: todos os termos principais no título.
  if (words.length >= 2 && matched.length === words.length) score += 10;

  // Bônus extra por termos fortes presentes na busca e no título.
  for (const w of words) {
    if (STRONG_TERMS.has(w) && title.includes(w)) score += 6;
  }

  // Penalização leve por material divergente.
  for (const w of words) {
    const divergent = DIVERGENT_BY_QUERY_MATERIAL[w];
    if (!divergent) continue;
    for (const d of divergent) {
      const dn = normalizeText(d);
      if (title.includes(dn) && !words.some((qw) => title.includes(qw) && STRONG_TERMS.has(qw) && qw === dn)) {
        score -= 7;
      }
    }
  }

  return score;
}

/**
 * Ordena candidatos normalizados por relevância (estável: mantém ordem em empate).
 * @template T
 * @param {string} query
 * @param {T[]} candidates
 * @returns {T[]}
 */
export function sortCandidatesByRelevance(query, candidates) {
  if (!Array.isArray(candidates) || candidates.length <= 1) return candidates || [];
  return [...candidates].sort((a, b) => {
    const sa = scoreCandidateRelevance(query, a);
    const sb = scoreCandidateRelevance(query, b);
    return sb - sa;
  });
}
