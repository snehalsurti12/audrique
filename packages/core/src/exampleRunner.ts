import { readFile } from "node:fs/promises";
import { ScenarioRunner } from "./runner";
import { ConnectVerifier, Evidence, SalesforceVerifier, Scenario, ScenarioAssertion, UiVerifier } from "./types";

class NoopConnectVerifier implements ConnectVerifier {
  async verify(assertion: ScenarioAssertion): Promise<Evidence> {
    return {
      assertionKey: assertion.type,
      pass: false,
      observed: "Noop verifier",
      expected: assertion.equals,
      source: "connect"
    };
  }
}

class NoopSalesforceVerifier implements SalesforceVerifier {
  async verify(assertion: ScenarioAssertion): Promise<Evidence> {
    return {
      assertionKey: assertion.type,
      pass: false,
      observed: "Noop verifier",
      expected: assertion.equals,
      source: "salesforce"
    };
  }
}

class NoopUiVerifier implements UiVerifier {
  async verify(assertion: ScenarioAssertion): Promise<Evidence> {
    return {
      assertionKey: assertion.type,
      pass: false,
      observed: "Noop verifier",
      expected: assertion.equals,
      source: "ui"
    };
  }
}

const noopCallProvider = {
  async placeCall() {
    return { callId: "fake-call-id" };
  },
  async sendDtmf() {},
  async hangup() {}
};

async function main(): Promise<void> {
  const scenarioPath = process.argv[2];
  if (!scenarioPath) {
    throw new Error("Usage: node --loader ts-node/esm packages/core/src/exampleRunner.ts <scenario.json>");
  }

  const content = await readFile(scenarioPath, "utf8");
  const scenario = JSON.parse(content) as Scenario;

  const runner = new ScenarioRunner({
    callProvider: noopCallProvider,
    connectVerifier: new NoopConnectVerifier(),
    salesforceVerifier: new NoopSalesforceVerifier(),
    uiVerifier: new NoopUiVerifier()
  });

  const result = await runner.runScenario(scenario);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

void main();
