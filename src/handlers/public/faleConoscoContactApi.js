// =============================================================================

// POST /api/public/fale-conosco/contact — formulário público (S5.13)

// Contrato HTTP compatível com Edge Function send-contact-email: { success, error? }

// =============================================================================



import { createClient } from "@supabase/supabase-js";

import { config } from "../../infra/config.js";

import { triggerFaleConoscoContact } from "../../domain/notifications/central/faleConosco/triggerFaleConoscoContact.js";

import { normalizeFaleConoscoContactBody } from "../../domain/notifications/central/faleConosco/faleConoscoContactContract.js";



/**

 * @param {import("http").IncomingMessage} req

 */

function parseBody(req) {

  if (req.body == null) return {};

  if (typeof req.body === "string") {

    try {

      return req.body.trim() ? JSON.parse(req.body) : {};

    } catch {

      return null;

    }

  }

  return typeof req.body === "object" ? req.body : {};

}



/**

 * @param {{ error?: string; failure_code?: string | null }} result

 */

function resolveFaleConoscoHttpStatus(result) {

  if (result.error === "Campos incompletos.") return 400;

  if (result.failure_code === "EMAIL_PROVIDER_NOT_CONFIGURED") return 503;

  if (result.failure_code === "DISPATCH_NOT_CREATED") return 503;

  if (result.failure_code === "PIPELINE_FAILED") return 503;

  return 422;

}



/**

 * POST /api/public/fale-conosco/contact

 */

export async function handleFaleConoscoContact(req, res) {

  if (req.method !== "POST") {

    return res.status(405).json({ success: false, error: "Método não permitido" });

  }



  const body = parseBody(req);

  if (body == null) {

    return res.status(400).json({ success: false, error: "JSON inválido" });

  }



  const payload = normalizeFaleConoscoContactBody(body);



  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {

    return res.status(503).json({ success: false, error: "Serviço indisponível." });

  }



  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {

    auth: { persistSession: false, autoRefreshToken: false },

  });



  try {

    const result = await triggerFaleConoscoContact(supabase, payload);



    if (!result.success) {

      const status = resolveFaleConoscoHttpStatus(result);

      console.warn("[faleConoscoContact] rejeitado", {

        http_status: status,

        failure_code: result.failure_code ?? null,

        payload_fields: {

          has_name: Boolean(payload.name),

          has_email: Boolean(payload.email),

          has_subject: Boolean(payload.subject),

          has_message: Boolean(payload.message),

        },

        user_error: result.error,

      });

      return res.status(status).json({ success: false, error: result.error });

    }



    return res.status(200).json({ success: true });

  } catch (e) {

    console.error("[faleConoscoContact]", e);

    return res.status(500).json({ success: false, error: "Erro inesperado ao enviar." });

  }

}


