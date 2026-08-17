// =============================================================================
// S7 — Contrato Global de Comunicação (Fase S5.1)
// Superfície pública do Communication Event Model.
// =============================================================================

export {
  S7_COMMUNICATION_CONTRACT_VERSION,
  S7_COMMUNICATION_SUPPORTED_CONTRACT_VERSIONS,
  S7_COMMUNICATION_PRIORITY,
  S7_COMMUNICATION_DEDUPE,
  isSupportedContractVersion,
  isValidCommunicationPriority,
  resolveDefaultPriority,
  normalizeDedupeWindowSeconds,
} from "../constants/communicationContract.js";

export {
  buildStandardCommunicationMetadata,
  mergeCommunicationMetadata,
  S7_COMMUNICATION_METADATA_RESERVED_KEYS,
} from "./communicationMetadata.js";

export { buildCommunicationEventEnvelope } from "./communicationEventEnvelope.js";
export { validateCommunicationEvent } from "./validateCommunicationEvent.js";
