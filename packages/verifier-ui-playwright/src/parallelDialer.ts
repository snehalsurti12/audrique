/**
 * parallelDialer.ts — Multi-provider concurrent call dialer.
 *
 * Launches N calls in parallel from any mix of providers (CCP, Twilio, Vonage).
 * Each call dials the same entry number. Results are collected via Promise.allSettled.
 *
 * The primary CCP call is handled by the main spec flow (dialFromConnectCcp).
 * This module handles the additional parallel calls.
 */

import type { Browser } from "@playwright/test";
import { dialFromConnectCcp } from "./connectCcpDialer";
import type { ConnectCcpSession, ConnectCcpDialInput } from "./connectCcpDialer";
import { dialInboundCall, hangupCall } from "./twilioInbound";

// ── Types ────────────────────────────────────────────────────────────────────

export type CallSource = {
  provider: "ccp" | "twilio" | "vonage";
  index: number;
};

export type ParallelDialResult = {
  source: CallSource;
  status: "connected" | "failed";
  callSid?: string;       // Twilio call SID
  ccpSession?: ConnectCcpSession; // CCP session (for cleanup)
  error?: string;
};

export interface ParallelDialInput {
  sources: CallSource[];
  entryNumber: string;
  browser: Browser;
  // CCP config (for additional CCP calls)
  ccpUrl?: string;
  ccpStorageStatePath?: string;
  ccpDialTimeoutMs?: number;
  ccpVideoDir?: string;
  // Twilio config
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFromNumber?: string;
}

// ── Parallel dialer ──────────────────────────────────────────────────────────

/**
 * Dial N parallel calls from multiple providers. Each call targets the same
 * entry number. Returns results for each source with status and cleanup handles.
 */
export async function dialParallelCalls(
  input: ParallelDialInput
): Promise<ParallelDialResult[]> {
  const { sources, entryNumber, browser } = input;

  if (sources.length === 0) {
    return [];
  }

  console.log(
    `[parallel-dialer] Launching ${sources.length} parallel calls to ${entryNumber}...`
  );

  const promises = sources.map(async (source): Promise<ParallelDialResult> => {
    const label = `${source.provider}#${source.index}`;
    try {
      switch (source.provider) {
        case "twilio": {
          if (!input.twilioAccountSid || !input.twilioAuthToken || !input.twilioFromNumber) {
            return {
              source,
              status: "failed",
              error: "Twilio credentials not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER)",
            };
          }
          console.log(`[parallel-dialer] [${label}] Dialing via Twilio...`);
          const result = await dialInboundCall({
            accountSid: input.twilioAccountSid,
            authToken: input.twilioAuthToken,
            from: input.twilioFromNumber,
            to: entryNumber,
          });
          console.log(
            `[parallel-dialer] [${label}] Twilio call placed: ${result.callSid}`
          );
          return {
            source,
            status: "connected",
            callSid: result.callSid,
          };
        }

        case "ccp": {
          if (!input.ccpUrl || !input.ccpStorageStatePath) {
            return {
              source,
              status: "failed",
              error: "CCP storage state not configured",
            };
          }
          console.log(`[parallel-dialer] [${label}] Dialing via CCP...`);
          const session = await dialFromConnectCcp({
            browser,
            ccpUrl: input.ccpUrl,
            storageStatePath: input.ccpStorageStatePath,
            to: entryNumber,
            dialTimeoutMs: input.ccpDialTimeoutMs ?? 30_000,
            videoDir: input.ccpVideoDir,
            ivrMode: "speech",
          });
          console.log(
            `[parallel-dialer] [${label}] CCP call placed.`
          );
          return {
            source,
            status: "connected",
            ccpSession: session,
          };
        }

        case "vonage": {
          // Vonage dialer not yet implemented — return graceful failure
          return {
            source,
            status: "failed",
            error: "Vonage dialer not yet implemented",
          };
        }

        default:
          return {
            source,
            status: "failed",
            error: `Unknown provider: ${source.provider}`,
          };
      }
    } catch (err: any) {
      console.error(
        `[parallel-dialer] [${label}] Failed: ${err?.message || err}`
      );
      return {
        source,
        status: "failed",
        error: err?.message || String(err),
      };
    }
  });

  const settled = await Promise.allSettled(promises);
  const results: ParallelDialResult[] = settled.map((result, i) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    return {
      source: sources[i],
      status: "failed" as const,
      error: result.reason?.message || String(result.reason),
    };
  });

  const connected = results.filter((r) => r.status === "connected").length;
  const failed = results.filter((r) => r.status === "failed").length;
  console.log(
    `[parallel-dialer] Results: ${connected} connected, ${failed} failed out of ${sources.length} total.`
  );

  return results;
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

/**
 * Hang up all parallel calls. Cleans up Twilio calls (via API) and CCP
 * sessions (via session.end()).
 */
export async function cleanupParallelCalls(
  results: ParallelDialResult[],
  twilioConfig?: { accountSid: string; authToken: string }
): Promise<void> {
  const cleanups = results.map(async (r) => {
    const label = `${r.source.provider}#${r.source.index}`;
    try {
      if (r.callSid && twilioConfig) {
        console.log(`[parallel-dialer] [${label}] Hanging up Twilio call ${r.callSid}...`);
        await hangupCall({
          accountSid: twilioConfig.accountSid,
          authToken: twilioConfig.authToken,
          callSid: r.callSid,
        });
      }
      if (r.ccpSession) {
        console.log(`[parallel-dialer] [${label}] Closing CCP session...`);
        await r.ccpSession.end();
      }
    } catch (err: any) {
      console.warn(
        `[parallel-dialer] [${label}] Cleanup error: ${err?.message || err}`
      );
    }
  });

  await Promise.allSettled(cleanups);
  console.log("[parallel-dialer] All parallel calls cleaned up.");
}
