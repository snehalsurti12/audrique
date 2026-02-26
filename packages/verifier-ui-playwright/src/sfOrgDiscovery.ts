/**
 * sfOrgDiscovery.ts — Auto-discover org configuration from Salesforce.
 *
 * Queries metadata via SOQL and inspects the live DOM to build
 * an OrgVocabulary that drives all scenario execution — no hardcoded
 * labels, statuses, queue names, or column headers.
 *
 * Usage:
 *   const vocab = await discoverOrgVocabulary(page, sfClient);
 *   // vocab.presenceStatuses → [{ label: "Available for Voice", ... }]
 *   // vocab.queues → [{ name: "Support Queue", developerName: "Support_Queue" }]
 *   // vocab.skills → [{ name: "Spanish", id: "0Hn..." }]
 *   // vocab.supervisorSurfaces → ["Command Center for Service"]
 *   // vocab.tableColumns → { queue: 0, waiting: 1, ... }
 */

import type { Page } from "@playwright/test";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SalesforceQueryClient {
  query<T = Record<string, unknown>>(soql: string): Promise<{ records: T[] }>;
}

/** A presence status available in this org. */
export interface PresenceStatus {
  id: string;
  label: string;
  developerName: string;
  /** Whether this status represents an "online/available" state. */
  isOnline: boolean;
  /** Channels associated with this status (e.g., "Voice", "Chat"). */
  channels: string[];
}

/** A queue configured in this org. */
export interface OrgQueue {
  id: string;
  name: string;
  developerName: string;
  /** The service channel(s) this queue is associated with, if discoverable. */
  channels: string[];
}

/** A skill configured in this org (for skill-based routing). */
export interface OrgSkill {
  id: string;
  name: string;
  developerName: string;
}

/** A skill-to-agent mapping. */
export interface AgentSkill {
  agentUserId: string;
  agentUsername: string;
  skillId: string;
  skillName: string;
  skillLevel?: number;
}

/** A service channel in this org. */
export interface OrgServiceChannel {
  id: string;
  label: string;
  developerName: string;
  relatedEntity: string;
}

/** A routing configuration in this org. */
export interface OrgRoutingConfig {
  id: string;
  label: string;
  developerName: string;
  routingModel: string;
  routingPriority?: number;
  capacityWeight?: number;
  capacityType?: string;
}

/** A flow configured in Amazon Connect (if exposed via SF). */
export interface OrgContactFlow {
  id: string;
  name: string;
  type: string;
}

/** Business hours / operating hours for the org. */
export interface OrgBusinessHours {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  timeZone: string;
  /** Day-of-week schedule: { Monday: { start: "08:00", end: "17:00" }, ... } */
  schedule: Record<string, { start: string; end: string } | null>;
}

/** Queue configuration details (beyond basic Group record). */
export interface OrgQueueConfig {
  queueId: string;
  queueName: string;
  /** Business hours assigned to this queue, if any. */
  businessHoursId?: string;
  businessHoursName?: string;
  /** Whether voicemail is enabled for this queue. */
  voicemailEnabled?: boolean;
  /** Whether callback is enabled for this queue. */
  callbackEnabled?: boolean;
  /** Queue overflow threshold. */
  overflowThreshold?: number;
  /** Overflow target queue/flow. */
  overflowTarget?: string;
}

/** IVR prompt configured in the system. */
export interface OrgPrompt {
  id: string;
  name: string;
  description?: string;
  /** The expected text/transcript of the prompt. */
  expectedText?: string;
  /** Where this prompt is used: "greeting", "closed_hours", "voicemail", "hold_music", "queue_position", "callback_offer". */
  usage?: string;
}

/** UI elements discovered from the live DOM. */
export interface DomDiscovery {
  /** Presence statuses visible in the omni dropdown. */
  presenceOptions: string[];
  /** Tab labels found in the utility bar / sidebar. */
  utilityTabs: string[];
  /** Supervisor surface/tab names discovered. */
  supervisorSurfaces: string[];
  /** Table column headers discovered on supervisor pages. */
  tableColumnHeaders: string[];
  /** Phone utility label as it appears in the org. */
  phoneUtilityLabel: string | null;
  /** Omni-Channel label as it appears in the org. */
  omniChannelLabel: string | null;
  /** Accept button label as it appears in the org. */
  acceptButtonLabel: string | null;
}

