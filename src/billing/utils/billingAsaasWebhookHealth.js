// ======================================================================
// Diagnóstico seguro — webhook Asaas (sem expor secrets)
// ======================================================================

import { config } from "../../infra/config.js";
import { maskSupabaseProjectRef } from "../../handlers/ml/_helpers/oauthConnect.js";

/**
 * @returns {{
 *   ok: boolean;
 *   routeMounted: boolean;
 *   env: string;
 *   supabaseProjectRef: string;
 *   expectedSupabaseProjectRef: string | null;
 *   supabaseEnvAligned: boolean;
 *   hasAsaasApiKey: boolean;
 *   asaasApiKeyLength: number;
 *   hasAsaasWebhookToken: boolean;
 *   asaasWebhookTokenLength: number;
 *   asaasApiBaseUrl: string;
 *   expectedEnvironment: string;
 *   vercelEnv: string | null;
 *   backendHost: string | null;
 *   missingEnv: string[];
 *   webhookReady: boolean;
 *   timestamp: string;
 * }}
 */
export function buildBillingAsaasWebhookHealthPayload(req) {
  const supabaseRef = maskSupabaseProjectRef(config.supabaseUrl);
  const expectedRef = config.s7ExpectedSupabaseProjectRef?.trim().toLowerCase() || null;
  const hasSupabase = Boolean(config.supabaseUrl?.trim() && config.supabaseServiceRoleKey?.trim());
  const hasWebhookToken = Boolean(config.asaasWebhookToken?.trim());
  const apiKey = config.asaasApiKey?.trim() ?? "";
  const webhookToken = config.asaasWebhookToken?.trim() ?? "";
  const asaasEnv = String(config.asaasEnv || "sandbox").trim() || "sandbox";

  /** @type {string[]} */
  const missingEnv = [];
  if (!config.supabaseUrl?.trim()) missingEnv.push("SUPABASE_URL");
  if (!config.supabaseServiceRoleKey?.trim()) missingEnv.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!hasWebhookToken) missingEnv.push("ASAAS_WEBHOOK_TOKEN");
  if (!apiKey) missingEnv.push("ASAAS_API_KEY");

  const s7AppEnv = config.s7AppEnv?.trim() || null;
  const vercelEnv = process.env.VERCEL_ENV?.trim() || null;
  const expectedEnvironment =
    s7AppEnv ||
    (vercelEnv === "production" ? "production" : vercelEnv === "preview" ? "preview" : "development");

  const supabaseEnvAligned =
    !expectedRef || supabaseRef === "(empty)" || supabaseRef === "(unknown)" || supabaseRef === expectedRef;

  const webhookReady = hasSupabase && hasWebhookToken;

  return {
    ok: webhookReady && supabaseEnvAligned,
    routeMounted: true,
    env: asaasEnv,
    supabaseProjectRef: supabaseRef,
    expectedSupabaseProjectRef: expectedRef,
    supabaseEnvAligned,
    hasAsaasApiKey: apiKey.length > 0,
    asaasApiKeyLength: apiKey.length,
    hasAsaasWebhookToken: hasWebhookToken,
    asaasWebhookTokenLength: webhookToken.length,
    asaasApiBaseUrl: config.asaasApiBaseUrl || "",
    expectedEnvironment,
    vercelEnv,
    backendHost: req?.headers?.host != null ? String(req.headers.host) : null,
    missingEnv,
    webhookReady,
    timestamp: new Date().toISOString(),
  };
}
