import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";

export default async function handleMarketplaceAccountById(req, res, path) {
  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const accountId = String(path || "").match(/^\/api\/marketplace\/accounts\/([^/]+)$/)?.[1] ?? null;
  if (!accountId) {
    return res.status(400).json({ ok: false, error: "Conta inválida" });
  }

  if (req.method === "PATCH") {
    return res.status(200).json({ ok: true, updated: false, message: "Sem alterações neste hotfix" });
  }
  if (req.method === "DELETE") {
    return res.status(200).json({ ok: true, deleted: false, message: "Sem alterações neste hotfix" });
  }
  return res.status(405).json({ ok: false, error: "Método não permitido" });
}
