import { createClient } from "@supabase/supabase-js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get("code");

    if (!code) {
      return new Response(
        JSON.stringify({ error: "Code não encontrado" }),
        { status: 400 }
      );
    }

    // Variáveis
    const clientId = process.env.ML_CLIENT_ID;
    const clientSecret = process.env.ML_CLIENT_SECRET;
    const redirectUri = process.env.ML_REDIRECT_URI;

    // Trocar code por token
    const tokenResponse = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri
      })
    });

    const data = await tokenResponse.json();

    if (!data.access_token) {
      return new Response(
        JSON.stringify({ error: "Erro ao obter tokens", ml_response: data }),
        { status: 500 }
      );
    }

    // Supabase
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE
    );

    // Salvar
    const { error } = await supabase
      .from("ml_tokens")
      .upsert({
        user_id: data.user_id,
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_in: data.expires_in,
        updated_at: new Date().toISOString()
      });

    if (error) {
      return new Response(
        JSON.stringify({ error: "Falha ao salvar tokens" }),
        { status: 500 }
      );
    }

    // REDIRECIONAR PARA O FRONTEND
    return Response.redirect("https://app.suse7.com.br/dashboard", 302);

  } catch (err) {
    console.error("Erro:", err);
    return new Response(JSON.stringify({ error: "Erro interno" }), { status: 500 });
  }
}
