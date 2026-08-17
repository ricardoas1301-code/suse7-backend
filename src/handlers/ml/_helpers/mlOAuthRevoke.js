// ======================================================================
// Revoga access_token no Mercado Livre após OAuth inválido (ex.: CNPJ).
// POST https://api.mercadolibre.com/oauth/revoke
// ======================================================================

/**
 * @param {string} accessToken
 * @returns {Promise<{ ok: boolean; http_status?: number; skipped?: boolean; error?: string }>}
 */
export async function revokeMercadoLibreAccessToken(accessToken) {
  const tok = accessToken != null && String(accessToken).trim() !== "" ? String(accessToken).trim() : "";
  const clientId = process.env.ML_CLIENT_ID?.trim();
  const clientSecret = process.env.ML_CLIENT_SECRET?.trim();
  if (!tok || !clientId || !clientSecret) {
    return { ok: false, skipped: true, error: "missing_token_or_client" };
  }
  try {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      token: tok,
    });
    const res = await fetch("https://api.mercadolibre.com/oauth/revoke", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    const ok = res.ok;
    if (!ok) {
      const txt = await res.text().catch(() => "");
      return { ok: false, http_status: res.status, error: txt?.slice?.(0, 200) ?? `http_${res.status}` };
    }
    return { ok: true, http_status: res.status };
  } catch (e) {
    return { ok: false, error: e?.message ? String(e.message) : String(e) };
  }
}
