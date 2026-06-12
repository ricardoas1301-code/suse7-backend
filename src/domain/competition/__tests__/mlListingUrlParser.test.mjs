import assert from "node:assert/strict";
import {
  parseMercadoLivreListingUrl,
  isValidMercadoLivreItemListingId,
  reconcileCandidateListingIdFromPermalink,
} from "../mlListingUrlParser.js";

const CASES = [
  {
    url: "https://produto.mercadolivre.com.br/MLB5464607744",
    itemId: "MLB5464607744",
    catalog: null,
    idType: "item",
  },
  {
    url: "https://produto.mercadolivre.com.br/MLB-5464607744",
    itemId: "MLB5464607744",
    catalog: null,
    idType: "item",
  },
  {
    url: "https://produto.mercadolivre.com.br/MLB-5464607744-grelha-churrasqueira",
    itemId: "MLB5464607744",
    catalog: null,
    idType: "item",
  },
  {
    url: "https://m.mercadolivre.com.br/MLB5464607744",
    itemId: "MLB5464607744",
    catalog: null,
    idType: "item",
  },
  {
    url: "https://produto.mercadolivre.com.br/MLB-5464607744?searchVariation=MLB51850422&quantity=1",
    itemId: "MLB5464607744",
    catalog: null,
    idType: "item",
  },
  {
    url: "https://www.mercadolivre.com.br/grelha/p/MLB51850422",
    itemId: null,
    catalog: "MLB51850422",
    idType: "catalog_product",
  },
  {
    url: "https://www.mercadolivre.com.br/p/MLB51850422",
    itemId: null,
    catalog: "MLB51850422",
    idType: "catalog_product",
  },
  {
    url: "https://www.mercadolivre.com.br/cuba-banheiro/p/MLB53547043",
    itemId: null,
    catalog: "MLB53547043",
    idType: "catalog_product",
  },
  {
    url: "MLB5464607744",
    itemId: "MLB5464607744",
    catalog: null,
    idType: "item",
  },
  {
    url: "MLB51850422",
    itemId: null,
    catalog: "MLB51850422",
    idType: "catalog_product",
  },
];

let passed = 0;
for (const c of CASES) {
  const r = parseMercadoLivreListingUrl(c.url, { skipAudit: true });
  assert.equal(r.ok, true, `${c.url} should parse`);
  assert.equal(r.itemId, c.itemId, `itemId for ${c.url}`);
  assert.equal(r.catalogProductId, c.catalog, `catalog for ${c.url}`);
  assert.equal(r.idType, c.idType, `idType for ${c.url}`);
  passed++;
}

assert.equal(isValidMercadoLivreItemListingId("MLB5464607744"), true);
assert.equal(isValidMercadoLivreItemListingId("MLB51850422"), false);

const reconciled = reconcileCandidateListingIdFromPermalink(
  {
    competitor_listing_id: "MLB51850422",
    competitor_permalink: "https://produto.mercadolivre.com.br/MLB-5464607744",
  },
  "https://www.mercadolivre.com.br/p/MLB51850422"
);
assert.equal(reconciled.competitor_listing_id, "MLB5464607744");

console.log(`mlListingUrlParser.test.mjs OK (${passed} cases)`);
