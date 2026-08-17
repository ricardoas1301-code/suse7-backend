// ======================================================
// Dev Center — Documentação Viva: service de persistência (backend)
// ------------------------------------------------------
// Toda persistência/validação da Documentação Viva acontece aqui,
// usando o cliente Supabase service-role recebido por parâmetro.
//
// Escopo EXCLUSIVO: tabelas devcenter_doc_*. Não toca outros domínios.
// Histórico de versões e auditoria NÃO são implementados nesta fase.
// ======================================================

import {
  DOC_SECOES_OFICIAIS,
  DOC_OPERACAO,
  DOC_STATUS_HOMOLOGADO,
  DOC_STATUS_EM_REVISAO,
  normalizarDocStatus,
  normalizarDocMaturity,
  normalizarDocOwner,
  normalizarDataRevisao,
  slugificarDoc,
} from "./devCenterDocumentacaoVivaConstants.js";
import { registrarHistoricoDoc } from "./devCenterDocHistoryService.js";

const TABELA_DOMINIOS = "devcenter_doc_domains";
const TABELA_SECOES = "devcenter_doc_sections";
const TABELA_ITENS = "devcenter_doc_items";

/** Operador padrão quando o contexto não traz usuário. */
const OPERADOR_PADRAO = { id: null, name: "Sistema" };

/** Extrai operador seguro do usuário autenticado (preparado para multi-admin). */
function resolverOperador(operador) {
  if (!operador) return OPERADOR_PADRAO;
  const name = operador.name != null && String(operador.name).trim() ? String(operador.name).trim() : "Sistema";
  return { id: operador.id ?? null, name };
}

/** Erro de tabela inexistente (ambiente sem a migration aplicada). */
function tabelaAusente(error) {
  if (!error) return false;
  return (
    String(error.code ?? "") === "42P01" ||
    String(error.message ?? "").toLowerCase().includes("does not exist")
  );
}

/** Data ISO curta (YYYY-MM-DD) a partir de timestamptz. */
function dataCurta(valor) {
  if (!valor) return "";
  return String(valor).slice(0, 10);
}

// ------------------------------------------------------
// Mapeadores DB → formato do frontend (S1_1.10.7)
// Os componentes não precisam ser reescritos: mantemos o
// mesmo shape (domain_*/section_*/item_*) + db ids extras.
// ------------------------------------------------------

function mapItem(row) {
  return {
    item_db_id: row.id,
    item_title: row.title ?? "",
    item_content: row.content ?? "",
    item_notes: row.notes ?? "",
    item_status: row.status ?? "rascunho",
    updated_at: dataCurta(row.updated_at),
  };
}

function mapSection(row, itens) {
  return {
    section_db_id: row.id,
    section_id: row.section_key,
    section_title: row.title,
    section_hint: row.hint ?? "",
    items: itens,
  };
}

function mapDomain(row, secoes) {
  return {
    domain_db_id: row.id,
    domain_id: row.id,
    domain_name: row.name,
    domain_slug: row.slug,
    status: row.status,
    description: row.description ?? "",
    owner: row.owner,
    maturity: row.maturity,
    next_review_at: dataCurta(row.next_review_at),
    homologated_at: row.homologated_at ?? "",
    homologated_by: row.homologated_by ?? "",
    last_operator: row.last_operator ?? "",
    updated_at: dataCurta(row.updated_at),
    sections: secoes,
  };
}

/**
 * Monta a árvore completa da Documentação Viva no formato do frontend.
 * @returns {Promise<{ ok: true; domains: object[]; degraded?: boolean }>}
 */
