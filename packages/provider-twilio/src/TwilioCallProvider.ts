import twilio from "twilio";
import { CallProvider } from "../../core/src/types";

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  statusCallbackUrl?: string;
}

export class TwilioCallProvider implements CallProvider {
  private readonly client: ReturnType<typeof twilio>;
  private readonly statusCallbackUrl?: string;

  constructor(config: TwilioConfig) {
    this.client = twilio(config.accountSid, config.authToken);
    this.statusCallbackUrl = config.statusCallbackUrl;
  }

  async placeCall(input: {
    to: string;
    from: string;
    metadata: Record<string, string>;
  }): Promise<{ callId: string }> {
    const call = await this.client.calls.create({
      to: input.to,
      from: input.from,
      // Minimal TwiML to keep call alive; replace with your flow controls as needed.
      twiml: "<Response><Pause length=\"600\"/></Response>",
      statusCallback: this.statusCallbackUrl,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      statusCallbackMethod: "POST"
    });

    // TODO: Attach input.metadata into your tracing store and map to call.sid.
    return { callId: call.sid };
  }

  async sendDtmf(input: { callId: string; digits: string }): Promise<void> {
    await this.client.calls(input.callId).update({
      twiml: `<Response><Play digits="${escapeDigits(input.digits)}"/></Response>`
    });
  }

  async hangup(input: { callId: string }): Promise<void> {
    await this.client.calls(input.callId).update({
      status: "completed"
    });
  }
}

function escapeDigits(value: string): string {
  return value.replace(/[^0-9A-D*#wW]/g, "");
}
