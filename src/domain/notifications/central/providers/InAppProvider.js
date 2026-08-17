import { NotificationDeliveryProvider } from "./NotificationDeliveryProvider.js";
import { logInAppNotification } from "../inbox/inAppNotificationLog.js";

export class InAppNotificationProvider extends NotificationDeliveryProvider {
  constructor() {
    super("s7_in_app");
  }

  /** @param {import("./NotificationDeliveryProvider.js").NotificationDeliveryContext} ctx */
  async deliver(ctx) {
    logInAppNotification("STORE", {
      dispatch_id: ctx.dispatchId,
      seller_id: ctx.sellerId,
      deep_link: ctx.metadata?.deep_link ?? null,
    });

    return {
      ok: true,
      providerResponse: {
        channel: "in_app",
        dispatch_id: ctx.dispatchId,
        stored: true,
        persisted_in: "s7_notification_dispatches",
      },
    };
  }
}
