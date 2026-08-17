import { parseMercadoLivreListingUrl } from "../src/domain/competition/mlListingUrlParser.js";

const samples = [
  ["produto direto", "https://produto.mercadolivre.com.br/MLB5464607744"],
  ["produto hífen", "https://produto.mercadolivre.com.br/MLB-5464607744"],
  ["produto slug", "https://produto.mercadolivre.com.br/MLB-5464607744-grelha-churrasqueira"],
  ["mobile", "https://m.mercadolivre.com.br/MLB5464607744"],
  ["query variation", "https://produto.mercadolivre.com.br/MLB-5464607744?searchVariation=MLB51850422"],
  ["catalog slug path", "https://www.mercadolivre.com.br/grelha/p/MLB51850422"],
  ["catalog /p/", "https://www.mercadolivre.com.br/p/MLB51850422"],
  ["catalog antigo", "https://www.mercadolivre.com.br/cuba-banheiro/p/MLB53547043"],
  ["raw item", "MLB5464607744"],
  ["raw catalog", "MLB51850422"],
  ["permalink API", "https://produto.mercadolivre.com.br/MLB5464607744-nome-do-produto"],
];

for (const [label, url] of samples) {
  const r = parseMercadoLivreListingUrl(url, { skipAudit: true });
  console.log(
    label,
    r.ok
      ? `item=${r.itemId ?? "-"} catalog=${r.catalogProductId ?? "-"} type=${r.idType} strategy=${r.parseStrategy}`
      : `FAIL ${r.code}`,
    "←",
    url.slice(0, 80)
  );
}
