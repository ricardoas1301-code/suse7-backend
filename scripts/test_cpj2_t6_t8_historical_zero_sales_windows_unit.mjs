#!/usr/bin/env node
/**
 * Histórico vazio: 10 janelas done + 0 vendas ≠ card 0/10.
 */
import assert from "node:assert/strict";
import {
  aggregateHistoricalSalesJobs,
  buildMlAccountSyncChecklist,
} from "../src/services/marketplace/mlAccountSyncChecklist.js";
import { buildMlHistoricalSalesUxState } from "../src/services/marketplace/mlHistoricalSalesUx.js";

function windowJob(index, status = "done") {
  return {
    id: `hist-${index}`,
    job_type: "ml_historical_sales_backfill",
    status,
    progress_current: 0,
    progress_total: 0,
    metadata: {
      window_index: index,
      ml_sales_import_saved: 0,
      ml_sales_import_api_total: 0,
    },
  };
}

const doneWindows = Array.from({ length: 10 }, (_, i) => windowJob(i, "done"));
const agg = aggregateHistoricalSalesJobs(doneWindows);
assert.equal(agg.status, "done");
assert.equal(agg.windows_total, 10);
assert.equal(agg.windows_done, 10);
assert.equal(agg.progress_current, 0);
assert.equal(agg.progress_total, 0);
assert.equal(`${agg.windows_done}/${agg.windows_total}`, "10/10");
console.log("HISTORICAL_WINDOWS_EFFECTIVE_TOTAL=10");
console.log("HISTORICAL_WINDOWS_COMPLETED=10");
console.log("HISTORICAL_SALES_FOUND=0");

const { checklist } = buildMlAccountSyncChecklist({ id: "acc", status: "active" }, [
  { id: "hot", job_type: "ml_initial_sales_recent", status: "done", progress_current: 0, progress_total: 0, metadata: {} },
  ...doneWindows,
]);
const hist = checklist.find((row) => row.key === "historical_sales");
assert.equal(hist.status, "done");
assert.equal(hist.progress_current, 10);
assert.equal(hist.progress_total, 10);
assert.notEqual(`${hist.progress_current}/${hist.progress_total}`, "0/10");
console.log("TERMINAL_HISTORY_COUNTER=10/10");

const ux = buildMlHistoricalSalesUxState(doneWindows, null);
assert.ok(ux.checklist_detail_lines.some((line) => line === "Vendas encontradas: 0"));
assert.ok(!ux.checklist_detail_lines.some((line) => /Vendas localizadas na API: 10/.test(line)));
console.log("NO_FAKE_SALES_COUNT=YES");
console.log("ZERO_SALES_SEMANTICS_PROVEN=YES");
console.log("CPJ2_T6_T8_HISTORICAL_ZERO_SALES_WINDOWS=PASS");
