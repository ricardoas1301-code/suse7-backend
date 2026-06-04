// =============================================================================
// S7 — Fale Conosco no Motor Central (Fase S5.13)
// =============================================================================

export const S7_FALE_CONOSCO_MOTOR_PHASE = "S5.13";

export const S7_FALE_CONOSCO_PUBLIC_API_PATH = "/api/public/fale-conosco/contact";

/** Compatível com Edge Function legada send-contact-email */
export const S7_FALE_CONOSCO_LEGACY_EDGE_PATH = "/functions/v1/send-contact-email";

export const S7_FALE_CONOSCO_FLOW = Object.freeze({
  FLOW: "fale_conosco_contact",
  SOURCE_MODULE: "fale_conosco_modal",
  CATEGORY: "SYSTEM",
  TYPE_TEAM: "FALE_CONOSCO_TEAM",
  TYPE_CONFIRMATION: "FALE_CONOSCO_CONFIRMATION",
  TEMPLATE_TEAM: "system.fale_conosco.team",
  TEMPLATE_CONFIRMATION: "system.fale_conosco.confirmation",
  FRONTEND_COMPONENT: "ContactModal",
  FRONTEND_API_CLIENT: "postFaleConoscoContact",
});

export const S7_FALE_CONOSCO_PIPELINE_STAGES = Object.freeze([
  "contact_modal",
  "public_api_post",
  "communication_contract_publish",
  "central_dispatcher",
  "actions_engine",
  "email_channel_outbox",
  "email_provider",
  "recipient",
]);
