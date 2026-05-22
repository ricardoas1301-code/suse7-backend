// Centraliza leitura de variáveis de ambiente para o backend (Vercel/serverless)

const getEnv = (key, options = {}) => {
  const value = process.env[key];
  if (!value && options.required) {
    console.error(`Missing required env var: ${key}`);
  }
  return value ?? options.defaultValue ?? "";
};

export const config = {
  supabaseUrl: getEnv("SUPABASE_URL", { required: true }),
  supabaseServiceRoleKey: getEnv("SUPABASE_SERVICE_ROLE_KEY", { required: true }),
  frontendUrl: getEnv("FRONTEND_URL"),
  // CORS: CORS_ORIGINS (preferido) ou CORS_ALLOWED_ORIGINS
  corsOrigins: getEnv("CORS_ORIGINS", { defaultValue: "" })
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  corsAllowedOrigins: getEnv("CORS_ALLOWED_ORIGINS", {
    defaultValue: "",
  })
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  mlClientId: getEnv("ML_CLIENT_ID"),
  mlClientSecret: getEnv("ML_CLIENT_SECRET"),
  mlRedirectUri: getEnv("ML_REDIRECT_URI"),
  /**
   * Cron/job HTTP (X-Job-Secret). Ordem: JOB_SECRET → DEV_JOB_SECRET → ML_WEBHOOK_JOB_SECRET → S7_* (espelho GitHub Actions).
   * GitHub Actions DEV: secrets.DEV_JOB_SECRET (fallback legado S7_DEV_JOB_SECRET).
   * GitHub Actions PROD: secrets.S7_PROD_JOB_SECRET no header X-Job-Secret.
   */
  jobSecret:
    getEnv("JOB_SECRET") ||
    getEnv("DEV_JOB_SECRET") ||
    getEnv("ML_WEBHOOK_JOB_SECRET") ||
    getEnv("S7_PROD_JOB_SECRET") ||
    getEnv("S7_DEV_JOB_SECRET"),
  cronSecret: getEnv("CRON_SECRET"),
  /**
   * Dev Center — única variável oficial de acesso (lista de e-mails, minúsculas após trim).
   * Não existe SUSE7_DEV_CENTER_ALLOWED_USER_IDS; autorização é sempre por e-mail do JWT.
   * MVP: default único ricardo@suse7.com.br. Opcional: SUSE7_DEV_CENTER_ALLOWED_EMAILS=a@x.com,b@y.com
   */
  devCenterAllowedEmails: getEnv("SUSE7_DEV_CENTER_ALLOWED_EMAILS", {
    defaultValue: "ricardo@suse7.com.br",
  })
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  /** @see src/billing — gateway neutro (default: asaas). */
  billingProviderDefault: getEnv("BILLING_PROVIDER_DEFAULT", { defaultValue: "asaas" }).trim().toLowerCase() || "asaas",
  asaasEnv: getEnv("ASAAS_ENV", { defaultValue: "sandbox" }).trim(),
  asaasApiBaseUrl: (() => {
    const env = getEnv("ASAAS_ENV", { defaultValue: "sandbox" }).trim();
    const raw = getEnv("ASAAS_API_BASE_URL", { defaultValue: "" }).trim();
    if (raw) return raw.replace(/\/+$/, "");
    if (env.toLowerCase() === "production" || env.toLowerCase() === "prod") {
      return "https://api.asaas.com/v3";
    }
    return "https://api-sandbox.asaas.com/v3";
  })(),
  asaasApiKey: getEnv("ASAAS_API_KEY", { defaultValue: "" }).trim(),
  asaasWebhookToken: getEnv("ASAAS_WEBHOOK_TOKEN", { defaultValue: "" }).trim(),

  /** Fase 3.4 — e-mail central (mock por padrão; live via provider + API key em env). */
  s7EmailProvider: getEnv("S7_EMAIL_PROVIDER", { defaultValue: "mock" }).trim().toLowerCase(),
  s7EmailMode: getEnv("S7_EMAIL_MODE", { defaultValue: "mock" }).trim().toLowerCase(),
  s7EmailFrom: getEnv("S7_EMAIL_FROM", { defaultValue: "Suse7 <notificacoes@suse7.com.br>" }).trim(),
  /** Fase 3.4.A — whitelist sandbox (ex.: ricardoas1301@gmail.com). */
  s7EmailSandboxWhitelist: getEnv("S7_EMAIL_SANDBOX_WHITELIST", { defaultValue: "" }).trim(),
  resendApiKey: getEnv("RESEND_API_KEY", { defaultValue: "" }).trim(),
  sendgridApiKey: getEnv("SENDGRID_API_KEY", { defaultValue: "" }).trim(),

  /** Tier lógico: development | staging | production (Fase 3.5C). */
  s7AppEnv: getEnv("S7_APP_ENV", { defaultValue: "" }).trim().toLowerCase(),
  /** Fase 3.5C — permite live em DEV/STAGING apenas quando true. */
  s7AllowLiveDelivery: getEnv("S7_ALLOW_LIVE_DELIVERY", { defaultValue: "false" }).trim().toLowerCase(),

  /** Fase 3.5A — WhatsApp central (mock por padrão). */
  s7WhatsAppMode: getEnv("S7_WHATSAPP_MODE", { defaultValue: "mock" }).trim().toLowerCase(),
  s7WhatsAppProvider: getEnv("S7_WHATSAPP_PROVIDER", { defaultValue: "mock" }).trim().toLowerCase(),
  s7WhatsAppSandboxWhitelist: getEnv("S7_WHATSAPP_SANDBOX_WHITELIST", { defaultValue: "" }).trim(),
  /** Fase 3.5C.1 — Z-API live controlado (base = .../instances/{id}/token/{token}). */
  s7ZapiBaseUrl: getEnv("S7_ZAPI_BASE_URL", { defaultValue: "" }).trim(),
  s7ZapiToken: getEnv("S7_ZAPI_TOKEN", { defaultValue: "" }).trim() || getEnv("ZAPI_TOKEN", { defaultValue: "" }).trim(),
  s7ProviderSmokeEnabled: getEnv("S7_PROVIDER_SMOKE_ENABLED", { defaultValue: "false" }).trim().toLowerCase(),
  s7ProviderSmokeSeller: getEnv("S7_PROVIDER_SMOKE_SELLER", { defaultValue: "" }).trim(),
  s7ProviderSmokePhone: getEnv("S7_PROVIDER_SMOKE_PHONE", { defaultValue: "" }).trim(),
  zapiToken: getEnv("ZAPI_TOKEN", { defaultValue: "" }).trim(),
  evolutionApiKey: getEnv("EVOLUTION_API_KEY", { defaultValue: "" }).trim(),
  metaWhatsAppToken: getEnv("META_WHATSAPP_TOKEN", { defaultValue: "" }).trim(),
  twilioAuthToken: getEnv("TWILIO_AUTH_TOKEN", { defaultValue: "" }).trim(),

  internalNotificationSecret:
    getEnv("S7_INTERNAL_NOTIFICATION_SECRET") ||
    getEnv("JOB_SECRET") ||
    getEnv("DEV_JOB_SECRET") ||
    getEnv("S7_DEV_JOB_SECRET"),

  /** Fase 4A.2 — observabilidade de ingestão em GET /api/customers (summary.ingestion_health). */
  customersIngestionHealthEnabled:
    getEnv("CUSTOMERS_INGESTION_HEALTH_ENABLED", { defaultValue: "false" }).trim().toLowerCase() === "true",

  /** Fase 4A.3 — qualidade de dados em GET /api/customers (summary.data_quality_overview). */
  customersDataQualityEnabled:
    getEnv("CUSTOMERS_DATA_QUALITY_ENABLED", { defaultValue: "false" }).trim().toLowerCase() === "true",
};

