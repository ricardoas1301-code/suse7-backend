// =============================================================================
// S7 — Canal E-mail Oficial (Fase S5.5)
// Contrato operacional do canal — infraestrutura, sem template de negócio.
//
// O envio real continua em S7EmailProvider + outbox + worker.
// O fluxo "Fale Conosco" permanece SEPARADO (Edge Function Supabase) até migração futura.
// =============================================================================

/** Provider de envio suportado pelo motor central. */
export const S7_EMAIL_OFFICIAL_PROVIDER = Object.freeze({
  MOCK: "mock",
  RESEND: "resend",
  SENDGRID: "sendgrid",
});

/** Modos de operação do canal. */
export const S7_EMAIL_OFFICIAL_MODE = Object.freeze({
  MOCK: "mock",
  SIMULATE: "simulate",
  DEV_SANDBOX: "dev_sandbox",
  SANDBOX: "sandbox",
  LIVE: "live",
  PRODUCTION: "production",
});

/**
 * Domínio oficial de envio (sem credenciais).
 * Usado para documentação de SPF/DKIM/DMARC e validação de remetente.
 */
export const S7_EMAIL_OFFICIAL_SENDING_DOMAIN = "suse7.com.br";

/**
 * Remetente padrão quando S7_EMAIL_FROM não está definido.
 * Deve estar alinhado ao domínio verificado no provider (Resend).
 */
export const S7_EMAIL_OFFICIAL_DEFAULT_FROM = "Suse7 <notificacoes@suse7.com.br>";

/**
 * Registros DNS esperados (referência operacional — não valida DNS em runtime).
 * @type {Readonly<{ spf: string; dkim: string; dmarc: string }>}
 */
export const S7_EMAIL_DELIVERABILITY_DNS_HINTS = Object.freeze({
  spf: `v=spf1 include:_spf.resend.com ~all`,
  dkim: "Configurar DKIM no painel Resend para o domínio suse7.com.br",
  dmarc: `v=DMARC1; p=none; rua=mailto:dmarc@suse7.com.br; fo=1`,
});

/** Rota interna do worker de outbox (integração com dispatcher). */
export const S7_EMAIL_OUTBOX_WORKER_PATH = "/api/internal/notifications/email/process";