export async function buildDocumentacaoVivaTree(supabase) {
  const { data: domainsRows, error: domErr } = await supabase
    .from(TABELA_DOMINIOS)
    .select("*")
    .is("deleted_at", null)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  if (domErr) {
    if (tabelaAusente(domErr)) return { ok: true, domains: [], degraded: true };
    throw domErr;
  }

  const domains = domainsRows ?? [];
  if (domains.length === 0) return { ok: true, domains: [] };

  const domainIds = domains.map((d) => d.id);

  const { data: sectionRows, error: secErr } = await supabase
    .from(TABELA_SECOES)
    .select("*")
    .in("domain_id", domainIds)
    .order("sort_order", { ascending: true });
  if (secErr) {
    if (tabelaAusente(secErr)) return { ok: true, domains: [], degraded: true };
    throw secErr;
  }
  const sections = sectionRows ?? [];

  const sectionIds = sections.map((s) => s.id);
  let items = [];
  if (sectionIds.length > 0) {
    const { data: itemRows, error: itemErr } = await supabase
      .from(TABELA_ITENS)
      .select("*")
      .in("section_id", sectionIds)
      .order("sort_order", { ascending: true });
    if (itemErr) {
      if (tabelaAusente(itemErr)) return { ok: true, domains: [], degraded: true };
      throw itemErr;
    }
    items = itemRows ?? [];
  }

  const itensPorSecao = new Map();
  for (const item of items) {
    if (!itensPorSecao.has(item.section_id)) itensPorSecao.set(item.section_id, []);
    itensPorSecao.get(item.section_id).push(mapItem(item));
  }

  const secoesPorDominio = new Map();
  for (const sec of sections) {
    if (!secoesPorDominio.has(sec.domain_id)) secoesPorDominio.set(sec.domain_id, []);
    secoesPorDominio.get(sec.domain_id).push(mapSection(sec, itensPorSecao.get(sec.id) ?? []));
  }

  return {
    ok: true,
    domains: domains.map((dom) => mapDomain(dom, secoesPorDominio.get(dom.id) ?? [])),
  };
}

/**
 * Cria um domínio (sempre em rascunho) + seções oficiais vazias.
 * @returns {Promise<{ ok: boolean; domain?: object; error?: { code: string; message: string } }>}
 */
export async function criarDominioDocumentacao(supabase, body, operadorRaw) {
  const operador = resolverOperador(operadorRaw);
  const name = body?.domain_name != null ? String(body.domain_name).trim() : "";
  if (!name) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "domain_name é obrigatório" } };
  }

  const slug =
    (body?.domain_slug ? slugificarDoc(body.domain_slug) : slugificarDoc(name)) ||
    `dominio-${Date.now()}`;

  const row = {
    slug,
    name,
    description: body?.description != null ? String(body.description).trim() : "",
    status: "rascunho", // nenhum domínio nasce homologado
    owner: normalizarDocOwner(body?.owner),
    maturity: normalizarDocMaturity(body?.maturity),
    next_review_at: normalizarDataRevisao(body?.next_review_at),
    last_operator: operador.name,
  };

  const { data: domain, error } = await supabase
    .from(TABELA_DOMINIOS)
    .insert(row)
    .select("*")
    .single();

  if (error || !domain) {
    if (String(error?.code ?? "") === "23505") {
      return { ok: false, error: { code: "SLUG_CONFLICT", message: "Já existe domínio com esse slug" } };
    }
    return { ok: false, error: { code: "DB_ERROR", message: "Erro ao criar domínio" } };
  }

  // Estrutura operacional padrão (S1_1.9C) — ordem fixa.
  const secoesRows = DOC_SECOES_OFICIAIS.map((sec, idx) => ({
    domain_id: domain.id,
    section_key: sec.section_key,
    title: sec.title,
    hint: sec.hint ?? "",
    sort_order: idx,
  }));
  const { data: secoesCriadas, error: secErr } = await supabase
    .from(TABELA_SECOES)
    .insert(secoesRows)
    .select("*");
  if (secErr) {
    return { ok: false, error: { code: "DB_ERROR", message: "Erro ao criar seções do domínio" } };
  }

  // Campos mínimos de cada seção nascem como itens (a preencher, rascunho).
  const secoesPorKey = new Map((secoesCriadas ?? []).map((s) => [s.section_key, s]));
  const itensRows = [];
  for (const sec of DOC_SECOES_OFICIAIS) {
    const secaoCriada = secoesPorKey.get(sec.section_key);
    if (!secaoCriada) continue;
    (sec.campos ?? []).forEach((campo, idx) => {
      itensRows.push({
        section_id: secaoCriada.id,
        title: campo,
        content: "",
        notes: "",
        status: "rascunho",
        sort_order: idx,
      });
    });
  }
  if (itensRows.length > 0) {
    const { error: itemErr } = await supabase.from(TABELA_ITENS).insert(itensRows);
    if (itemErr) {
      return { ok: false, error: { code: "DB_ERROR", message: "Erro ao criar campos do domínio" } };
    }
  }

  await registrarHistoricoDoc(supabase, {
    domainId: domain.id,
    operationType: DOC_OPERACAO.DOMAIN_CREATED,
    label: `Domínio criado: ${name}`,
    after: { name, slug, status: domain.status },
    operador,
  });

  const arvore = await buildDocumentacaoVivaTree(supabase);
  const criado = arvore.domains.find((d) => d.domain_db_id === domain.id);
  return { ok: true, domain: criado ?? mapDomain(domain, []) };
}

