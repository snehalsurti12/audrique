import { ConnectVerifier, Evidence, RunContext, ScenarioAssertion } from "../../core/src/types";

export interface ConnectClient {
  getCtrByTestRunId(testRunId: string): Promise<Record<string, unknown> | null>;
}

export class ConnectCtrVerifier implements ConnectVerifier {
  constructor(private readonly connectClient: ConnectClient) {}

  async verify(assertion: ScenarioAssertion, context: RunContext): Promise<Evidence> {
    const ctr = await this.connectClient.getCtrByTestRunId(context.testRunId);
    if (!ctr) {
      return {
        assertionKey: assertion.type,
        pass: false,
        observed: "CTR not found",
        expected: assertion.equals,
        source: "connect"
      };
    }

    switch (assertion.type) {
      case "connect.agent_offer": {
        const observed = Boolean(ctr["agentOffer"]);
        return result(assertion, observed, { ctrId: String(ctr["contactId"] ?? "") });
      }
      case "connect.flow_path": {
        const observed = String(ctr["flowPath"] ?? "");
        return result(assertion, observed, { ctrId: String(ctr["contactId"] ?? "") });
      }
      case "connect.disconnect_reason": {
        const observed = String(ctr["disconnectReason"] ?? "");
        return result(assertion, observed, { ctrId: String(ctr["contactId"] ?? "") });
      }
      default:
        throw new Error(`Unsupported Connect assertion: ${assertion.type}`);
    }
  }
}

function result(assertion: ScenarioAssertion, observed: unknown, refs?: Record<string, string>): Evidence {
  return {
    assertionKey: assertion.type,
    pass: observed === assertion.equals,
    observed,
    expected: assertion.equals,
    source: "connect",
    refs
  };
}
