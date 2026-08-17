// =============================================================================
// S7 — Contrato Global de Comunicação (Fase S5.1)
// Communication Event Model — envelope oficial + builder.
//
// O envelope é a ESTRUTURA ÚNICA que todo módulo do Suse7 (Billing, Vendas,
// Produtos, Marketplace Sync, Dev Center, etc.) usa para publicar comunicação.
// Não contém regra de negócio, template ou marketplace hardcoded.
//
// Estrutura padrão (conforme contrato S5.1):
//   - id*            → identificador único do evento (atribuído na persistência)
//   - contract_version → versão do contrato
//   - origin         → source_module + source_event (origem)
//   - category/type  → categoria e tipo (validados contra o catálogo)
//   - priority       → prioridade de comunicação
//   - severity       → sinal de negócio
//   - timestamp      → emitted_at
//   - payload        → dados de negócio
//   - metadata       → metadata padronizada extensível
//   - tenant         → seller_id / marketplace / marketplace_account_id / seller_company_id
//   - idempotency_key / dedupe_key / dedupe_window_seconds → proteções
//
// (*) `id` é atribuído no insert (gen_random_uuid). O builder não inventa id.
// =============================================================================

import {
  S7_COMMUNICATION_CONTRACT_VERSION,
  normalizeDedupeWindowSeconds,
  resolveDefaultPriority,
} from "../constants/communicationContract.js";
import { lookupNotificationTypeCatalog } from "../constants/eventTypes.js";
import {
  buildStandardCommunicationMetadata,
  mergeCommunicationMetadata,
} from "./communicationMetadata.js";

/** @param {unknown} v */
function asTrimmedStringOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * Constrói o envelope canônico do Communication Event Model a partir da entrada
 * do publisher. Função pura (timestamp pode ser fixado via input.emittedAt).
 *
 * @param {{
 *   category: string;
 *   type: string;
 *   seller_id: string;
 *   payload?: Record<string, unknown>;
 *   severity?: string | null;
 *   priority?: string | null;
 *   correlation_id?: string | null;
 *   idempotency_key?: string | null;
 *   dedupe_key?: string | null;
 *   dedupe_window_seconds?: number | null;
 *   contract_version?: number | null;
 *   marketplace?: string | null;
 *   marketplace_account_id?: string | null;
 *   seller_company_id?: string | null;
 *   entity_type?: string | null;
 *   entity_id?: string | null;
 *   source_module?: string | null;
 *   source_event?: string | null;
 *   metadata?: Record<string, unknown> | null;
 *   emitted_at?: string | null;
 * }} input
 * @returns {{
 *   contract_version: number;
 *   category: string;
 *   type: string;
 *   seller_id: string;
 *   severity: string;
 *   priority: string;
 *   payload: Record<string, unknown>;
 *   correlation_id: string | null;
 *   idempotency_key: string;
 *   dedupe_key: string | null;
 *   dedupe_window_seconds: number;
 *   marketplace: string | null;
 *   marketplace_account_id: string | null;
 *   seller_company_id: string | null;
 *   entity_type: string | null;
 *   entity_id: string | null;
 *   source_module: string | null;
 *   source_event: string | null;
 *   metadata: Record<string, unknown>;
 *   emitted_at: string;
 * }}
 */
export function buildCommunicationEventEnvelope(input) {
  const sellerId = asTrimmedStringOrNull(input.seller_id) ?? "";
  const category = String(input.category ?? "").trim();
  const type = String(input.type ?? "").trim();
  const catalog = lookupNotificationTypeCatalog(category, type);

  const contractVersion = Number.isInteger(input.contract_version)
    ? /** @type {number} */ (input.contract_version)
    : S7_COMMUNICATION_CONTRACT_VERSION;

  const correlationId = asTrimmedStringOrNull(input.correlation_id);

  const severity =
    asTrimmedStringOrNull(input.severity) ?? catalog?.severity ?? "info";

  const priority =
    asTrimmedStringOrNull(input.priority) ?? resolveDefaultPriority(severity);

  const idempotencyKey =
    asTrimmedStringOrNull(input.idempotency_key) ??
    `s7:${category}:${type}:${correlationId ?? sellerId}:${input.emitted_at ?? Date.now()}`;

  const dedupeKey = asTrimmedStringOrNull(input.dedupe_key);
  const dedupeWindowSeconds = normalizeDedupeWindowSeconds(
    input.dedupe_window_seconds,
    dedupeKey != null
  );

  const emittedAt = asTrimmedStringOrNull(input.emitted_at) ?? new Date().toISOString();

  const marketplace = asTrimmedStringOrNull(input.marketplace);
  const marketplaceAccountId = asTrimmedStringOrNull(input.marketplace_account_id);
  const sellerCompanyId = asTrimmedStringOrNull(input.seller_company_id);
  const entityType = asTrimmedStringOrNull(input.entity_type);
  const entityId = asTrimmedStringOrNull(input.entity_id);
  const sourceModule = asTrimmedStringOrNull(input.source_module);
  const sourceEvent = asTrimmedStringOrNull(input.source_event);

  const standardMetadata = buildStandardCommunicationMetadata({
    contractVersion,
    priority,
    severity,
    sourceModule,
    sourceEvent,
    correlationId,
    idempotencyKey,
    dedupeKey,
    sellerId: sellerId || null,
    marketplace,
    marketplaceAccountId,
    sellerCompanyId,
    entityType,
    entityId,
    emittedAt,
  });

  const metadata = mergeCommunicationMetadata(input.metadata, standardMetadata);

  return {
    contract_version: contractVersion,
    category,
    type,
    seller_id: sellerId,
    severity,
    priority,
    payload:
      input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
        ? input.payload
        : {},
    correlation_id: correlationId,
    idempotency_key: idempotencyKey,
    dedupe_key: dedupeKey,
    dedupe_window_seconds: dedupeWindowSeconds,
    marketplace,
    marketplace_account_id: marketplaceAccountId,
    seller_company_id: sellerCompanyId,
    entity_type: entityType,
    entity_id: entityId,
    source_module: sourceModule,
    source_event: sourceEvent,
    metadata,
    emitted_at: emittedAt,
  };
}
