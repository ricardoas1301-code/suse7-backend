// =============================================================================
// S7 — Fale Conosco no Motor Central (Fase S5.13)
// =============================================================================

import { getOfficialEmailChannelSnapshot } from "../email/emailChannelOfficial.js";
import { describeCommunicationDispatcherPipeline } from "../preferences/communicationDispatcherBridge.js";
import {
  S7_COMMUNICATION_CONTRACT_VERSION,
  isSupportedContractVersion,
} from "../contract/index.js";
import {
  S7_FALE_CONOSCO_FLOW,
  S7_FALE_CONOSCO_LEGACY_EDGE_PATH,
  S7_FALE_CONOSCO_MOTOR_PHASE,
  S7_FALE_CONOSCO_PIPELINE_STAGES,
  S7_FALE_CONOSCO_PUBLIC_API_PATH,
} from "./faleConoscoMotorContract.js";
import {
  resolveFaleConoscoInboxEmail,
  resolveFaleConoscoSystemSellerId,
} from "./triggerFaleConoscoContact.js";

export function describeFaleConoscoMotorRedundancyCandidates() {
  return [
    {
      id: "supabase_edge_send-contact-email",
      note: "Edge Function legada no projeto Supabase bazibzquasbdgjwdcwbz — frontend deixou de chamar após S5.13.",
      action: "descontinuar após homologação; manter como fallback documentado",
    },
    {
      id: "ContactModal.hardcoded_supabase_url",
      note: "URL fixa da Edge removida; usa postFaleConoscoContact → backend.",
      action: "removido nesta fase",
    },
    {
      id: "patchFaleConoscoEmailOutbox",
      note: "Ajuste pós-enqueue do HTML homologado; evita divergência do wrapper CTA operacional.",
      action: "manter até template DB alinhar 100% ao renderer",
    },
  ];
}

export function getOfficialFaleConoscoMotorSnapshot() {
  const email = getOfficialEmailChannelSnapshot();

  return {
    phase: S7_FALE_CONOSCO_MOTOR_PHASE,
    motor_central_single_source: true,
    parallel_motor: false,
    user_ux_unchanged: true,
    public_api_path: S7_FALE_CONOSCO_PUBLIC_API_PATH,
    legacy_edge_path: S7_FALE_CONOSCO_LEGACY_EDGE_PATH,
    flow: S7_FALE_CONOSCO_FLOW,
    contract: {
      version: S7_COMMUNICATION_CONTRACT_VERSION,
      supported: isSupportedContractVersion(S7_COMMUNICATION_CONTRACT_VERSION),
      publish: "publishNotificationEvent (2 eventos: equipe + confirmação)",
    },
    dispatcher: describeCommunicationDispatcherPipeline(),
    pipeline_stages: [...S7_FALE_CONOSCO_PIPELINE_STAGES],
    pipeline_sequence:
      "ContactModal → POST /api/public/fale-conosco/contact → publishNotificationEvent → runCentralDispatcher → EmailNotificationProvider → outbox → processEmailOutbox → Resend",
    runtime: {
      system_seller_id: resolveFaleConoscoSystemSellerId(),
      inbox_email: resolveFaleConoscoInboxEmail(),
      email_provider: email.provider,
      email_mode: email.mode,
    },
    templates: {
      team: S7_FALE_CONOSCO_FLOW.TEMPLATE_TEAM,
      confirmation: S7_FALE_CONOSCO_FLOW.TEMPLATE_CONFIRMATION,
      central: "s7_notification_templates (S5.4)",
    },
    preserved_capabilities: {
      form_fields: ["name", "email", "subject", "message"],
      api_response: { success: true },
      error_incomplete: "Campos incompletos.",
      confirmation_email: true,
      team_notification_email: true,
      premium_email_shell: true,
    },
    observability: {
      legacy_prefix: "[S7_ACTIONS]_FALE_CONOSCO_*",
      formal_prefix: "[S7_MOTOR_OBS]_FALE_CONOSCO_PIPELINE",
      integrated_phase: "S5.10",
    },
    redundancy_candidates: describeFaleConoscoMotorRedundancyCandidates(),
  };
}

export function evaluateOfficialFaleConoscoMotorIntegration() {
  const snap = getOfficialFaleConoscoMotorSnapshot();
  return {
    ok:
      snap.motor_central_single_source === true &&
      snap.parallel_motor === false &&
      snap.pipeline_stages.includes("central_dispatcher") &&
      snap.templates.team === "system.fale_conosco.team",
    snapshot: snap,
  };
}