/**
 * Atualiza campos de um domínio (nome, descrição, status, owner, maturidade, revisão).
 *
 * Governança (S1_1.11A):
 *  - Ao homologar (status → homologado): registra quem/quando homologou.
 *  - Domínio homologado que sofre alteração de conteúdo (sem o operador
 *    mudar o status explicitamente) é reaberto automaticamente para "Em revisão".
 *  - Toda alteração é registrada na trilha histórica (before/after).
 */
export async function atualizarDominioDocumentacao(supabase, domainId, body, operadorRaw) {
  const operador = resolverOperador(operadorRaw);

  const { data: atual, error: errAtual } = await supabase
    .from(TABELA_DOMINIOS)
    .select("id, name, description, status, owner, maturity, next_review_at, homologated_at, homologated_by")
    .eq("id", domainId)
    .is("deleted_at", null)
    .maybeSingle();
  if (errAtual) return { ok: false, error: { code: "DB_ERROR", message: "Erro ao carregar domínio" } };
  if (!atual) return { ok: false, error: { code: "NOT_FOUND", message: "Domínio não encontrado" } };

  const patch = {};
  if (body?.domain_name != null) patch.name = String(body.domain_name).trim();
  if (body?.description != null) patch.description = String(body.description).trim();
  if (body?.status != null) patch.status = normalizarDocStatus(body.status);
  if (body?.owner != null) patch.owner = normalizarDocOwner(body.owner);
  if (body?.maturity != null) patch.maturity = normalizarDocMaturity(body.maturity);
  if (body?.next_review_at !== undefined) patch.next_review_at = normalizarDataRevisao(body.next_review_at);

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "Nenhum campo válido para atualizar" } };
  }

  patch.last_operator = operador.name;

  const statusSolicitado = patch.status != null;
  const statusMudou = statusSolicitado && patch.status !== atual.status;
  const conteudoMudou = ["name", "description", "owner", "maturity", "next_review_at"].some(
    (campo) => patch[campo] !== undefined && patch[campo] !== atual[campo],
  );

  // Reabertura automática (S1_1.11A.10): homologado + alteração de conteúdo
  // sem troca explícita de status → volta para Em revisão.
  let reaberto = false;
  if (atual.status === DOC_STATUS_HOMOLOGADO && !statusMudou && conteudoMudou) {
    patch.status = DOC_STATUS_EM_REVISAO;
    reaberto = true;
  }

  // Homologação (S1_1.11A.8): registra quem/quando homologou.
  const homologouAgora = patch.status === DOC_STATUS_HOMOLOGADO && atual.status !== DOC_STATUS_HOMOLOGADO;
  if (homologouAgora) {
    patch.homologated_at = new Date().toISOString();
    patch.homologated_by = operador.name;
  }

  const { data, error } = await supabase
    .from(TABELA_DOMINIOS)
    .update(patch)
    .eq("id", domainId)
    .is("deleted_at", null)
    .select("id, status")
    .maybeSingle();

  if (error) return { ok: false, error: { code: "DB_ERROR", message: "Erro ao atualizar domínio" } };
  if (!data) return { ok: false, error: { code: "NOT_FOUND", message: "Domínio não encontrado" } };

  // Trilha histórica (before/after).
  if (patch.owner !== undefined && patch.owner !== atual.owner) {
    await registrarHistoricoDoc(supabase, {
      domainId,
      operationType: DOC_OPERACAO.OWNER_CHANGED,
      label: `Responsável alterado: ${atual.owner} → ${patch.owner}`,
      before: { owner: atual.owner },
      after: { owner: patch.owner },
      operador,
    });
  }
  if (homologouAgora) {
    await registrarHistoricoDoc(supabase, {
      domainId,
      operationType: DOC_OPERACAO.HOMOLOGATED,
      label: `Domínio homologado por ${operador.name}`,
      before: { status: atual.status },
      after: { status: DOC_STATUS_HOMOLOGADO, homologated_by: operador.name },
      operador,
    });
  } else if (statusMudou) {
    await registrarHistoricoDoc(supabase, {
      domainId,
      operationType: DOC_OPERACAO.STATUS_CHANGED,
      label: `Status alterado: ${atual.status} → ${patch.status}`,
      before: { status: atual.status },
      after: { status: patch.status },
      operador,
    });
  }
  if (reaberto) {
    await registrarHistoricoDoc(supabase, {
      domainId,
      operationType: DOC_OPERACAO.GOVERNANCE_REOPENED,
      label: "Governança reaberta automaticamente (Em revisão)",
      before: { status: atual.status },
      after: { status: DOC_STATUS_EM_REVISAO },
      operador,
    });
  }
  if (conteudoMudou && !reaberto && !statusMudou) {
    await registrarHistoricoDoc(supabase, {
      domainId,
      operationType: DOC_OPERACAO.DOMAIN_UPDATED,
      label: "Domínio atualizado",
      before: { name: atual.name, description: atual.description },
      after: { name: patch.name ?? atual.name, description: patch.description ?? atual.description },
      operador,
    });
  }

  return { ok: true, domain_id: data.id, status: data.status, reaberto };
}

