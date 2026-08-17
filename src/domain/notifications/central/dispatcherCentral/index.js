// =============================================================================
// S7 — Dispatcher Central (Fase S5.2) — superfície pública
// =============================================================================

export { runCentralDispatcher } from "./centralDispatcher.js";

export {
  S7_DISPATCH_CHANNEL_CATALOG,
  S7_DISPATCH_DELIVERY_MODE,
  resolveCanonicalChannel,
  getChannelCatalogEntry,
  isChannelSupportedNow,
  listSupportedChannels,
  routeChannels,
} from "./channelCatalog.js";

export {
  S7_DISPATCH_FINAL_RESULT,
  resolveFinalResult,
  summarizeChannelStatusFromDispatches,
  summarizeEventChannelStatus,
} from "./dispatchStatusSummary.js";

export {
  S7_DISPATCH_RETRY_DEFAULTS,
  resolveDispatchRetryPolicy,
  planDispatchRetry,
} from "./retryPolicy.js";

export {
  resolveChannelFallbackChain,
  resolveNextFallbackChannel,
} from "./fallbackPolicy.js";
