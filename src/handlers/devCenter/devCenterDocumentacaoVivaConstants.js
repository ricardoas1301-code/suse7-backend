// ======================================================
// Dev Center — Documentação Viva: catálogos e validação (backend)
// ------------------------------------------------------
// Fonte de verdade da VALIDAÇÃO no backend (S1_1.10.4).
// O frontend NÃO valida regra sensível — quem aceita/rejeita é aqui.
// ======================================================

export const DOC_STATUS_VALUES = Object.freeze([
  "rascunho",
  "em_documentacao",
  "em_revisao",
  "homologado",
  "futuro",
  "arquivado",
]);

export const DOC_MATURITY_VALUES = Object.freeze(["mvp", "beta", "producao", "legado"]);

export const DOC_OWNER_VALUES = Object.freeze(["Rico", "Pedro", "João", "Simão", "Time Suse7"]);

export const DOC_OWNER_DEFAULT = "Time Suse7";

/** Status considerado "homologado" (gatilho de reabertura de governança). */
export const DOC_STATUS_HOMOLOGADO = "homologado";

/** Status para o qual um domínio homologado é reaberto ao sofrer alteração. */
export const DOC_STATUS_EM_REVISAO = "em_revisao";

/**
 * Tipos de operação registrados na trilha histórica (S1_1.11A).
 * Espelha o catálogo do frontend (documentacaoVivaHistory.js).
 */
export const DOC_OPERACAO = Object.freeze({
  DOMAIN_CREATED: "domain_created",
  DOMAIN_UPDATED: "domain_updated",
  OWNER_CHANGED: "owner_changed",
  STATUS_CHANGED: "status_changed",
  HOMOLOGATED: "homologated",
  GOVERNANCE_REOPENED: "governance_reopened",
  SECTION_UPDATED: "section_updated",
  ITEM_UPDATED: "item_updated",
});

/**
 * Estrutura operacional padrão (S1_1.9C) — espelha o frontend.
 * Cada seção nasce com seus "campos mínimos" como itens (a preencher, rascunho).
 */
export const DOC_SECOES_OFICIAIS = Object.freeze([
  {
    section_key: "escopo_dominio",
    title: "Escopo do Domínio",
    hint: "O que esta página/domínio representa dentro do Suse7.",
    campos: [
      "Escopo",
      "Objetivo operacional",
      "Responsabilidade do domínio",
      "Limites do domínio",
      "O que este domínio NÃO cobre",
    ],
  },
  {
    section_key: "fonte_da_verdade",
    title: "Fonte da Verdade",
    hint: "Qual fonte manda em cada informação (marketplace = sync, Suse7 = memória).",
    campos: [
      "Fonte primária",
      "Fontes auxiliares",
      "Dados live",
      "Dados snapshot",
      "Observações sobre origem dos dados",
    ],
  },
  {
    section_key: "estrutura_dados",
    title: "Estrutura de Dados",
    hint: "Tabelas, endpoints, APIs e campos que sustentam o domínio.",
    campos: [
      "Tabelas relacionadas",
      "APIs relacionadas",
      "Campos persistidos",
      "Campos derivados",
      "Dependências técnicas",
    ],
  },
  {
    section_key: "regras_operacionais",
    title: "Regras Operacionais",
    hint: "Regras de negócio. Cálculo financeiro sensível só no backend, com precisão decimal.",
    campos: [
      "Regras financeiras",
      "Regras de cálculo",
      "Regras de lucro",
      "Regras de margem",
      "Regras de ranking",
      "Regras de filtros",
      "Regras de sincronização",
      "Regras de consistência",
    ],
  },
  {
    section_key: "agrupamentos_operacionais",
    title: "Agrupamentos Operacionais",
    hint: "Chaves de agrupamento — preparado para multi-CNPJ / multi-conta / multi-marketplace.",
    campos: [
      "SKU",
      "Anúncio/Listing",
      "Pedido",
      "Conta marketplace",
      "Empresa/CNPJ",
      "Marketplace",
      "Cliente",
      "Produto",
    ],
  },
  {
    section_key: "decisoes_arquiteturais",
    title: "Decisões Arquiteturais",
    hint: "Memória técnica e operacional do domínio.",
    campos: [
      "Decisões tomadas",
      "Motivo da decisão",
      "Impacto técnico",
      "Impacto operacional",
      "Riscos conhecidos",
      "Pontos futuros",
    ],
  },
]);

/** Valida e normaliza status (default rascunho). */
export function normalizarDocStatus(valor) {
  const v = valor != null ? String(valor).trim().toLowerCase() : "";
  return DOC_STATUS_VALUES.includes(v) ? v : "rascunho";
}

/** Valida e normaliza maturidade (default mvp). */
export function normalizarDocMaturity(valor) {
  const v = valor != null ? String(valor).trim().toLowerCase() : "";
  return DOC_MATURITY_VALUES.includes(v) ? v : "mvp";
}

/** Valida e normaliza owner (default Time Suse7). */
export function normalizarDocOwner(valor) {
  const v = valor != null ? String(valor).trim() : "";
  return DOC_OWNER_VALUES.includes(v) ? v : DOC_OWNER_DEFAULT;
}

/** Aceita YYYY-MM-DD ou vazio → null. */
export function normalizarDataRevisao(valor) {
  const v = valor != null ? String(valor).trim() : "";
  if (!v) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/** Slug estável a partir de um nome (espelha o frontend). */
export function slugificarDoc(nome) {
  return String(nome || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
