// ======================================================================
// Autenticação de jobs HTTP do billing (X-Job-Secret)
// ======================================================================

import { config } from "../../infra/config.js";

/**
 * @param {import("http").IncomingMessage} req
 */
export function evaluateBillingJobAuth(req) {
  const jobSecret = config.jobSecret != null ? String(config.jobSecret).trim() : "";
  const headerSecret =
    req.headers["x-job-secret"] != null ? String(req.headers["x-job-secret"]).trim() : "";
  const vercelEnv = String(process.env.VERCEL_ENV || "").trim().toLowerCase();
  const nodeEnv = String(process.env.NODE_ENV || "").trim().toLowerCase();
  const isProduction = vercelEnv === "production" || nodeEnv === "production";

  if (isProduction && jobSecret === "") {
    return { allow: false, mode: "production", reason: "missing_job_secret_config" };
  }

  if (jobSecret === "") {
    return { allow: true, mode: "none", reason: null };
  }

  if (headerSecret === jobSecret) {
    return { allow: true, mode: "x-job-secret", reason: null };
  }

  return {
    allow: false,
    mode: "x-job-secret",
    reason: headerSecret ? "invalid_job_secret" : "missing_job_secret_header",
  };
}

/**
 * Rotas /api/billing/dev/* — em produção exige segredo; fora disso permite DEV/local controlado.
 *
 * @param {import("http").IncomingMessage} req
 */
export function canRunBillingDevMaintenanceRoute(req) {
  const vercelEnv = String(process.env.VERCEL_ENV || "").trim().toLowerCase();
  const nodeEnv = String(process.env.NODE_ENV || "").trim().toLowerCase();
  const isProduction = vercelEnv === "production" || nodeEnv === "production";
  const auth = evaluateBillingJobAuth(req);
  if (isProduction) return auth.allow;

  if (String(process.env.SUSE7_BILLING_DEV_PROCESS_EXPIRATIONS || "").trim() === "1") {
    return true;
  }
  if (vercelEnv && vercelEnv !== "production") {
    return true;
  }
  if (!vercelEnv && nodeEnv !== "production") {
    return true;
  }
  return auth.allow;
}
