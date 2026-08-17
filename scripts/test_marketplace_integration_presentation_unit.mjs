#!/usr/bin/env node
/**
 * Matriz auth × sync — apresentação integração marketplace (sem maquiar estado)
 */
import { buildMlConnectionUiPack } from "../src/services/marketplace/marketplaceAccountConnectionHealth.js";
import { buildMarketplaceIntegrationPresentation } from "../src/services/marketplace/marketplaceIntegrationPresentation.js";

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

function healthyConnectionPack(overrides = {}) {
  return buildMlConnectionUiPack(
    { status: "active", ...(overrides.accountRow ?? {}) },
    overrides.tokenProbe ?? { present: true, expires_at: null, has_refresh: true },
    overrides.pipelineActive ?? false,
  );
}

function reconnectPack() {
  return buildMlConnectionUiPack(
    { status: "active" },
    { present: false, expires_at: null, has_refresh: false },
    false,
  );
}

{
  const pack = healthyConnectionPack();
  const view = buildMarketplaceIntegrationPresentation({
    connectionPack: pack,
    mlInitialSyncPhase: "awaiting_start",
    authResolved: true,
  });
  assert("auth ok + awaiting_start → Sincronização necessária", view.integration_badge_label === "Sincronização necessária");
  assert("auth ok + awaiting_start → sem reconnect", view.show_reconnect_cta === false);
}

{
  const pack = healthyConnectionPack({ pipelineActive: true });
  const view = buildMarketplaceIntegrationPresentation({
    connectionPack: pack,
    mlInitialSyncPhase: "in_progress",
    syncOverall: "running",
    authResolved: true,
  });
  assert("auth ok + in_progress → Sincronização em andamento", view.integration_badge_label === "Sincronização em andamento");
}

{
  const pack = healthyConnectionPack();
  const view = buildMarketplaceIntegrationPresentation({
    connectionPack: pack,
    mlInitialSyncPhase: "none",
    syncOverall: "done",
    authResolved: true,
  });
  assert("auth ok + sync done → Conectada", view.integration_badge_label === "Conectada");
}

{
  const pack = reconnectPack();
  const view = buildMarketplaceIntegrationPresentation({
    connectionPack: pack,
    mlInitialSyncPhase: "awaiting_start",
    authResolved: true,
  });
  assert("auth broken + awaiting_start → Reconexão necessária", view.integration_badge_label === "Reconexão necessária");
  assert("auth broken → reconnect prevails", view.show_reconnect_cta === true);
  assert("auth broken → not sync label", view.integration_badge_label !== "Sincronização necessária");
}

{
  const pack = healthyConnectionPack();
  const view = buildMarketplaceIntegrationPresentation({
    connectionPack: pack,
    mlInitialSyncPhase: "awaiting_start",
    authResolved: false,
  });
  assert("unresolved → neutral label", view.integration_badge_label === "Status");
  assert("unresolved → not false connected", view.integration_resolved === false);
}

if (failures.length) {
  console.error(JSON.stringify({ pass: false, failures }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify({ pass: true, test: "marketplace_integration_presentation_unit", cases: 8 }, null, 2),
);
