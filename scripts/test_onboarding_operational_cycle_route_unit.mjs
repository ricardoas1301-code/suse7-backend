#!/usr/bin/env node
/**
 * Onboarding M5 — contrato PATCH /api/onboarding/operational-cycle
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validarPayloadConfirmacaoCicloOperacional } from "../src/onboarding/domain/cicloOperacionalConta.js";

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

const valid = validarPayloadConfirmacaoCicloOperacional({
  close_time: "18:00",
  working_days: [1, 2, 3, 4, 5],
});
assert("payload válido close_time + working_days", valid.ok === true);
assert("normaliza hora", valid.closesAt === "18:00:00");
assert("normaliza dias", JSON.stringify(valid.workingDays) === JSON.stringify([1, 2, 3, 4, 5]));

const invalidTime = validarPayloadConfirmacaoCicloOperacional({ close_time: "", working_days: [1] });
assert("horário inválido rejeitado", invalidTime.ok === false && invalidTime.code === "CLOSE_TIME_INVALID");

const invalidDays = validarPayloadConfirmacaoCicloOperacional({ close_time: "18:00", working_days: [] });
assert("dias vazios rejeitados", invalidDays.ok === false && invalidDays.code === "WORKING_DAYS_EMPTY");

const root = dirname(fileURLToPath(import.meta.url));
const apiIndex = readFileSync(join(root, "../api/index.js"), "utf8");
const handlerSrc = readFileSync(
  join(root, "../src/handlers/onboarding/operationalCycleSave.js"),
  "utf8",
);
const serviceSrc = readFileSync(
  join(root, "../src/onboarding/services/persistirCicloOperacionalConta.js"),
  "utf8",
);

assert("router registra operational-cycle", apiIndex.includes('path === "/api/onboarding/operational-cycle"'));
assert("router aceita PATCH", apiIndex.includes('req.method === "PATCH"'));
assert("handler exportado", handlerSrc.includes("handleOnboardingOperationalCycleSave"));
assert("service persistência", serviceSrc.includes("persistirCicloOperacionalConta"));

if (failures.length) {
  console.error(JSON.stringify({ pass: false, test: "onboarding_operational_cycle_route_unit", failures }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify({
    pass: true,
    test: "onboarding_operational_cycle_route_unit",
    cases: 9,
  }),
);
