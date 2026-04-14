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
  jobSecret: getEnv("JOB_SECRET"),
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
};