/** Complete org vocabulary — everything needed to run scenarios. */
export interface OrgVocabulary {
  /** When this vocabulary was discovered. */
  discoveredAt: string;
  /** Org identifier (org ID or instance URL). */
  orgId: string;

  // ── SOQL-discovered ──
  presenceStatuses: PresenceStatus[];
  queues: OrgQueue[];
  skills: OrgSkill[];
  agentSkills: AgentSkill[];
  serviceChannels: OrgServiceChannel[];
  routingConfigs: OrgRoutingConfig[];
  businessHours: OrgBusinessHours[];
  queueConfigs: OrgQueueConfig[];
  prompts: OrgPrompt[];

  // ── DOM-discovered ──
  dom: DomDiscovery;

  // ── Resolved shortcuts (derived from above) ──
  /** The "available/online" status to use for agent preflight. */
  onlineStatus: string | null;
  /** Map of queue names to developer names for scenario authoring. */
  queueMap: Record<string, string>;
  /** Map of skill names to IDs for skill-based routing. */
  skillMap: Record<string, string>;
  /** Whether this org uses skill-based routing. */
  hasSkillBasedRouting: boolean;
  /** Whether this org has voicemail configured on any queue. */
  hasVoicemail: boolean;
  /** Whether this org has callback configured on any queue. */
  hasCallback: boolean;
  /** Current business hours status for the default hours. */
  currentlyOpen: boolean | null;
}

// ── SOQL Discovery ──────────────────────────────────────────────────────────

/**
 * Discover all ServicePresenceStatus records in this org.
 * These are the status options agents can select in Omni-Channel.
 */
export async function discoverPresenceStatuses(
  sf: SalesforceQueryClient
): Promise<PresenceStatus[]> {
  const soql = `
    SELECT Id, MasterLabel, DeveloperName
    FROM ServicePresenceStatus
    ORDER BY MasterLabel ASC
  `.trim();

  const result = await sf.query<{
    Id: string;
    MasterLabel: string;
    DeveloperName: string;
  }>(soql).catch(() => ({ records: [] }));

  // Determine online vs offline by convention:
  // Statuses with "Available", "Online", "Ready" in the label are online.
  // "Busy", "Away", "Offline", "Break" are not.
  const onlinePatterns = /\b(available|online|ready)\b/i;
  const offlinePatterns = /\b(offline|busy|away|break|do not disturb|dnd|lunch|training|meeting)\b/i;

  return result.records.map((r) => ({
    id: r.Id,
    label: r.MasterLabel,
    developerName: r.DeveloperName,
    isOnline: onlinePatterns.test(r.MasterLabel) && !offlinePatterns.test(r.MasterLabel),
    channels: [] // Populated by cross-referencing StatusChannelConfig if needed
  }));
}

/**
 * Discover all queues in this org (Group WHERE Type='Queue').
 */
export async function discoverQueues(sf: SalesforceQueryClient): Promise<OrgQueue[]> {
  const soql = `
    SELECT Id, Name, DeveloperName
    FROM Group
    WHERE Type = 'Queue'
    ORDER BY Name ASC
  `.trim();

  const result = await sf.query<{
    Id: string;
    Name: string;
    DeveloperName: string;
  }>(soql).catch(() => ({ records: [] }));

  return result.records.map((r) => ({
    id: r.Id,
    name: r.Name,
    developerName: r.DeveloperName,
    channels: []
  }));
}

/**
 * Discover all skills configured in this org.
 * Skills are used for skill-based routing — agents are assigned skills,
 * and incoming work is routed based on required skills.
 */
export async function discoverSkills(sf: SalesforceQueryClient): Promise<OrgSkill[]> {
  const soql = `
    SELECT Id, MasterLabel, DeveloperName
    FROM Skill
    ORDER BY MasterLabel ASC
  `.trim();

  const result = await sf.query<{
    Id: string;
    MasterLabel: string;
    DeveloperName: string;
  }>(soql).catch(() => ({ records: [] }));

  return result.records.map((r) => ({
    id: r.Id,
    name: r.MasterLabel,
    developerName: r.DeveloperName
  }));
}

