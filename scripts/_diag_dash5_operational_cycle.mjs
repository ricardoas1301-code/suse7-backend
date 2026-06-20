#!/usr/bin/env node
// =============================================================================
// DASH.5 — diagnóstico manual do ciclo operacional (Resumo Diário Dashboard)
// =============================================================================

import { resolveOperationalDayCycle } from "../../suse7-frontend/src/features/dashboard/operationalDayCycle.js";
import { resolveDashboardScope } from "../../suse7-frontend/src/components/dashboard/dashboardScope.js";

const defaultFilters = {
  periodPreset: "this_month",
  startDate: "",
  endDate: "",
  marketplace: "",
  marketplaceAccountId: "",
};

/** @param {string} title */
function printScenario(title, payload) {
  console.log("\n===", title, "===");
  console.log(JSON.stringify(payload, null, 2));
}

printScenario("1) Seller sem configuração (fallback 18:00)", {
  closesAt: resolveOperationalDayCycle({ closesAt: null }).closesAt,
  cycle: resolveOperationalDayCycle({
    now: new Date("2026-06-20T08:00:00.000-03:00"),
    closesAt: null,
  }).labelCompact,
});

printScenario("2) Encerramento 18:00 às 08:00 BRT", {
  cycle: resolveOperationalDayCycle({
    now: new Date("2026-06-20T08:00:00.000-03:00"),
    closesAt: "18:00",
  }),
});

printScenario("3) Encerramento 17:00 às 08:00 BRT", {
  cycle: resolveOperationalDayCycle({
    now: new Date("2026-06-20T08:00:00.000-03:00"),
    closesAt: "17:00",
  }),
});

printScenario("4) Com filtro manual (ignora ciclo operacional)", {
  scope: resolveDashboardScope(
    {
      periodPreset: "custom",
      startDate: "2026-06-01",
      endDate: "2026-06-15",
      marketplaceAccountId: "",
    },
    { closesAt: "18:00" },
  ).resumoParams,
});

printScenario("5) Multi-contas — conta específica mantém ciclo operacional", {
  scope: resolveDashboardScope(defaultFilters, { closesAt: "18:00" }).resumoParams,
  scopeConta: resolveDashboardScope(
    {
      ...defaultFilters,
      marketplaceAccountId: "c8a62ec6-cfbe-4ad9-98ea-49fadebeda50",
    },
    { closesAt: "18:00" },
  ).resumoParams,
});

console.log("\n[DASH.5] Diagnóstico concluído.");
