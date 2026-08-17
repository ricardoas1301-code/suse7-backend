// =============================================================================
// S7 — Canal Pop-up — superfície pública (Motor Central)
// =============================================================================

export {
  S7_POPUP_CHANNEL_CODE,
  S7_POPUP_DISPLAY_TYPE,
  S7_POPUP_DISPLAY_MODE,
  S7_POPUP_DELIVERY_STATUS,
  S7_POPUP_PRIORITY,
  S7_POPUP_UI_SURFACE,
  S7_POPUP_DELIVERIES_TABLE,
  S7_POPUP_OFFICIAL_PROVIDER,
} from "./popupChannelContract.js";

export {
  isValidPopupDisplayType,
  isValidPopupDisplayMode,
  isValidPopupPriority,
  planPopupDisplay,
} from "./popupDisplayPolicy.js";

export {
  S7_POPUP_TRACE_FIELDS,
  buildPopupDeliveryTraceSummary,
} from "./popupDeliveryTrace.js";

export { logPopupNotification } from "./popupLog.js";

export {
  getOfficialPopupChannelSnapshot,
  evaluateOfficialPopupDisplay,
} from "./popupChannelOfficial.js";

export { previewPopupTemplate } from "./popupTemplatePreview.js";
export { describePopupMultiSurfaceReuse } from "./popupUiReuse.js";
