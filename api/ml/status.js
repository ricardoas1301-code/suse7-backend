import { createClient } from "@supabase/supabase-js";

// ======================================================
// /api/ml/status — VERIFICA SE USUÁRIO TEM TOKEN ML
// ======================================================
export async function GET(req) {
  try {
    // --------------------------------------------------
    // Captura user_id (UUID do Supabase)
    // --------------------------------------------------
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("user_id");

    if (!userId) {
      return new Response(
        JSON.stringify({ error: "user_id não informado" }),
        { status: 400 }
      );
    }

    // --------------------------------------------------
    // Conexão Supabase (Service Role)
    // --------------------------------------------------
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE
    );

    // --------------------------------------------------
    // Busca token do Mercado Livre
    // --------------------------------------------------
    const { data, error } = await supabase
      .from("ml_tokens")
      .select("access_token, expires_at")
      .eq("user_id", userId)
      .single();

    if (error || !data?.access_token) {
      return new Response(
        JSON.stringify({ connected: false }),
        { status: 200 }
      );
    }

    // --------------------------------------------------
    // Token existe → conectado
    // --------------------------------------------------
    return new Response(
      JSON.stringify({
        connected: true,
        expires_at: data.expires_at
      }),
      { status: 200 }
    );

  } catch (err) {
    console.error("Erro status ML →", err);
    return new Response(
      JSON.stringify({ error: "Erro interno" }),
      { status: 500 }
    );
  }
}
