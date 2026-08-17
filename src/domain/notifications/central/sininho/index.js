// =============================================================================
// S7 — Central Sininho — superfície pública (Motor Central)
// =============================================================================

export {
  S7_SININHO_CHANNEL_CODE,
  S7_SININHO_CHANNEL_ALIASES,
  S7_SININHO_SEVERITY,
  S7_SININHO_INBOX_STATUS,
  S7_SININHO_READ_STATE,
  S7_SININHO_ARCHIVE_STATE,
  S7_SININHO_FUTURE_CATEGORY,
  S7_SININHO_INBOX_TABLE,
  S7_SININHO_OFFICIAL_PROVIDER,
  S7_SININHO_INBOX_API,
} from "./sininhoChannelContract.js";

export {
  isValidSininhoSeverity,
  resolveSininhoReadState,
  resolveSininhoArchiveState,
  buildSininhoTimelineEntry,
} from "./sininhoHistoryPolicy.js";

export {
  S7_SININHO_TRACE_FIELDS,
  buildSininhoDeliveryTraceSummary,
} from "./sininhoDeliveryTrace.js";

export { logSininhoNotification } from "./sininhoLog.js";

export {
  getOfficialSininhoChannelSnapshot,
  evaluateOfficialSininhoTimeline,
} from "./sininhoChannelOfficial.js";

export { previewSininhoTemplate } from "./sininhoTemplatePreview.js";
export { describeSininhoUiReuse } from "./sininhoUiReuse.js";
