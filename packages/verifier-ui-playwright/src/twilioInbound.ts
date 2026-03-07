import twilio from "twilio";

export interface DialInboundInput {
  accountSid: string;
  authToken: string;
  from: string;
  to: string;
  /** Optional TwiML URL — when provided, Twilio fetches TwiML from this URL instead of using inline <Pause>. Used by NL Caller for <Connect><Stream>. */
  twimlUrl?: string;
}

export interface HangupInput {
  accountSid: string;
  authToken: string;
  callSid: string;
}

export async function dialInboundCall(input: DialInboundInput): Promise<{ callSid: string }> {
  const client = twilio(input.accountSid, input.authToken);
  const createOpts: Record<string, any> = {
    to: input.to,
    from: input.from,
  };
  if (input.twimlUrl) {
    // NL Caller: Twilio fetches TwiML from our server (which returns <Connect><Stream>)
    createOpts.url = input.twimlUrl;
  } else {
    // Default: keep the call alive so the agent can answer and UI can pop.
    createOpts.twiml = "<Response><Pause length=\"600\"/></Response>";
  }
  const call = await client.calls.create(createOpts);
  return { callSid: call.sid };
}

export async function hangupCall(input: HangupInput): Promise<void> {
  const client = twilio(input.accountSid, input.authToken);
  await client.calls(input.callSid).update({ status: "completed" });
}