/**
 * Aplica os efeitos de governança de uma alteração de CONTEÚDO (seção/item):
 *  - marca o último operador no domínio;
 *  - se o domínio estava homologado, reabre para "Em revisão" (S1_1.11A.10).
 * @returns {Promise<{ reaberto: boolean }>}
 */
async function aplicarGovernancaConteudo(supabase, domainId, operador) {
  if (!domainId) return { reaberto: false };

  const { data: dom } = await supabase
    .from(TABELA_DOMINIOS)
    .select("id, status")
    .eq("id", domainId)
    .maybeSingle();

  const reaberto = dom?.status === DOC_STATUS_HOMOLOGADO;
  const patch = { last_operator: operador.name, updated_at: new Date().toISOString() };
  if (reaberto) patch.status = DOC_STATUS_EM_REVISAO;

  await supabase.from(TABELA_DOMINIOS).update(patch).eq("id", domainId);

  if (reaberto) {
    await registrarHistoricoDoc(supabase, {
      domainId,
      operationType: DOC_OPERACAO.GOVERNANCE_REOPENED,
      label: "Governança reaberta automaticamente (Em revisão)",
      before: { status: DOC_STATUS_HOMOLOGADO },
      after: { status: DOC_STATUS_EM_REVISAO },
      operador,
    });
  }
  return { reaberto };
}

/**
 * Atualiza metadados de uma seção e, opcionalmente, substitui seus itens.
 * Substituição de itens é transacional simples: apaga e reinsere (idempotente).
 */
