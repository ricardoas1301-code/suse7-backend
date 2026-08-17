import { LiveWhatsAppAdapterBase } from "./LiveWhatsAppAdapterBase.js";

export class TwilioWhatsAppAdapter extends LiveWhatsAppAdapterBase {
  constructor() {
    super("twilio");
  }
}