/**
 * Discover agent-to-skill mappings.
 * Shows which agents have which skills assigned (and at what level).
 */
export async function discoverAgentSkills(sf: SalesforceQueryClient): Promise<AgentSkill[]> {
  const soql = `
    SELECT Id, ServiceResourceId, ServiceResource.RelatedRecord.Username,
           SkillId, Skill.MasterLabel, SkillLevel
    FROM ServiceResourceSkill
    WHERE ServiceResource.IsActive = true
    ORDER BY Skill.MasterLabel ASC
  `.trim();

  const result = await sf.query<{
    Id: string;
    ServiceResourceId: string;
    ServiceResource: { RelatedRecord: { Username: string } };
    SkillId: string;
    Skill: { MasterLabel: string };
    SkillLevel?: number;
  }>(soql).catch(() => ({ records: [] }));

  return result.records.map((r) => ({
    agentUserId: r.ServiceResourceId,
    agentUsername: r.ServiceResource?.RelatedRecord?.Username ?? "unknown",
    skillId: r.SkillId,
    skillName: r.Skill?.MasterLabel ?? "unknown",
    skillLevel: r.SkillLevel
  }));
}

/**
 * Discover service channels in this org.
 */
export async function discoverServiceChannels(
  sf: SalesforceQueryClient
): Promise<OrgServiceChannel[]> {
  const soql = `
    SELECT Id, MasterLabel, DeveloperName, RelatedEntity
    FROM ServiceChannel
    ORDER BY MasterLabel ASC
  `.trim();

  const result = await sf.query<{
    Id: string;
    MasterLabel: string;
    DeveloperName: string;
    RelatedEntity: string;
  }>(soql).catch(() => ({ records: [] }));

  return result.records.map((r) => ({
    id: r.Id,
    label: r.MasterLabel,
    developerName: r.DeveloperName,
    relatedEntity: r.RelatedEntity
  }));
}

/**
 * Discover routing configurations in this org.
 * Determines if the org uses queue-based, skill-based, or direct routing.
 */
export async function discoverRoutingConfigs(
  sf: SalesforceQueryClient
): Promise<OrgRoutingConfig[]> {
  const soql = `
    SELECT Id, MasterLabel, DeveloperName, RoutingModel,
           RoutingPriority, CapacityWeight, CapacityType
    FROM RoutingConfiguration
    ORDER BY MasterLabel ASC
  `.trim();

  const result = await sf.query<{
    Id: string;
    MasterLabel: string;
    DeveloperName: string;
    RoutingModel: string;
    RoutingPriority?: number;
    CapacityWeight?: number;
    CapacityType?: string;
  }>(soql).catch(() => ({ records: [] }));

  return result.records.map((r) => ({
    id: r.Id,
    label: r.MasterLabel,
    developerName: r.DeveloperName,
    routingModel: r.RoutingModel ?? "unknown",
    routingPriority: r.RoutingPriority,
    capacityWeight: r.CapacityWeight,
    capacityType: r.CapacityType
  }));
}

/**
 * Discover business hours / operating hours configured in the org.
 * Salesforce uses BusinessHours for standard hours and OperatingHours for
 * Omni-Channel / SCV flows.
 */
