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
      // VoiceCall field assertions
      case "sf.attendance.voicecall_call_type":
        return this.assertVoiceCallField(assertion, context, "CallType");
      case "sf.attendance.voicecall_duration_gte":
        return this.assertVoiceCallDuration(assertion, context);
      case "sf.attendance.voicecall_disposition":
        return this.assertVoiceCallField(assertion, context, "CallDisposition");
      case "sf.attendance.voicecall_owner":
        return this.assertVoiceCallOwner(assertion, context);
      // AgentWork state assertions
      case "sf.attendance.agentwork_status":
        return this.assertAgentWorkField(assertion, context, "Status");
      case "sf.attendance.agentwork_routing_type":
        return this.assertAgentWorkField(assertion, context, "RoutingType");
      case "sf.attendance.agentwork_channel":
        return this.assertAgentWorkChannel(assertion, context);
      // PendingServiceRouting assertions
      case "sf.attendance.psr_created":
        return this.assertPsrCreated(assertion, context);
      case "sf.attendance.psr_routing_type":
        return this.assertPsrField(assertion, context, "RoutingType");
      case "sf.attendance.psr_queue":
        return this.assertPsrQueue(assertion, context);
      case "sf.attendance.psr_skill":
        return this.assertPsrSkill(assertion, context);
      case "sf.attendance.psr_capacity_weight":
        return this.assertPsrField(assertion, context, "CapacityWeight");
      case "sf.attendance.psr_is_transfer":
        return this.assertPsrField(assertion, context, "IsTransfer");
      case "sf.attendance.contact_match":
      case "sf.attendance.offer_state":
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

  // ── VoiceCall field assertions ──────────────────────────────────────────────

  private async assertVoiceCallField(
    assertion: ScenarioAssertion,
    context: RunContext,
    field: string
  ): Promise<Evidence> {
    const soql =
      "SELECT Id, CallType, CallDurationInSeconds, CallDisposition, " +
      "VendorCallKey, FromPhoneNumber, ToPhoneNumber " +
      "FROM VoiceCall WHERE Test_Run_Id__c = '" +
      escapeSoql(context.testRunId) + "' LIMIT 1";
    const result = await this.sf.query<Record<string, unknown>>(soql);
    const record = result.records[0];
    const observed = record?.[field] ?? null;
    return {
      assertionKey: assertion.type,
      pass: observed === assertion.equals,
      observed,
      expected: assertion.equals,
      source: "salesforce",
      refs: record?.Id ? { voiceCallId: String(record.Id) } : undefined
    };
  }

  private async assertVoiceCallDuration(
    assertion: ScenarioAssertion,
    context: RunContext
  ): Promise<Evidence> {
    const soql =
      "SELECT Id, CallDurationInSeconds FROM VoiceCall WHERE Test_Run_Id__c = '" +
      escapeSoql(context.testRunId) + "' LIMIT 1";
    const result = await this.sf.query<{ Id: string; CallDurationInSeconds?: number }>(soql);
    const duration = result.records[0]?.CallDurationInSeconds ?? 0;
    const minDuration = typeof assertion.gte === "number" ? assertion.gte :
      typeof assertion.equals === "number" ? assertion.equals : 0;
    return {
      assertionKey: assertion.type,
      pass: duration >= minDuration,
      observed: duration,
      expected: `>= ${minDuration}s`,
      source: "salesforce",
      refs: result.records[0]?.Id ? { voiceCallId: result.records[0].Id } : undefined
    };
  }

  private async assertVoiceCallOwner(
    assertion: ScenarioAssertion,
    context: RunContext
  ): Promise<Evidence> {
    const soql =
      "SELECT Id, OwnerId, Owner.Username FROM VoiceCall WHERE Test_Run_Id__c = '" +
      escapeSoql(context.testRunId) + "' LIMIT 1";
    const result = await this.sf.query<{
      Id: string;
      OwnerId: string;
      Owner?: { Username?: string };
    }>(soql);
    const observed = result.records[0]?.Owner?.Username ?? null;
    return {
      assertionKey: assertion.type,
      pass: observed === assertion.equals,
      observed,
      expected: assertion.equals,
      source: "salesforce",
      refs: result.records[0]?.Id ? { voiceCallId: result.records[0].Id } : undefined
    };
  }

  // ── AgentWork assertions ────────────────────────────────────────────────────

  private async assertAgentWorkField(
    assertion: ScenarioAssertion,
    context: RunContext,
    field: string
  ): Promise<Evidence> {
    const soql =
      "SELECT Id, Status, RoutingType, AcceptDateTime, CloseDateTime, " +
      "UserId, ServiceChannelId " +
      "FROM AgentWork WHERE Test_Run_Id__c = '" +
      escapeSoql(context.testRunId) + "' LIMIT 1";
    const result = await this.sf.query<Record<string, unknown>>(soql);
    const record = result.records[0];
    const observed = record?.[field] ?? null;
    return {
      assertionKey: assertion.type,
      pass: observed === assertion.equals,
      observed,
      expected: assertion.equals,
      source: "salesforce",
      refs: record?.Id ? { agentWorkId: String(record.Id) } : undefined
    };
  }

  private async assertAgentWorkChannel(
    assertion: ScenarioAssertion,
    context: RunContext
  ): Promise<Evidence> {
    const soql =
      "SELECT Id, ServiceChannelId, ServiceChannel.DeveloperName " +
      "FROM AgentWork WHERE Test_Run_Id__c = '" +
      escapeSoql(context.testRunId) + "' LIMIT 1";
    const result = await this.sf.query<{
      Id: string;
      ServiceChannelId: string;
      ServiceChannel?: { DeveloperName?: string };
    }>(soql);
    const observed = result.records[0]?.ServiceChannel?.DeveloperName ?? null;
    return {
      assertionKey: assertion.type,
      pass: observed === assertion.equals,
      observed,
      expected: assertion.equals,
      source: "salesforce",
      refs: result.records[0]?.Id ? { agentWorkId: result.records[0].Id } : undefined
    };
  }

  // ── PendingServiceRouting assertions ────────────────────────────────────────

  private async queryPsr(context: RunContext) {
    const soql =
      "SELECT Id, WorkItemId, RoutingType, RoutingPriority, " +
      "IsReadyForRouting, ServiceChannelId, QueueId, " +
      "CapacityWeight, IsTransfer " +
      "FROM PendingServiceRouting " +
      "WHERE WorkItemId IN (" +
      "SELECT Id FROM VoiceCall WHERE Test_Run_Id__c = '" +
      escapeSoql(context.testRunId) + "'" +
      ") LIMIT 1";
    return this.sf.query<Record<string, unknown>>(soql);
  }

  private async assertPsrCreated(
    assertion: ScenarioAssertion,
    context: RunContext
  ): Promise<Evidence> {
    const result = await this.queryPsr(context);
    const observed = result.records.length > 0;
    return {
      assertionKey: assertion.type,
      pass: observed === assertion.equals,
      observed,
      expected: assertion.equals,
      source: "salesforce",
      refs: result.records[0]?.Id ? { psrId: String(result.records[0].Id) } : undefined
    };
  }

  private async assertPsrField(
    assertion: ScenarioAssertion,
    context: RunContext,
    field: string
  ): Promise<Evidence> {
    const result = await this.queryPsr(context);
    const record = result.records[0];
    const observed = record?.[field] ?? null;
    return {
      assertionKey: assertion.type,
      pass: observed === assertion.equals,
      observed,
      expected: assertion.equals,
      source: "salesforce",
      refs: record?.Id ? { psrId: String(record.Id) } : undefined
    };
  }

  private async assertPsrQueue(
    assertion: ScenarioAssertion,
    context: RunContext
  ): Promise<Evidence> {
    const result = await this.queryPsr(context);
    const queueId = result.records[0]?.QueueId;
    if (!queueId) {
      return {
        assertionKey: assertion.type,
        pass: false,
        observed: null,
        expected: assertion.queue ?? assertion.equals,
        source: "salesforce"
      };
    }
    // Resolve queue name from QueueId
    const queueResult = await this.sf.query<{ Id: string; Name: string }>(
      "SELECT Id, Name FROM Group WHERE Id = '" + escapeSoql(String(queueId)) + "' LIMIT 1"
    );
    const observed = queueResult.records[0]?.Name ?? null;
    const expected = assertion.queue ?? assertion.equals;
    return {
      assertionKey: assertion.type,
      pass: observed === expected,
      observed,
      expected,
      source: "salesforce",
      refs: { psrId: String(result.records[0]?.Id), queueId: String(queueId) }
    };
  }

  private async assertPsrSkill(
    assertion: ScenarioAssertion,
    context: RunContext
  ): Promise<Evidence> {
    // PSR doesn't directly store skill — check via SkillRequirement on the work item
    const soql =
      "SELECT Id, SkillId, Skill.MasterLabel, SkillLevel " +
      "FROM SkillRequirement " +
      "WHERE RelatedRecordId IN (" +
      "SELECT Id FROM VoiceCall WHERE Test_Run_Id__c = '" +
      escapeSoql(context.testRunId) + "'" +
      ") LIMIT 5";
    const result = await this.sf.query<{
      Id: string;
      SkillId: string;
      Skill?: { MasterLabel?: string };
      SkillLevel?: number;
    }>(soql).catch(() => ({ records: [] }));

    const expectedSkill = assertion.skill ?? String(assertion.equals);
    const matchedSkill = result.records.find(
      (r) => r.Skill?.MasterLabel === expectedSkill
    );
    return {
      assertionKey: assertion.type,
      pass: Boolean(matchedSkill),
      observed: result.records.map((r) => r.Skill?.MasterLabel).filter(Boolean),
      expected: expectedSkill,
      source: "salesforce",
      refs: matchedSkill ? { skillRequirementId: matchedSkill.Id, skillId: matchedSkill.SkillId } : undefined
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
