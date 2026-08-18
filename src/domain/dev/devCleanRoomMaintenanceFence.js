/**
 * @deprecated Seller-scoped fence — substituída por devGlobalMaintenanceMode.js.
 * Re-exporta API compatível para imports legados da missão anterior.
 */

export {
  DEV_GLOBAL_MAINTENANCE_REASON as DEV_CLEAN_ROOM_RESET_REASON,
  DEV_GLOBAL_MAINTENANCE_OUTCOME as DEV_CLEAN_ROOM_MAINTENANCE_OUTCOME,
  isDevGlobalMaintenanceModeActive as isDevCleanRoomMaintenanceFenceActive,
  assertDevGlobalMaintenanceNotProd as assertDevCleanRoomFenceNotProd,
  evaluateDevGlobalMaintenanceGate as evaluateDevCleanRoomMaintenanceFence,
  buildDevGlobalMaintenanceBlockedApplyResult as buildDevCleanRoomMaintenanceBlockedApplyResult,
  evaluateDevGlobalMaintenanceWebhookEvent as evaluateDevCleanRoomWebhookEventFence,
} from "./devGlobalMaintenanceMode.js";

/** @deprecated Global maintenance não usa denylist. */
export function isDevCleanRoomDenylisted() {
  return false;
}
