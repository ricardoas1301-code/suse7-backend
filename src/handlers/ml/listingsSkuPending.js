import { requireAuthUser } from "./_helpers/requireAuthUser.js";
import { gatePremiumHandler } from "../../billing/middleware/requirePlanAccess.js";
import { listSkuDependencyPendingForUser } from "../../domain/listings/skuDependencyPending.js";

export default async function handleMlListingsSkuPending(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  if (await gatePremiumHandler(res, supabase, user.id, { module: "anuncios" })) return;

  try {
    const result = await listSkuDependencyPendingForUser(supabase, user.id, {
      page: req.query?.page,
      pageSize: req.query?.page_size,
      q: req.query?.q,
    });
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error("[ml/listings/sku-pending] failed", {
      message: error?.message ?? String(error),
      code: error?.code ?? null,
    });
    return res.status(500).json({ ok: false, error: "Falha ao carregar anúncios pendentes de SKU." });
  }
}
