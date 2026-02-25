import {
  CallProvider,
  ConnectVerifier,
  Evidence,
  RunContext,
  RunResult,
  SalesforceVerifier,
  Scenario,
  ScenarioAssertion,
  UiVerifier
} from "./types";

export interface RunnerDeps {
  callProvider: CallProvider;
  connectVerifier: ConnectVerifier;
  salesforceVerifier: SalesforceVerifier;
  uiVerifier: UiVerifier;
}

export class ScenarioRunner {
  constructor(private readonly deps: RunnerDeps) {}

  async runScenario(scenario: Scenario): Promise<RunResult> {
    const testRunId = `${scenario.id}-${Date.now()}`;
    const context: RunContext = {
      testRunId,
      scenarioId: scenario.id,
      entryPoint: scenario.entryPoint,
      timeoutSec: scenario.timeouts.record_creation_sec
    };

    await this.executeSteps(scenario, context);

    const evidence: Evidence[] = [];
    for (const assertion of scenario.expect) {
      evidence.push(await this.verifyAssertion(assertion, context));
    }

    return {
      scenarioId: scenario.id,
      testRunId,
      passed: evidence.every((item) => item.pass),
      evidence
    };
  }

  private async executeSteps(scenario: Scenario, context: RunContext): Promise<void> {
    for (const step of scenario.steps) {
      if (step.action === "dial") {
        const placed = await this.deps.callProvider.placeCall({
          to: scenario.entryPoint,
          from: scenario.caller.phone,
          metadata: {
            test_run_id: context.testRunId,
            scenario_id: scenario.id,
            ...(scenario.caller.attributes ?? {})
          }
        });
        context.callId = placed.callId;
        continue;
      }

      if (!context.callId) {
        throw new Error("Call was not placed before call-control steps.");
      }

      if (step.action === "send_dtmf") {
        await this.deps.callProvider.sendDtmf({
          callId: context.callId,
          digits: step.value ?? ""
        });
        continue;
      }

      if (step.action === "wait") {
        await sleep((step.seconds ?? 1) * 1000);
        continue;
      }

      if (step.action === "hangup") {
        await this.deps.callProvider.hangup({ callId: context.callId });
      }
    }
  }

  private verifyAssertion(assertion: ScenarioAssertion, context: RunContext): Promise<Evidence> {
    if (assertion.type.startsWith("connect.")) {
      return this.deps.connectVerifier.verify(assertion, context);
    }
    if (assertion.type.startsWith("sf.attendance.")) {
      return this.deps.salesforceVerifier.verify(assertion, context);
    }
    if (assertion.type.startsWith("sf.ui.")) {
      return this.deps.uiVerifier.verify(assertion, context);
    }
    throw new Error(`Unsupported assertion type: ${assertion.type}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