export async function discoverBusinessHours(
  sf: SalesforceQueryClient
): Promise<OrgBusinessHours[]> {
  // Try OperatingHours first (used by Omni-Channel / SCV)
  const opHoursResult = await sf.query<{
    Id: string;
    Name: string;
    TimeZone: string;
  }>(`
    SELECT Id, Name, TimeZone
    FROM OperatingHours
    ORDER BY Name ASC
  `.trim()).catch(() => ({ records: [] }));

  if (opHoursResult.records.length > 0) {
    // Get time slots for each operating hours record
    const results: OrgBusinessHours[] = [];
    for (const oh of opHoursResult.records) {
      const slotsResult = await sf.query<{
        DayOfWeek: string;
        StartTime: string;
        EndTime: string;
      }>(`
        SELECT DayOfWeek, StartTime, EndTime
        FROM TimeSlot
        WHERE OperatingHoursId = '${escapeSoqlLocal(oh.Id)}'
        ORDER BY DayOfWeek ASC
      `.trim()).catch(() => ({ records: [] }));

      const schedule: Record<string, { start: string; end: string } | null> = {
        Monday: null, Tuesday: null, Wednesday: null,
        Thursday: null, Friday: null, Saturday: null, Sunday: null
      };
      for (const slot of slotsResult.records) {
        schedule[slot.DayOfWeek] = {
          start: slot.StartTime,
          end: slot.EndTime
        };
      }

      results.push({
        id: oh.Id,
        name: oh.Name,
        isDefault: results.length === 0,
        isActive: true,
        timeZone: oh.TimeZone,
        schedule
      });
    }
    return results;
  }

  // Fallback to standard BusinessHours
  const bhResult = await sf.query<{
    Id: string;
    Name: string;
    IsDefault: boolean;
    IsActive: boolean;
    TimeZoneSidKey: string;
    MondayStartTime: string | null;
    MondayEndTime: string | null;
    TuesdayStartTime: string | null;
    TuesdayEndTime: string | null;
    WednesdayStartTime: string | null;
    WednesdayEndTime: string | null;
    ThursdayStartTime: string | null;
    ThursdayEndTime: string | null;
    FridayStartTime: string | null;
    FridayEndTime: string | null;
    SaturdayStartTime: string | null;
    SaturdayEndTime: string | null;
    SundayStartTime: string | null;
    SundayEndTime: string | null;
  }>(`
    SELECT Id, Name, IsDefault, IsActive, TimeZoneSidKey,
           MondayStartTime, MondayEndTime,
           TuesdayStartTime, TuesdayEndTime,
           WednesdayStartTime, WednesdayEndTime,
           ThursdayStartTime, ThursdayEndTime,
           FridayStartTime, FridayEndTime,
           SaturdayStartTime, SaturdayEndTime,
           SundayStartTime, SundayEndTime
    FROM BusinessHours
    WHERE IsActive = true
    ORDER BY Name ASC
  `.trim()).catch(() => ({ records: [] }));

  return bhResult.records.map((bh) => {
    const daySlot = (start: string | null, end: string | null) =>
      start && end ? { start, end } : null;

    return {
      id: bh.Id,
      name: bh.Name,
      isDefault: bh.IsDefault,
      isActive: bh.IsActive,
      timeZone: bh.TimeZoneSidKey,
      schedule: {
        Monday: daySlot(bh.MondayStartTime, bh.MondayEndTime),
        Tuesday: daySlot(bh.TuesdayStartTime, bh.TuesdayEndTime),
        Wednesday: daySlot(bh.WednesdayStartTime, bh.WednesdayEndTime),
        Thursday: daySlot(bh.ThursdayStartTime, bh.ThursdayEndTime),
        Friday: daySlot(bh.FridayStartTime, bh.FridayEndTime),
        Saturday: daySlot(bh.SaturdayStartTime, bh.SaturdayEndTime),
        Sunday: daySlot(bh.SundayStartTime, bh.SundayEndTime)
      }
    };
  });
}

/**
 * Discover queue-specific configurations — voicemail, callback, overflow.
 * Checks VoiceMailMessage, Task (callback), and queue membership.
 */
export async function discoverQueueConfigs(
  sf: SalesforceQueryClient,
  queues: OrgQueue[]
): Promise<OrgQueueConfig[]> {
  // Check if VoiceMailMessage object exists (voicemail capability)
  const vmCheck = await sf.query<{ Id: string }>(
    "SELECT Id FROM VoiceMailMessage LIMIT 1"
  ).catch(() => ({ records: [] }));
  const orgHasVoicemail = vmCheck.records.length > 0;

  // Check if there are any callback tasks
  const cbCheck = await sf.query<{ Id: string }>(
    "SELECT Id FROM Task WHERE TaskSubtype = 'CallBack' LIMIT 1"
  ).catch(() => ({ records: [] }));
  const orgHasCallback = cbCheck.records.length > 0;

  return queues.map((q) => ({
    queueId: q.id,
    queueName: q.name,
    voicemailEnabled: orgHasVoicemail,
    callbackEnabled: orgHasCallback
  }));
}

/**
 * Check if the org is currently within business hours.
 */
