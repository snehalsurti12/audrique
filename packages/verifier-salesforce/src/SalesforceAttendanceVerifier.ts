import {
  Evidence,
  RunContext,
  SalesforceVerifier,
  ScenarioAssertion
} from "../../core/src/types";

export interface SalesforceClient {
  query<T = Record<string, unknown>>(soql: string): Promise<{ records: T[] }>;
}

export class SalesforceAttendanceVerifier implements SalesforceVerifier {
  constructor(private readonly sf: SalesforceClient) {}

  async verify(assertion: ScenarioAssertion, context: RunContext): Promise<Evidence> {
    switch (assertion.type) {
      case "sf.attendance.voicecall_created":
        return this.assertVoiceCallCreated(assertion, context);
      case "sf.attendance.agentwork_created":
        return this.assertAgentWorkCreated(assertion, context);
      case "sf.attendance.case_created":
        return this.assertCaseCreated(assertion, context);
      case "sf.attendance.voicecall_linked_case":
        return this.assertVoiceCallLinkedCase(assertion, context);
      case "sf.attendance.contact_match":
      case "sf.attendance.offer_state":
        // Add org-specific queries for these assertions.
        return passThrough(assertion, "salesforce", "Not implemented");
      default:
        throw new Error(`Unsupported Salesforce assertion: ${assertion.type}`);
    }
  }

  private async assertVoiceCallCreated(
    assertion: ScenarioAssertion,
    context: RunContext
  ): Promise<Evidence> {
    const soql =
      "SELECT Id FROM VoiceCall WHERE Test_Run_Id__c = '" + escapeSoql(context.testRunId) + "' LIMIT 1";
    const result = await this.sf.query<{ Id: string }>(soql);
    const observed = result.records.length > 0;
    return {
      assertionKey: assertion.type,
      pass: observed === assertion.equals,
      observed,
      expected: assertion.equals,
      source: "salesforce",
      refs: result.records[0]?.Id ? { voiceCallId: result.records[0].Id } : undefined
    };
  }

  private async assertAgentWorkCreated(
    assertion: ScenarioAssertion,
    context: RunContext
  ): Promise<Evidence> {
    const soql =
      "SELECT Id FROM AgentWork WHERE Test_Run_Id__c = '" + escapeSoql(context.testRunId) + "' LIMIT 1";
    const result = await this.sf.query<{ Id: string }>(soql);
    const observed = result.records.length > 0;
    return {
      assertionKey: assertion.type,
      pass: observed === assertion.equals,
      observed,
      expected: assertion.equals,
      source: "salesforce",
      refs: result.records[0]?.Id ? { agentWorkId: result.records[0].Id } : undefined
    };
  }

  private async assertCaseCreated(assertion: ScenarioAssertion, context: RunContext): Promise<Evidence> {
    const soql =
      "SELECT Id, Origin, Status FROM Case WHERE Test_Run_Id__c = '" +
      escapeSoql(context.testRunId) +
      "' LIMIT 1";
    const result = await this.sf.query<{ Id: string; Origin?: string; Status?: string }>(soql);
    const hasCase = result.records.length > 0;
    const expectedFields = assertion.fields ?? {};
    const fieldMatch =
      hasCase &&
      Object.entries(expectedFields).every(([key, value]) => {
        const found = result.records[0] as Record<string, unknown>;
        return found[key] === value;
      });
    const observed = hasCase && (Object.keys(expectedFields).length === 0 || fieldMatch);
    return {
      assertionKey: assertion.type,
      pass: observed === assertion.equals,
      observed,
      expected: assertion.equals,
      source: "salesforce",
      refs: result.records[0]?.Id ? { caseId: result.records[0].Id } : undefined
    };
  }

  private async assertVoiceCallLinkedCase(
    assertion: ScenarioAssertion,
    context: RunContext
  ): Promise<Evidence> {
    const soql =
      "SELECT Id, CaseId FROM VoiceCall WHERE Test_Run_Id__c = '" +
      escapeSoql(context.testRunId) +
      "' LIMIT 1";
    const result = await this.sf.query<{ Id: string; CaseId?: string }>(soql);
    const observed = Boolean(result.records[0]?.CaseId);
    return {
      assertionKey: assertion.type,
      pass: observed === assertion.equals,
      observed,
      expected: assertion.equals,
      source: "salesforce",
      refs: result.records[0]
        ? { voiceCallId: result.records[0].Id, caseId: result.records[0].CaseId ?? "" }
        : undefined
    };
  }
}

function passThrough(assertion: ScenarioAssertion, source: "salesforce", observed: string): Evidence {
  return {
    assertionKey: assertion.type,
    pass: false,
    observed,
    expected: assertion.equals,
    source
  };
}

function escapeSoql(value: string): string {
  return value.replace(/'/g, "\\'");
}
