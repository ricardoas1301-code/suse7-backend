import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const raw = fs.readFileSync(
  path.join(scriptDir, "output/AUDIT_PANEL_PARITY_REGRESSION_2026-07-06.clean.json"),
  "utf8"
);
const marker = '"generated_at"';
const start = raw.indexOf(marker);
const brace = raw.lastIndexOf("{", start);
const data = JSON.parse(raw.slice(brace));

for (const listing of data.listings) {
  console.log(`\n## ${listing.listing_id}`);
  console.log(
    `API ${listing.api_rows_total} | normalizado ${listing.normalized_count} | variações ${listing.listing_variations_count ?? "?"}`
  );
  for (const p of listing.promotions) {
    const ign = (p.ignored_candidates ?? [])
      .map((i) => `${i.candidate_path}=${i.price}`)
      .join(", ");
    console.log(
      JSON.stringify({
        name: p.promotion_name ?? "Oferta relâmpago",
        type: `${p.promotion_type}/${p.promotion_family}`,
        full: p.full_price_brl,
        final: p.selected_final_price_brl,
        official_disc: p.official_discount_amount_brl,
        computed_disc: p.computed_discount_amount_brl,
        selected_disc: p.selected_discount_amount_brl,
        pct: p.discount_percent_display,
        payout: p.payout_brl,
        rule: p.selected_rule,
        source: p.selected_source,
        disc_source: p.discount_source,
        trace: p.source_trace,
        candidates: p.candidates_count,
        ignored: ign || null,
      })
    );
  }
}