export async function atualizarSecaoDocumentacao(supabase, sectionId, body, operadorRaw) {
  const operador = resolverOperador(operadorRaw);

  const { data: secAtual } = await supabase
    .from(TABELA_SECOES)
    .select("id, domain_id, title")
    .eq("id", sectionId)
    .maybeSingle();
  if (!secAtual) return { ok: false, error: { code: "NOT_FOUND", message: "Seção não encontrada" } };

  const patch = {};
  if (body?.section_title != null) patch.title = String(body.section_title).trim();
  if (body?.section_hint != null) patch.hint = String(body.section_hint).trim();

  if (Object.keys(patch).length > 0) {
    const { error } = await supabase.from(TABELA_SECOES).update(patch).eq("id", sectionId);
    if (error) return { ok: false, error: { code: "DB_ERROR", message: "Erro ao atualizar seção" } };
  }

  let houveAlteracao = Object.keys(patch).length > 0;

  // Substituição opcional dos itens (editor de seção do frontend).
  if (Array.isArray(body?.items)) {
    // Snapshot anterior (before) — trilha histórica simples.
    const { data: itensAntes } = await supabase
      .from(TABELA_ITENS)
      .select("title, content, notes, status")
      .eq("section_id", sectionId)
      .order("sort_order", { ascending: true });

    const { error: delErr } = await supabase.from(TABELA_ITENS).delete().eq("section_id", sectionId);
    if (delErr) return { ok: false, error: { code: "DB_ERROR", message: "Erro ao limpar itens" } };

    const novos = body.items.map((item, idx) => ({
      section_id: sectionId,
      title: item?.item_title != null ? String(item.item_title) : "",
      content: item?.item_content != null ? String(item.item_content) : "",
      notes: item?.item_notes != null ? String(item.item_notes) : "",
      status: normalizarDocStatus(item?.item_status),
      sort_order: idx,
    }));
    if (novos.length > 0) {
      const { error: insErr } = await supabase.from(TABELA_ITENS).insert(novos);
      if (insErr) return { ok: false, error: { code: "DB_ERROR", message: "Erro ao gravar itens" } };
    }
    houveAlteracao = true;

    await registrarHistoricoDoc(supabase, {
      domainId: secAtual.domain_id,
      sectionId,
      operationType: DOC_OPERACAO.SECTION_UPDATED,
      label: `Seção atualizada: ${secAtual.title}`,
      before: { items: itensAntes ?? [] },
      after: { items: novos.map(({ section_id, sort_order, ...resto }) => resto) },
      operador,
    });
  }

  let reaberto = false;
  if (houveAlteracao && secAtual.domain_id) {
    ({ reaberto } = await aplicarGovernancaConteudo(supabase, secAtual.domain_id, operador));
  }

  return { ok: true, section_id: sectionId, reaberto };
}

/**
 * Atualiza um item individual (título, conteúdo, observações, status).
 * Registra histórico e reabre a governança do domínio se estava homologado.
 */
export async function atualizarItemDocumentacao(supabase, itemId, body, operadorRaw) {
  const operador = resolverOperador(operadorRaw);

  const { data: itemAtual } = await supabase
    .from(TABELA_ITENS)
    .select("id, section_id, title, content, notes, status")
    .eq("id", itemId)
    .maybeSingle();
  if (!itemAtual) return { ok: false, error: { code: "NOT_FOUND", message: "Item não encontrado" } };

  const patch = {};
  if (body?.item_title != null) patch.title = String(body.item_title);
  if (body?.item_content != null) patch.content = String(body.item_content);
  if (body?.item_notes != null) patch.notes = String(body.item_notes);
  if (body?.item_status != null) patch.status = normalizarDocStatus(body.item_status);

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "Nenhum campo válido para atualizar" } };
  }

  const { data, error } = await supabase
    .from(TABELA_ITENS)
    .update(patch)
    .eq("id", itemId)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: { code: "DB_ERROR", message: "Erro ao atualizar item" } };
  if (!data) return { ok: false, error: { code: "NOT_FOUND", message: "Item não encontrado" } };

  // domínio pai (via seção) para histórico e reabertura.
  const { data: sec } = await supabase
    .from(TABELA_SECOES)
    .select("domain_id, title")
    .eq("id", itemAtual.section_id)
    .maybeSingle();

  await registrarHistoricoDoc(supabase, {
    domainId: sec?.domain_id ?? null,
    sectionId: itemAtual.section_id,
    itemId,
    operationType: DOC_OPERACAO.ITEM_UPDATED,
    label: `Item atualizado: ${patch.title ?? itemAtual.title}`,
    before: { title: itemAtual.title, content: itemAtual.content, status: itemAtual.status },
    after: {
      title: patch.title ?? itemAtual.title,
      content: patch.content ?? itemAtual.content,
      status: patch.status ?? itemAtual.status,
    },
    operador,
  });

  let reaberto = false;
  if (sec?.domain_id) {
    ({ reaberto } = await aplicarGovernancaConteudo(supabase, sec.domain_id, operador));
  }

  return { ok: true, item_id: data.id, reaberto };
}
