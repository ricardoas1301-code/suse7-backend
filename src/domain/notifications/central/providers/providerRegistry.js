import { S7_NOTIFICATION_CHANNEL } from "../constants/channels.js";
import { EmailNotificationProvider } from "./EmailProvider.js";
import { InAppNotificationProvider } from "./InAppProvider.js";
import { WhatsAppNotificationProvider } from "./WhatsAppProvider.js";

const REGISTRY = Object.freeze({
  [S7_NOTIFICATION_CHANNEL.IN_APP]: new InAppNotificationProvider(),
  [S7_NOTIFICATION_CHANNEL.EMAIL]: new EmailNotificationProvider(),
  [S7_NOTIFICATION_CHANNEL.WHATSAPP]: new WhatsAppNotificationProvider(),
});

/** @param {string} channel */
export function getNotificationDeliveryProvider(channel) {
  return REGISTRY[String(channel).trim()] ?? null;
}
