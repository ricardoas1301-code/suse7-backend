// ======================================================
// /api/ml/connect — OAuth Mercado Livre (Vercel)
// Inicia o OAuth (NÃO exige usuário logado)
// Padrão Strategy/Adapter para futuros marketplaces
// ======================================================

import {
  validateEnv,
  generateSecureState,
  buildMlAuthUrl,
  persistOAuthState,
} from "./_helpers/oauthConnect.js";

// ----------------------------------------------
// Env keys necessárias para ML connect
// ----------------------------------------------
const ML_CONNECT_ENV_KEYS = [
  "ML_CLIENT_ID",
  "ML_REDIRECT_URI",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
];

// ----------------------------------------------
// UUID v4 regex (simplificado)
// ----------------------------------------------
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function handleMlConnect(req, res) {
  const errorId = Date.now();
  const path = "/api/ml/connect";
  const userId = req.query?.user_id ?? null;

  try {
    // ------------------------------
    // 1) Validar método e user_id
    // ------------------------------
    if (req.method !== "GET") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed",
        errorId,
      });
    }

    if (!userId || typeof userId !== "string") {
      return res.status(400).json({
        ok: false,
        error: "Missing query: user_id",
        errorId,
      });
    }

    const trimmedUserId = userId.trim();
    if (!UUID_REGEX.test(trimmedUserId)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid user_id format (expected UUID)",
        errorId,
      });
    }

    // ------------------------------
    // 2) Validar ENV vars necessárias
    // ------------------------------
    const envCheck = validateEnv(ML_CONNECT_ENV_KEYS);
    if (!envCheck.ok) {
      const msg = `Missing env: ${envCheck.missing.join(", ")}`;
      console.error("[ml/connect]", {
        errorId,
        path,
        user_id: trimmedUserId,
        missingEnv: envCheck.missing,
      });
      return res.status(500).json({
        ok: false,
        error: msg,
        errorId,
      });
    }

    // ------------------------------
    // 3) Gerar state seguro
    // ------------------------------
    const state = generateSecureState();

    // ------------------------------
    // 4) Persistir state no Supabase
    // ------------------------------
    await persistOAuthState(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      state,
      trimmedUserId,
      "ml"
    );

    // ------------------------------
    // 5) Montar URL OAuth e redirecionar 302
    // ------------------------------
    const authUrl = buildMlAuthUrl(
      process.env.ML_CLIENT_ID,
      process.env.ML_REDIRECT_URI,
      state
    );

    return res.status(302).redirect(authUrl);
  } catch (err) {
    // ------------------------------
    // Erro: log completo + mensagem diagnóstica
    // ------------------------------
    const envCheck = validateEnv(ML_CONNECT_ENV_KEYS);
    console.error("[ml/connect] errorId:", errorId, {
      path,
      user_id: userId,
      missingEnv: envCheck.missing,
      stack: err?.stack,
    });

    const diagnosticMsg = envCheck.ok
      ? err?.message || "Internal error"
      : `Missing env: ${envCheck.missing.join(", ")}`;

    return res.status(500).json({
      ok: false,
      error: diagnosticMsg,
      errorId,
    });
  }
}
