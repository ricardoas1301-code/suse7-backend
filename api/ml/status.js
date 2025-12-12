import { createClient } from "@supabase/supabase-js";

// ======================================================
// /api/ml/status — VERIFICA SE USUÁRIO TEM TOKEN ML
// ======================================================
export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const userId = req.query.user_id;

    if (!userId) {
      return res.status(400).json({ error: "user_id não informado" });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE
    );

    const { data, error } = await supabase
      .from("ml_tokens")
      .select("access_token, expires_at")
      .eq("user_id", userId)
      .single();

    if (error || !data?.access_token) {
      return res.status(200).json({ connected: false });
    }

    return res.status(200).json({
      connected: true,
      expires_at: data.expires_at,
    });

  } catch (err) {
    console.error("Erro status ML →", err);
    return res.status(500).json({ error: "Erro interno" });
  }
}
