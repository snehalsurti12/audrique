import twilio from "twilio";

export interface DialInboundInput {
  accountSid: string;
  authToken: string;
  from: string;
  to: string;
}

export interface HangupInput {
  accountSid: string;
  authToken: string;
  callSid: string;
}

export async function dialInboundCall(input: DialInboundInput): Promise<{ callSid: string }> {
  const client = twilio(input.accountSid, input.authToken);
  const call = await client.calls.create({
    to: input.to,
    from: input.from,
    // Keep the call alive so the agent can answer and UI can pop.
    twiml: "<Response><Pause length=\"600\"/></Response>"
  });
  return { callSid: call.sid };
}

export async function hangupCall(input: HangupInput): Promise<void> {
  const client = twilio(input.accountSid, input.authToken);
  await client.calls(input.callSid).update({ status: "completed" });
}