export function isCurrentlyOpen(businessHours: OrgBusinessHours[]): boolean | null {
  const defaultBh = businessHours.find((bh) => bh.isDefault) ?? businessHours[0];
  if (!defaultBh) return null;

  const now = new Date();
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayName = days[now.getDay()];
  const slot = defaultBh.schedule[dayName];

  if (!slot) return false;

  // Simple time comparison (HH:MM format)
  const currentTime = now.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    timeZone: defaultBh.timeZone || undefined
  });

  return currentTime >= slot.start && currentTime <= slot.end;
}

function escapeSoqlLocal(value: string): string {
  return value.replace(/'/g, "\\'");
}

// ── DOM Discovery ───────────────────────────────────────────────────────────

/**
 * Discover presence status options from the live Omni-Channel dropdown.
 * Opens the dropdown, reads all options, then closes it.
 */
export async function discoverPresenceFromDom(page: Page): Promise<string[]> {
  const options: string[] = [];

  // Try to find and click the status dropdown/combobox
  const dropdownCandidates = [
    page.locator("[role='combobox'][aria-label*='status' i]").first(),
    page.locator("button[aria-haspopup='listbox'][aria-label*='status' i]").first(),
    page.getByRole("button", { name: /change your omni-channel status|change status/i }).first(),
    page.locator(".widget2StatusGrid button[aria-haspopup='listbox']").first()
  ];

  let dropdown: typeof dropdownCandidates[0] | null = null;
  for (const candidate of dropdownCandidates) {
    if ((await candidate.count()) > 0 && (await candidate.isVisible().catch(() => false))) {
      dropdown = candidate;
      break;
    }
  }

  if (!dropdown) return options;

  try {
    await dropdown.click();
    await page.waitForTimeout(500);

    // Read all listbox options
    const optionLocators = page.locator("[role='option'], [role='menuitem'], [role='listbox'] li");
    const count = await optionLocators.count();
    for (let i = 0; i < count; i++) {
      const text = (await optionLocators.nth(i).innerText().catch(() => "")).trim();
      if (text && text.length > 0 && text.length < 100) {
        options.push(text);
      }
    }

    // Close the dropdown (press Escape)
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  } catch {
    // If dropdown interaction fails, return empty — SOQL data is the fallback
  }

  return options;
}

/**
 * Discover utility bar tab labels from the DOM.
 */
export async function discoverUtilityTabs(page: Page): Promise<string[]> {
  const tabs: string[] = [];
  const utilityScope =
    "footer, [class*='utilityBar' i], [class*='utilitybar' i], [role='contentinfo'][aria-label*='Utility Bar' i], [aria-label='Utility Bar']";

  const items = page.locator(utilityScope).locator("a, button, div[role='tab'], div[role='button']");
  const count = await items.count().catch(() => 0);

  for (let i = 0; i < count; i++) {
    const text = (await items.nth(i).innerText().catch(() => "")).trim();
    if (text && text.length > 0 && text.length < 80) {
      tabs.push(text);
    }
  }

  return tabs;
}

/**
 * Discover supervisor surface/tab names from the current page.
 */
export async function discoverSupervisorSurfaces(page: Page): Promise<string[]> {
  const surfaces: string[] = [];

  // Look for tab bar items that could be supervisor surfaces
  const tabItems = page.locator("[role='tab'], [role='tablist'] a, [role='tablist'] button");
  const count = await tabItems.count().catch(() => 0);

  for (let i = 0; i < count; i++) {
    const text = (await tabItems.nth(i).innerText().catch(() => "")).trim();
    if (text && text.length > 0 && text.length < 100) {
      surfaces.push(text);
    }
  }

  return surfaces;
}

/**
 * Discover table column headers on the current page.
 * Handles Salesforce Lightning's "Sort by: X Filter for column X" format.
 */
export async function discoverTableColumns(page: Page): Promise<string[]> {
  const headers: string[] = [];

  const thCells = page.locator("th, [role='columnheader']");
  const count = await thCells.count().catch(() => 0);

  for (let i = 0; i < count; i++) {
    let text = (await thCells.nth(i).innerText().catch(() => "")).trim();
    // Clean Salesforce Lightning header format
    text = text
      .replace(/^sort\s+by:\s*/i, "")
      .replace(/\s*filter\s+for\s+column\s+.*/i, "")
      .trim();
    if (text && text.length > 0 && text.length < 100) {
      headers.push(text);
    }
  }

  return Array.from(new Set(headers));
}

/**
 * Discover the phone utility label from the utility bar.
 */
export async function discoverPhoneLabel(page: Page): Promise<string | null> {
  const phonePatterns = /\b(phone|softphone|voice|telephony|cti)\b/i;
  const utilityScope =
    "footer, [class*='utilityBar' i], [class*='utilitybar' i], [role='contentinfo'], [aria-label='Utility Bar']";

  const items = page.locator(utilityScope).locator("a, button, div[role='tab'], div[role='button']");
  const count = await items.count().catch(() => 0);

  for (let i = 0; i < count; i++) {
    const text = (await items.nth(i).innerText().catch(() => "")).trim();
    if (phonePatterns.test(text)) {
      return text;
    }
  }
  return null;
}

/**
 * Discover the Omni-Channel widget label from the utility bar.
 */
export async function discoverOmniLabel(page: Page): Promise<string | null> {
  const omniPatterns = /\bomni[\s-]?channel\b/i;
  const utilityScope =
    "footer, [class*='utilityBar' i], [class*='utilitybar' i], [role='contentinfo'], [aria-label='Utility Bar']";

  const items = page.locator(utilityScope).locator("a, button, div[role='tab'], div[role='button']");
  const count = await items.count().catch(() => 0);

  for (let i = 0; i < count; i++) {
    const text = (await items.nth(i).innerText().catch(() => "")).trim();
    if (omniPatterns.test(text)) {
      return text;
    }
  }
  return null;
}

/**
 * Discover the accept button label from a visible incoming call UI.
 * Only useful when a call is actually being offered.
 */
export async function discoverAcceptLabel(page: Page): Promise<string | null> {
  const acceptPatterns = /\b(accept|answer|accept work|accept call)\b/i;
  const buttons = page.locator("button");
  const count = await buttons.count().catch(() => 0);

  for (let i = 0; i < count; i++) {
    const text = (await buttons.nth(i).innerText().catch(() => "")).trim();
    if (acceptPatterns.test(text) && text.length < 50) {
      return text;
    }
  }
  return null;
}

// ── Full DOM Discovery ──────────────────────────────────────────────────────

/**
 * Run all DOM discovery probes on the current page.
 * Best called after preflight when the agent page is on the Service Console.
 */
export async function discoverDom(page: Page): Promise<DomDiscovery> {
  const [
    presenceOptions,
    utilityTabs,
    supervisorSurfaces,
    tableColumnHeaders,
    phoneUtilityLabel,
    omniChannelLabel
  ] = await Promise.all([
    discoverPresenceFromDom(page).catch(() => []),
    discoverUtilityTabs(page).catch(() => []),
    discoverSupervisorSurfaces(page).catch(() => []),
    discoverTableColumns(page).catch(() => []),
    discoverPhoneLabel(page).catch(() => null),
    discoverOmniLabel(page).catch(() => null)
  ]);

  return {
    presenceOptions,
    utilityTabs,
    supervisorSurfaces,
    tableColumnHeaders,
    phoneUtilityLabel,
    omniChannelLabel,
    acceptButtonLabel: null // Discovered during call, not preflight
  };
}

// ── Full Org Vocabulary ─────────────────────────────────────────────────────

/**
 * Discover the complete org vocabulary — SOQL metadata + live DOM state.
 * Run this once during preflight. The result drives all scenario execution.
 */
export async function discoverOrgVocabulary(
  page: Page,
  sf: SalesforceQueryClient,
  orgId?: string
): Promise<OrgVocabulary> {
  // Run SOQL and DOM discovery in parallel
  const [
    presenceStatuses,
    queues,
    skills,
    agentSkills,
    serviceChannels,
    routingConfigs,
    businessHours,
    dom
  ] = await Promise.all([
    discoverPresenceStatuses(sf),
    discoverQueues(sf),
    discoverSkills(sf),
    discoverAgentSkills(sf),
    discoverServiceChannels(sf),
    discoverRoutingConfigs(sf),
    discoverBusinessHours(sf),
    discoverDom(page)
  ]);

  // Queue configs depend on queues being discovered first
  const queueConfigs = await discoverQueueConfigs(sf, queues);

  // Derive shortcuts
  const onlineStatus =
    presenceStatuses.find((s) => s.isOnline)?.label ??
    dom.presenceOptions.find((opt) =>
      /\b(available|online|ready)\b/i.test(opt) &&
      !/\b(offline|busy|away|break)\b/i.test(opt)
    ) ??
    null;

  const queueMap: Record<string, string> = {};
  for (const q of queues) {
    queueMap[q.name] = q.developerName;
  }

  const skillMap: Record<string, string> = {};
  for (const s of skills) {
    skillMap[s.name] = s.id;
  }

  const hasSkillBasedRouting =
    skills.length > 0 ||
    routingConfigs.some((rc) =>
      /skill/i.test(rc.routingModel)
    );

  const hasVoicemail = queueConfigs.some((qc) => qc.voicemailEnabled);
  const hasCallback = queueConfigs.some((qc) => qc.callbackEnabled);
  const currentlyOpen = isCurrentlyOpen(businessHours);

  return {
    discoveredAt: new Date().toISOString(),
    orgId: orgId ?? "unknown",
    presenceStatuses,
    queues,
    skills,
    agentSkills,
    serviceChannels,
    routingConfigs,
    businessHours,
    queueConfigs,
    prompts: [], // Populated by onboarding or manual config
    dom,
    onlineStatus,
    queueMap,
    skillMap,
    hasSkillBasedRouting,
    hasVoicemail,
    hasCallback,
    currentlyOpen
  };
}

// ── Vocabulary Helpers ──────────────────────────────────────────────────────

/**
 * Resolve a queue reference to its actual name.
 * Accepts: exact name, developer name, or case-insensitive partial match.
 */
export function resolveQueueName(vocab: OrgVocabulary, reference: string): string | null {
  // Exact match
  const exact = vocab.queues.find(
    (q) => q.name === reference || q.developerName === reference
  );
  if (exact) return exact.name;

  // Case-insensitive match
  const lower = reference.toLowerCase();
  const ci = vocab.queues.find(
    (q) => q.name.toLowerCase() === lower || q.developerName.toLowerCase() === lower
  );
  if (ci) return ci.name;

  // Partial match (e.g., "Support" matches "Support Queue")
  const partial = vocab.queues.find(
    (q) => q.name.toLowerCase().includes(lower) || lower.includes(q.name.toLowerCase())
  );
  if (partial) return partial.name;

  return null;
}

/**
 * Resolve a skill reference to its actual name and ID.
 */
export function resolveSkill(vocab: OrgVocabulary, reference: string): OrgSkill | null {
  const lower = reference.toLowerCase();
  return vocab.skills.find(
    (s) =>
      s.name === reference ||
      s.developerName === reference ||
      s.name.toLowerCase() === lower ||
      s.developerName.toLowerCase() === lower
  ) ?? null;
}

/**
 * Resolve a presence status to its actual label.
 * Accepts: exact label, developer name, or semantic shorthand ("online", "available").
 */
export function resolvePresenceStatus(vocab: OrgVocabulary, reference: string): string | null {
  // Exact match
  const exact = vocab.presenceStatuses.find(
    (s) => s.label === reference || s.developerName === reference
  );
  if (exact) return exact.label;

  // Case-insensitive match
  const lower = reference.toLowerCase();
  const ci = vocab.presenceStatuses.find(
    (s) => s.label.toLowerCase() === lower || s.developerName.toLowerCase() === lower
  );
  if (ci) return ci.label;

  // Semantic shorthand: "online"/"available" resolves to the online status
  if (/^(online|available|ready)$/i.test(reference)) {
    const online = vocab.presenceStatuses.find((s) => s.isOnline);
    if (online) return online.label;
  }

  // Semantic shorthand: "offline" resolves to an offline status
  if (/^(offline)$/i.test(reference)) {
    const offline = vocab.presenceStatuses.find(
      (s) => !s.isOnline && /offline/i.test(s.label)
    );
    if (offline) return offline.label;
  }

  return null;
}

/**
 * Find the column index for a semantic column type in discovered table headers.
 * Uses fuzzy matching to handle org-specific column naming.
 */
export function resolveTableColumn(
  vocab: OrgVocabulary,
  semanticType: "queue" | "waiting" | "agent" | "status" | "skill"
): number {
  const headers = vocab.dom.tableColumnHeaders.map((h) => h.toLowerCase());

  const patterns: Record<string, RegExp> = {
    queue: /\b(queue|queues|department|group|routing queue)\b/,
    waiting: /\b(waiting|in queue|contacts?\s*waiting|total\s*waiting|backlog)\b/,
    agent: /\b(agent|service\s*rep|representative|user|name)\b/,
    status: /\b(status|state|presence|availability)\b/,
    skill: /\b(skill|skills|competency|expertise)\b/
  };

  const pattern = patterns[semanticType];
  if (!pattern) return -1;

  const idx = headers.findIndex((h) => pattern.test(h));
  return idx;
}

/**
 * Find agents who have a specific skill assigned.
 */
export function findAgentsWithSkill(
  vocab: OrgVocabulary,
  skillName: string
): AgentSkill[] {
  const skill = resolveSkill(vocab, skillName);
  if (!skill) return [];
  return vocab.agentSkills.filter((as) => as.skillId === skill.id);
}

/**
 * Get a human-readable summary of the discovered org configuration.
 * Useful for logging during preflight.
 */
export function summarizeVocabulary(vocab: OrgVocabulary): string {
  const lines: string[] = [];
  lines.push(`Org Discovery Summary (${vocab.discoveredAt})`);
  lines.push(`─────────────────────────────────────────`);

  lines.push(`\nPresence Statuses (${vocab.presenceStatuses.length}):`);
  for (const s of vocab.presenceStatuses) {
    const tag = s.isOnline ? "[online]" : "[offline]";
    lines.push(`  ${tag} ${s.label} (${s.developerName})`);
  }

  lines.push(`\nQueues (${vocab.queues.length}):`);
  for (const q of vocab.queues) {
    lines.push(`  ${q.name} (${q.developerName})`);
  }

  if (vocab.skills.length > 0) {
    lines.push(`\nSkills (${vocab.skills.length}):`);
    for (const s of vocab.skills) {
      const agents = findAgentsWithSkill(vocab, s.name);
      lines.push(`  ${s.name} — ${agents.length} agent(s) assigned`);
    }
  }

  lines.push(`\nService Channels (${vocab.serviceChannels.length}):`);
  for (const c of vocab.serviceChannels) {
    lines.push(`  ${c.label} → ${c.relatedEntity}`);
  }

  lines.push(`\nRouting Configs (${vocab.routingConfigs.length}):`);
  for (const rc of vocab.routingConfigs) {
    lines.push(`  ${rc.label} — model: ${rc.routingModel}`);
  }

  if (vocab.businessHours.length > 0) {
    lines.push(`\nBusiness Hours (${vocab.businessHours.length}):`);
    for (const bh of vocab.businessHours) {
      const defaultTag = bh.isDefault ? " [default]" : "";
      const openDays = Object.entries(bh.schedule)
        .filter(([, slot]) => slot !== null)
        .map(([day, slot]) => `${day.slice(0, 3)} ${slot!.start}-${slot!.end}`);
      lines.push(`  ${bh.name}${defaultTag} (${bh.timeZone})`);
      lines.push(`    ${openDays.join(", ") || "No schedule defined"}`);
    }
  }

  lines.push(`\nSkill-Based Routing: ${vocab.hasSkillBasedRouting ? "YES" : "NO"}`);
  lines.push(`Voicemail: ${vocab.hasVoicemail ? "YES" : "NO"}`);
  lines.push(`Callback: ${vocab.hasCallback ? "YES" : "NO"}`);
  lines.push(`Currently Open: ${vocab.currentlyOpen === null ? "(unknown)" : vocab.currentlyOpen ? "YES" : "NO"}`);
  lines.push(`Online Status: ${vocab.onlineStatus ?? "(not detected)"}`);

  if (vocab.dom.phoneUtilityLabel) {
    lines.push(`Phone Utility Label: "${vocab.dom.phoneUtilityLabel}"`);
  }
  if (vocab.dom.omniChannelLabel) {
    lines.push(`Omni-Channel Label: "${vocab.dom.omniChannelLabel}"`);
  }

  return lines.join("\n");
}
