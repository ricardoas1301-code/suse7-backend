// =============================================================================
// S7 — Registro Oficial de Canais (Fase S5.3) — superfície pública
// =============================================================================

export {
  S7_CHANNEL_REGISTRY,
  S7_CHANNEL_TYPE,
  S7_CHANNEL_STATUS,
  S7_CHANNEL_DELIVERY_MODE,
  resolveCanonicalChannelCode,
  getChannelDefinition,
  isRegisteredChannel,
  isChannelSupported,
  isChannelAvailable,
  getChannelCapabilities,
  listRegisteredChannels,
  listAvailableChannels,
  listChannelsByStatus,
  filterRegisteredAvailableChannels,
} from "./channelRegistry.js";
