// =============================================================================
// S7 — Fale Conosco no Motor Central
// =============================================================================

export {
  S7_FALE_CONOSCO_CONTACT_FIELDS,
  normalizeFaleConoscoContactBody,
} from "./faleConoscoContactContract.js";

export {
  S7_FALE_CONOSCO_MOTOR_PHASE,
  S7_FALE_CONOSCO_PUBLIC_API_PATH,
  S7_FALE_CONOSCO_LEGACY_EDGE_PATH,
  S7_FALE_CONOSCO_FLOW,
  S7_FALE_CONOSCO_PIPELINE_STAGES,
} from "./faleConoscoMotorContract.js";

export {
  getOfficialFaleConoscoMotorSnapshot,
  evaluateOfficialFaleConoscoMotorIntegration,
  describeFaleConoscoMotorRedundancyCandidates,
} from "./faleConoscoMotorOfficial.js";

export {
  buildFaleConoscoMotorTimeline,
  recordFaleConoscoMotorObservability,
} from "./faleConoscoMotorObservability.js";

export {
  validateFaleConoscoContactInput,
  triggerFaleConoscoContact,
  resolveFaleConoscoSystemSellerId,
  resolveFaleConoscoInboxEmail,
} from "./triggerFaleConoscoContact.js";

export {
  getFaleConoscoEmailRuntimeSnapshot,
  canSendFaleConoscoEmailLive,
  isFaleConoscoDeliveryConfirmed,
  evaluateFaleConoscoLegOutcome,
} from "./faleConoscoEmailLiveDelivery.js";

export {
  renderFaleConoscoTeamEmail,
  renderFaleConoscoConfirmationEmail,
} from "./faleConoscoEmailLegacyRenderer.js";
