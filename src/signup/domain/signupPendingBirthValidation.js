// =============================================================================
// Validação de payload — signup pending birth (pré-auth)
// =============================================================================

import { createHash } from "node:crypto";
import { isValidCnpjInput, normalizeCnpjDigits } from "../../domain/taxIdBr/cnpjDigits.js";
import { validarMetadadosDocumentoLegal } from "../../legal/domain/documentosLegaisCanonicos.js";

const MAX_FIELD_LEN = 256;
const MAX_PAYLOAD_BYTES = 16_384;
const PENDING_TTL_HOURS = 72;

export const SIGNUP_PENDING_STATUSES = {
  PENDING: "PENDING",
  BOUND_WAITING_CONFIRMATION: "BOUND_WAITING_CONFIRMATION",
  COMPLETED: "COMPLETED",
  EXPIRED: "EXPIRED",
  ABORTED: "ABORTED",
  FAILED: "FAILED",
};

export function normalizeSignupEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function maskSignupEmail(email) {
  const norm = normalizeSignupEmail(email);
  const [local, domain] = norm.split("@");
  if (!domain) return "***";
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}***@${domain}`;
}

export function hashCorrelationToken(token) {
  return createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

export function generateCorrelationToken() {
  return createHash("sha256")
    .update(`${Date.now()}-${Math.random()}-${process.hrtime.bigint()}`)
    .digest("hex");
}

export function computePendingExpiresAt(fromDate = new Date()) {
  return new Date(fromDate.getTime() + PENDING_TTL_HOURS * 60 * 60 * 1000);
}

function trimField(value, max = MAX_FIELD_LEN) {
  if (value == null) return "";
  return String(value).trim().slice(0, max);
}

function onlyDigits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

/**
 * @param {unknown} body
 */
export function validatePendingBirthPayload(body) {
  if (!body || typeof body !== "object") {
    return { ok: false, code: "INVALID_PAYLOAD", message: "Payload inválido." };
  }

  const rawJson = JSON.stringify(body);
  if (Buffer.byteLength(rawJson, "utf8") > MAX_PAYLOAD_BYTES) {
    return { ok: false, code: "PAYLOAD_TOO_LARGE", message: "Payload excede o tamanho permitido." };
  }

  const email = normalizeSignupEmail(body.email);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, code: "INVALID_EMAIL", message: "E-mail inválido." };
  }

  const nome = trimField(body.nome);
  const nomeLoja = trimField(body.nome_loja);
  if (!nome) return { ok: false, code: "INVALID_NOME", message: "Nome é obrigatório." };
  if (!nomeLoja) return { ok: false, code: "INVALID_NOME_LOJA", message: "Nome fantasia é obrigatório." };

  const whatsapp = onlyDigits(body.whatsapp);
  if (!whatsapp) return { ok: false, code: "INVALID_WHATSAPP", message: "WhatsApp é obrigatório." };

  const cpfCnpj = onlyDigits(body.cpf_cnpj);
  if (!cpfCnpj) return { ok: false, code: "INVALID_CPF_CNPJ", message: "CPF/CNPJ é obrigatório." };
  if (cpfCnpj.length === 14 && !isValidCnpjInput(cpfCnpj)) {
    return { ok: false, code: "INVALID_CNPJ", message: "CNPJ inválido." };
  }
  if (cpfCnpj.length !== 11 && cpfCnpj.length !== 14) {
    return { ok: false, code: "INVALID_CPF_CNPJ", message: "CPF ou CNPJ inválido." };
  }

  const terms = body.terms && typeof body.terms === "object" ? body.terms : null;
  if (!terms) {
    return { ok: false, code: "TERMS_REQUIRED", message: "Aceite dos Termos é obrigatório." };
  }

  const documentType = trimField(terms.document_type);
  const documentVersion = trimField(terms.document_version);
  const documentHash = trimField(terms.document_hash).toLowerCase();
  const source = trimField(terms.source || "SIGNUP");
  const scrolledToEnd = terms.scrolled_to_end === true;
  const clientAcceptedAtRaw = terms.accepted_at;

  if (!scrolledToEnd) {
    return { ok: false, code: "SCROLL_REQUIRED", message: "Aceite exige leitura até o final." };
  }

  const legalValidation = validarMetadadosDocumentoLegal(documentType, documentVersion, documentHash);
  if (!legalValidation.ok) {
    return { ok: false, code: legalValidation.code, message: legalValidation.message };
  }

  const clientAcceptedAt = clientAcceptedAtRaw ? new Date(clientAcceptedAtRaw) : null;
  if (!clientAcceptedAt || Number.isNaN(clientAcceptedAt.getTime())) {
    return { ok: false, code: "INVALID_ACCEPTED_AT", message: "Data de aceite inválida." };
  }

  /** @type {Record<string, unknown>} */
  const profilePayload = {
    nome,
    nome_loja: nomeLoja,
    whatsapp,
    cpf_cnpj: cpfCnpj,
    photo_url: "",
  };

  const telefone = onlyDigits(body.telefone);
  if (telefone) profilePayload.telefone = telefone;

  const impostoRaw = String(body.imposto_percentual ?? "").replace("%", "").trim();
  if (impostoRaw !== "") profilePayload.imposto_percentual = impostoRaw;

  for (const [k, v] of [
    ["cep", onlyDigits(body.cep)],
    ["endereco", trimField(body.endereco)],
    ["numero", onlyDigits(body.numero)],
    ["complemento", trimField(body.complemento)],
    ["bairro", trimField(body.bairro)],
    ["cidade", trimField(body.cidade)],
    ["estado", trimField(body.estado)],
  ]) {
    if (v) profilePayload[k] = v;
  }

  return {
    ok: true,
    normalizedEmail: email,
    profilePayload,
    legalEvidence: {
      document_type: documentType,
      document_version: documentVersion,
      document_hash: documentHash,
      source,
      scrolled_to_end: true,
      client_accepted_at: clientAcceptedAt.toISOString(),
    },
  };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} email
 */
export async function authEmailAlreadyRegistered(supabase, email) {
  const norm = normalizeSignupEmail(email);
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) return { ok: false, error };
  const users = data?.users ?? [];
  const hit = users.find((u) => normalizeSignupEmail(u.email) === norm);
  return { ok: true, exists: Boolean(hit) };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} cnpjDigits
 */
export async function cnpjAlreadyRegistered(supabase, cnpjDigits) {
  const doc = normalizeCnpjDigits(cnpjDigits);
  if (doc.length !== 14) return { ok: true, exists: false };
  const { data, error } = await supabase
    .from("seller_companies")
    .select("id")
    .eq("document_cnpj", doc)
    .limit(1)
    .maybeSingle();
  if (error) return { ok: false, error };
  return { ok: true, exists: Boolean(data?.id) };
}
