/**
 * Audrique Scenario Studio — Frontend Application
 *
 * Interactive wizard for building declarative v2 test scenarios.
 * Supports complex multi-step scenarios including:
 *   - Multi-level IVR sequences
 *   - Post-accept conversation (hold, audio, transcript, ACW)
 *   - Advanced step builder for custom step ordering
 */

// ── State ───────────────────────────────────────────────────────────────────

const state = {
  suites: [],
  currentSuiteFile: "",
  currentSuite: null,
  editingScenarioId: null,
  wizardStep: 0,
  answers: {},
};

const STEPS = [
  { id: "call", label: "Call Setup", icon: "1" },
  { id: "ivr", label: "IVR & Routing", icon: "2" },
  { id: "agent", label: "Agent", icon: "3" },
  { id: "conversation", label: "Conversation", icon: "4" },
  { id: "supervisor", label: "Supervisor", icon: "5" },
  { id: "details", label: "Details", icon: "6" },
  { id: "review", label: "Review", icon: "7" },
];

// All known step action types for the advanced builder
const ALL_STEP_ACTIONS = [
  // Orchestration
  { action: "preflight", label: "Preflight", desc: "Login, open omni-channel, set status" },
  { action: "trigger_call", label: "Trigger Call", desc: "Place the inbound call via CCP/Twilio" },
  { action: "detect_incoming", label: "Detect Incoming", desc: "Wait for incoming call signal" },
  { action: "accept_call", label: "Accept Call", desc: "Agent accepts the incoming call" },
  { action: "decline_call", label: "Decline Call", desc: "Agent declines or misses the call" },
  // IVR & prompts
  { action: "send_dtmf_sequence", label: "Send DTMF", desc: "Send DTMF digits mid-call" },
  { action: "wait_for_ivr_prompt", label: "Wait for IVR Prompt", desc: "Wait for IVR to finish speaking" },
  { action: "listen_for_prompt", label: "Listen for Prompt", desc: "Verify a specific prompt/message plays" },
  // Verification
  { action: "verify_screen_pop", label: "Verify Screen Pop", desc: "Check VoiceCall record appears" },
  { action: "verify_transcript", label: "Verify Transcript", desc: "Check transcript captures speech" },
  { action: "verify_voicecall_record", label: "Verify VoiceCall Record", desc: "Read VoiceCall record fields" },
  { action: "verify_prompt_played", label: "Verify Prompt Played", desc: "Assert a specific prompt was played" },
  { action: "verify_no_agent_offer", label: "Verify No Agent Offer", desc: "Assert call was NOT offered to agent" },
  // Supervisor
  { action: "start_supervisor", label: "Start Supervisor", desc: "Open supervisor console, observe queue" },
  // Audio injection
  { action: "play_agent_audio", label: "Play Agent Audio", desc: "Inject audio from agent side" },
  { action: "play_caller_audio", label: "Play Caller Audio", desc: "Inject audio from caller side" },
  { action: "wait_for_transcript", label: "Wait for Transcript", desc: "Wait until transcript contains text" },
  // Call lifecycle
  { action: "hold_call", label: "Hold Call", desc: "Agent puts caller on hold" },
  { action: "resume_call", label: "Resume Call", desc: "Agent takes caller off hold" },
  { action: "end_call", label: "End Call", desc: "Agent-initiated graceful hangup" },
  { action: "complete_acw", label: "Complete ACW", desc: "Complete after-call work (disposition)" },
  // Business hours / voicemail / callback
  { action: "wait_for_disconnect", label: "Wait for Disconnect", desc: "Wait for system to disconnect the call" },
  { action: "wait_for_voicemail_prompt", label: "Wait for VM Prompt", desc: "Wait for voicemail beep/tone" },
  { action: "leave_voicemail", label: "Leave Voicemail", desc: "Inject audio as voicemail message" },
  { action: "request_callback", label: "Request Callback", desc: "Caller requests a callback via IVR" },
  { action: "verify_callback_created", label: "Verify Callback", desc: "Assert callback task was created" },
  { action: "verify_voicemail_created", label: "Verify Voicemail", desc: "Assert voicemail record was created" },
  { action: "verify_business_hours_routing", label: "Verify Hours Routing", desc: "Assert call routed based on business hours" },
  // Utility
  { action: "wait", label: "Wait", desc: "Pause for a configurable duration" },
];

// ── API ─────────────────────────────────────────────────────────────────────

async function api(endpoint, opts = {}) {
  const res = await fetch(`/api${endpoint}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  return res.json();
}

// ── Init ────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  await loadSuites();
  bindGlobalEvents();
});

async function loadSuites() {
  const data = await api("/suites");
  state.suites = data.suites || [];

  const sel = document.getElementById("suite-selector");
  sel.innerHTML = '<option value="">— Select a Suite —</option>';
  state.suites.forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s.file;
    opt.textContent = `${s.name} (${s.scenarioCount} scenarios)`;
    sel.appendChild(opt);
  });

  // Auto-select v2 suite if available
  const v2 = state.suites.find((s) => s.version === 2);
  if (v2) {
    sel.value = v2.file;
    await loadSuite(v2.file);
  }
}

async function loadSuite(file) {
  if (!file) {
    state.currentSuiteFile = "";
    state.currentSuite = null;
    renderScenarioList();
    return;
  }
  state.currentSuiteFile = file;
  state.currentSuite = await api(`/suite?file=${encodeURIComponent(file)}`);
  renderScenarioList();
}

// ── Events ──────────────────────────────────────────────────────────────────

function bindGlobalEvents() {
  document.getElementById("suite-selector").addEventListener("change", (e) => {
    loadSuite(e.target.value);
  });

  document.getElementById("btn-new-scenario").addEventListener("click", startNewScenario);
  document.getElementById("btn-start-new").addEventListener("click", startNewScenario);
  document.getElementById("btn-start-edit").addEventListener("click", () => {
    if (!state.currentSuite?.scenarios?.length) {
      toast("Load a suite first", "error");
      return;
    }
    const first = state.currentSuite.scenarios[0];
    startEditScenario(first);
  });

  document.getElementById("btn-cancel-edit").addEventListener("click", () => {
    state.editingScenarioId = null;
    showLanding();
    renderScenarioList();
  });

  document.getElementById("btn-back").addEventListener("click", wizardBack);
  document.getElementById("btn-next").addEventListener("click", wizardNext);
  document.getElementById("btn-preview").addEventListener("click", showPreview);
  document.getElementById("btn-close-preview").addEventListener("click", closePreview);
  document.getElementById("btn-back-to-edit").addEventListener("click", closePreview);
  document.getElementById("btn-copy-json").addEventListener("click", copyJson);
  document.getElementById("btn-save-scenario").addEventListener("click", saveScenario);
  document.getElementById("btn-env-preview").addEventListener("click", showEnvPreview);

  // Preview tabs
  document.querySelectorAll(".preview-tab").forEach((tab) => {
    tab.addEventListener("click", () => switchPreviewTab(tab.dataset.tab));
  });

  // Run panel
  document.getElementById("btn-run-suite").addEventListener("click", () => openRunPanel(false));
  document.getElementById("btn-run-dry").addEventListener("click", () => startRun(true));
  document.getElementById("btn-run-stop").addEventListener("click", stopRun);
  document.getElementById("btn-run-close").addEventListener("click", closeRunPanel);
  document.getElementById("btn-run-clear").addEventListener("click", clearRunTerminal);
  document.getElementById("btn-run-rerun").addEventListener("click", () => startRun(false));
}

// ── Scenario List ───────────────────────────────────────────────────────────

function renderScenarioList() {
  const list = document.getElementById("scenario-list");
  const scenarios = state.currentSuite?.scenarios || [];

  if (scenarios.length === 0) {
    list.innerHTML = '<div class="empty-state">No scenarios yet. Click "+ New" to create one.</div>';
    return;
  }

  list.innerHTML = scenarios
    .map((s) => {
      const badges = [];
      const steps = s.steps || [];
      badges.push(`<span class="badge badge-step">${steps.length} steps</span>`);
      if (steps.some((st) => st.action === "start_supervisor")) {
        badges.push('<span class="badge badge-supervisor">supervisor</span>');
      }
      if (s.callTrigger?.ivrDigits) {
        badges.push(`<span class="badge badge-ivr">IVR ${s.callTrigger.ivrDigits}</span>`);
      }
      if (steps.some((st) => ["hold_call", "end_call", "play_agent_audio", "complete_acw"].includes(st.action))) {
        badges.push('<span class="badge badge-convo">conversation</span>');
      }
      if (s.callTrigger?.routingType === "skill" || s.callTrigger?.requiredSkills?.length > 0) {
        const skillName = s.callTrigger.requiredSkills?.[0]?.name || "skill";
        badges.push(`<span class="badge badge-skill">${esc(skillName)}</span>`);
      }
      if (s.callTrigger?.routingType === "extension") {
        badges.push(`<span class="badge badge-ext">ext ${esc(s.callTrigger.extension || "")}</span>`);
      }
      // Call outcome badges
      if (s.callTrigger?.noAgentBehavior === "voicemail" || steps.some((st) => st.action === "leave_voicemail")) {
        badges.push('<span class="badge badge-voicemail">voicemail</span>');
      }
      if (s.callTrigger?.noAgentBehavior === "callback" || steps.some((st) => st.action === "request_callback")) {
        badges.push('<span class="badge badge-callback">callback</span>');
      }
      if (s.callTrigger?.callTiming?.window === "after_hours" || s.callTrigger?.noAgentBehavior === "prompt_and_disconnect") {
        badges.push('<span class="badge badge-closed">closed hours</span>');
      }
      if (steps.some((st) => st.action === "listen_for_prompt")) {
        badges.push('<span class="badge badge-prompt">prompt</span>');
      }
      if (s.enabled === false) {
        badges.push('<span class="badge badge-inactive">inactive</span>');
      } else if (s.allowFailure) {
        badges.push('<span class="badge badge-allow-fail">soft fail</span>');
      } else {
        badges.push('<span class="badge badge-active">active</span>');
      }
      const isActive = s.id === state.editingScenarioId;
      const isDisabled = s.enabled === false;
      // Build a short NL tooltip
      const nlTip = scenarioToNaturalLanguage(s).replace(/"/g, "&quot;").replace(/\n/g, "&#10;");
      return `
        <div class="scenario-card ${isActive ? "active" : ""} ${isDisabled ? "disabled" : ""}" data-id="${s.id}" title="${nlTip}">
          <div class="sc-top-row">
            <div class="sc-id">${s.id}</div>
            <div class="sc-actions">
              <button class="sc-btn sc-btn-edit" data-action="edit" data-id="${s.id}" title="Edit scenario">&#x270E;</button>
              <button class="sc-btn sc-btn-delete" data-action="delete" data-id="${s.id}" title="Delete scenario">&#x2715;</button>
            </div>
          </div>
          <div class="sc-desc">${s.description || ""}</div>
          <div class="sc-badges">${badges.join("")}</div>
        </div>
      `;
    })
    .join("");

  // Click anywhere on card -> edit
  list.querySelectorAll(".scenario-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest('[data-action="delete"]')) return;
      const id = card.dataset.id;
      const scenario = scenarios.find((s) => s.id === id);
      if (scenario) startEditScenario(scenario);
    });
  });

  // Delete buttons
  list.querySelectorAll('[data-action="delete"]').forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (!confirm(`Delete scenario "${id}"?`)) return;
      try {
        await api("/scenario", {
          method: "DELETE",
          body: JSON.stringify({ scenarioId: id, suiteFile: state.currentSuiteFile }),
        });
        toast(`Deleted "${id}"`, "success");
        if (state.editingScenarioId === id) {
          state.editingScenarioId = null;
          showLanding();
        }
        await loadSuite(state.currentSuiteFile);
      } catch (err) {
        toast("Delete failed", "error");
      }
    });
  });
}

// ── Wizard: Start / Edit ────────────────────────────────────────────────────

function defaultAnswers() {
  return {
    // Call setup
    entryNumber: "+18005550199",
    callMode: "connect_ccp",
    // IVR
    hasIvr: false,
    ivrDigits: "",
    ivrDelayMs: 4000,
    ivrInterDigitDelayMs: 450,
    ivrLevels: [{ digits: "", label: "", delaySec: 4 }],
    // Routing
    targetQueue: "",
    routeType: "direct",
    // Skill-based routing
    routingSkills: [],
    targetAgent: "",
    extension: "",
    // Call outcome
    callOutcome: "agent_answer",
    // Business hours
    callTiming: "now",
    // Voicemail
    voicemailEnabled: false,
    voicemailText: "Hi, I am calling about my account. Please call me back.",
    voicemailDurationSec: 8,
    // Callback
    callbackEnabled: false,
    callbackPhone: "",
    // Prompt verification
    verifyGreeting: false,
    greetingText: "thank you for calling",
    verifyClosedMessage: false,
    closedMessageText: "office is currently closed",
    // Agent
    expectScreenPop: true,
    expectTranscript: false,
    transcriptPhrase: "",
    transcriptTimeout: 30,
    // Conversation (post-accept)
    conversationEnabled: false,
    agentSpeaks: false,
    agentSpeechText: "Hello, thank you for calling. How can I help you?",
    agentVoice: "Samantha",
    callerSpeaks: false,
    callerSpeechText: "I need help with my account",
    callerVoice: "Alex",
    verifyConvoTranscript: false,
    convoTranscriptPhrase: "",
    convoTranscriptTimeout: 30,
    testHoldResume: false,
    holdDurationSec: 5,
    agentEndsCall: false,
    completeAcw: false,
    acwDisposition: "Resolved",
    acwNotes: "",
    // Supervisor
    supervisorEnabled: false,
    observeAgentOffer: false,
    supervisorSurface: "Command Center for Service",
    supervisorCheckBeforeAccept: true,
    // Details
    description: "",
    id: "",
    ringTimeout: 90,
    allowFailure: false,
    enabled: true,
    // Advanced: custom steps (null = auto-generate, array = manual override)
    customSteps: null,
  };
}

function startNewScenario() {
  state.editingScenarioId = null;
  state.answers = defaultAnswers();
  state.wizardStep = 0;
  showWizard();
}

function startEditScenario(scenario) {
  state.editingScenarioId = scenario.id;
  state.answers = scenarioToAnswers(scenario);
  state.wizardStep = 0;
  showWizard();
  renderScenarioList();
}

function scenarioToAnswers(s) {
  const ct = s.callTrigger || {};
  const steps = s.steps || [];
  const supStep = steps.find((st) => st.action === "start_supervisor");
  const detectStep = steps.find((st) => st.action === "detect_incoming");
  const transcriptStep = steps.find((st) => st.action === "verify_transcript");
  const t = s.timeouts || {};

  // Detect call outcome from callTrigger and step patterns
  const vmStep = steps.find((st) => st.action === "leave_voicemail");
  const cbStep = steps.find((st) => st.action === "request_callback");
  const disconnectStep = steps.find((st) => st.action === "wait_for_disconnect");
  const listenSteps = steps.filter((st) => st.action === "listen_for_prompt");
  const hasClosedPrompt = listenSteps.some((st) => /closed/i.test(st.promptText || ""));
  const isClosedHours = ct.noAgentBehavior === "prompt_and_disconnect" || (ct.callTiming?.window === "after_hours") || (hasClosedPrompt && disconnectStep && !vmStep && !cbStep);
  const isVoicemail = ct.noAgentBehavior === "voicemail" || !!vmStep;
  const isCallback = ct.noAgentBehavior === "callback" || !!cbStep;
  let callOutcome = "agent_answer";
  if (isClosedHours) callOutcome = "closed_hours";
  else if (isVoicemail) callOutcome = "voicemail";
  else if (isCallback) callOutcome = "callback";

  // Parse conversation steps
  const agentAudioStep = steps.find((st) => st.action === "play_agent_audio");
  const callerAudioStep = steps.find((st) => st.action === "play_caller_audio");
  const convoTranscriptStep = steps.find((st) => st.action === "wait_for_transcript");
  const holdStep = steps.find((st) => st.action === "hold_call");
  const endCallStep = steps.find((st) => st.action === "end_call");
  const acwStep = steps.find((st) => st.action === "complete_acw");
  const hasConversation = !!(agentAudioStep || callerAudioStep || holdStep || endCallStep || acwStep);

  // Parse IVR levels from steps
  const dtmfSteps = steps.filter((st) => st.action === "send_dtmf_sequence");
  let ivrLevels = [{ digits: "", label: "", delaySec: 4 }];
  if (dtmfSteps.length > 0) {
    ivrLevels = dtmfSteps.map((st) => ({
      digits: st.digits || "",
      label: st.label || "",
      delaySec: Math.round((st.delayBeforeMs || 4000) / 1000),
    }));
  } else if (ct.ivrDigits) {
    // Single-level IVR from callTrigger
    ivrLevels = [{ digits: ct.ivrDigits, label: "", delaySec: Math.round((ct.ivrInitialDelayMs || 4000) / 1000) }];
  }

  // Parse greeting prompts
  const greetingPrompt = listenSteps.find((st) => st.promptText && !/closed|leave a message|request a callback|we will call/i.test(st.promptText));
  const closedPrompt = listenSteps.find((st) => /closed/i.test(st.promptText || ""));

  return {
    entryNumber: ct.entryNumber || "+18005550199",
    callMode: ct.mode || "connect_ccp",
    hasIvr: !!(ct.ivrDigits || ct.ivrDigits === "" && supStep) || dtmfSteps.length > 0,
    ivrDigits: ct.ivrDigits || "",
    ivrDelayMs: ct.ivrInitialDelayMs || 4000,
    ivrInterDigitDelayMs: ct.ivrInterDigitDelayMs || 450,
    ivrLevels,
    targetQueue: supStep?.queue || "",
    routeType: ct.routingType || (supStep?.skill ? "skill" : supStep?.queue ? "queue" : ct.extension ? "extension" : ct.targetAgent ? "direct" : "direct"),
    routingSkills: ct.requiredSkills || (supStep?.skill ? [{ name: supStep.skill, minLevel: supStep.skillLevel || 1 }] : []),
    targetAgent: ct.targetAgent || "",
    extension: ct.extension || "",
    // Call outcome
    callOutcome,
    callTiming: ct.callTiming?.window || "now",
    // Voicemail
    voicemailText: vmStep?.voicemailText || "Hi, I am calling about my account. Please call me back.",
    voicemailDurationSec: vmStep?.voicemailDurationSec || 8,
    // Callback
    callbackPhone: cbStep?.callbackPhone || "",
    // Closed hours
    closedMessageText: closedPrompt?.promptText || "office is currently closed",
    // Greeting verification
    verifyGreeting: !!greetingPrompt,
    greetingText: greetingPrompt?.promptText || "thank you for calling",
    // Agent
    expectScreenPop: steps.some((st) => st.action === "verify_screen_pop"),
    expectTranscript: !!transcriptStep,
    transcriptPhrase: transcriptStep?.expectPhrase || "",
    transcriptTimeout: transcriptStep?.timeoutSec || 30,
    // Conversation
    conversationEnabled: hasConversation,
    agentSpeaks: !!agentAudioStep,
    agentSpeechText: agentAudioStep?.text || "Hello, thank you for calling. How can I help you?",
    agentVoice: agentAudioStep?.voice || "Samantha",
    callerSpeaks: !!callerAudioStep,
    callerSpeechText: callerAudioStep?.text || "I need help with my account",
    callerVoice: callerAudioStep?.voice || "Alex",
    verifyConvoTranscript: !!convoTranscriptStep,
    convoTranscriptPhrase: convoTranscriptStep?.contains || "",
    convoTranscriptTimeout: convoTranscriptStep?.timeoutSec || 30,
    testHoldResume: !!holdStep,
    holdDurationSec: steps.find((st) => st.action === "wait" && steps.indexOf(st) > steps.indexOf(holdStep))?.seconds || 5,
    agentEndsCall: !!endCallStep,
    completeAcw: !!acwStep,
    acwDisposition: acwStep?.disposition || "Resolved",
    acwNotes: acwStep?.notes || "",
    // Supervisor
    supervisorEnabled: !!supStep,
    observeAgentOffer: supStep?.observeAgentOffer || false,
    supervisorSurface: supStep?.surface || "Command Center for Service",
    supervisorCheckBeforeAccept: supStep?.checkBeforeAccept ?? true,
    // Details
    description: s.description || "",
    id: s.id || "",
    ringTimeout: detectStep?.timeoutSec || t.ringSec || 90,
    allowFailure: !!s.allowFailure,
    enabled: s.enabled !== false,
    customSteps: null,
  };
}

// ── Wizard: Show / Hide ─────────────────────────────────────────────────────

function showWizard() {
  document.getElementById("landing").classList.add("hidden");
  document.getElementById("wizard").classList.remove("hidden");
  document.getElementById("preview-panel").classList.add("hidden");

  const banner = document.getElementById("editing-banner");
  if (state.editingScenarioId) {
    banner.classList.remove("hidden");
    document.getElementById("editing-name").textContent = state.editingScenarioId;
  } else {
    banner.classList.add("hidden");
  }

  renderWizardStep();
  updateProgress();
  updateLiveFlow();
}

function showLanding() {
  document.getElementById("landing").classList.remove("hidden");
  document.getElementById("wizard").classList.add("hidden");
  document.getElementById("preview-panel").classList.add("hidden");
  document.getElementById("run-panel").classList.add("hidden");
}

// ── Wizard: Navigation ──────────────────────────────────────────────────────

function shouldSkipStep(stepId) {
  const a = state.answers;
  const noAgent = a.callOutcome && a.callOutcome !== "agent_answer";
  // For non-agent outcomes (voicemail, callback, closed hours), skip agent/conversation/supervisor
  if (noAgent && (stepId === "agent" || stepId === "conversation" || stepId === "supervisor")) return true;
  if (stepId === "conversation" && !a.conversationEnabled) return true;
  if (stepId === "supervisor" && !a.supervisorEnabled && !a.targetQueue) return true;
  return false;
}

function wizardBack() {
  if (state.wizardStep > 0) {
    let target = state.wizardStep - 1;
    while (target > 0 && shouldSkipStep(STEPS[target].id)) {
      target--;
    }
    state.wizardStep = Math.max(0, target);
    renderWizardStep();
    updateProgress();
  }
}

function wizardNext() {
  collectCurrentStepAnswers();

  if (state.wizardStep < STEPS.length - 1) {
    let target = state.wizardStep + 1;
    while (target < STEPS.length - 1 && shouldSkipStep(STEPS[target].id)) {
      target++;
    }
    state.wizardStep = Math.min(STEPS.length - 1, target);
    renderWizardStep();
    updateProgress();
    updateLiveFlow();
  } else {
    showPreview();
  }
}

function collectCurrentStepAnswers() {
  const stepId = STEPS[state.wizardStep].id;

  switch (stepId) {
    case "call":
      state.answers.entryNumber = val("entry-number") || state.answers.entryNumber;
      state.answers.callMode = getSelectedOption("call-mode") || state.answers.callMode;
      state.answers.callOutcome = getSelectedOption("call-outcome") || state.answers.callOutcome;
      // Voicemail fields
      state.answers.voicemailText = val("voicemail-text") || state.answers.voicemailText;
      state.answers.voicemailDurationSec = parseInt(val("voicemail-duration") || String(state.answers.voicemailDurationSec), 10);
      // Callback fields
      state.answers.callbackPhone = val("callback-phone") || state.answers.callbackPhone;
      // Closed hours fields
      state.answers.closedMessageText = val("closed-message-text") || state.answers.closedMessageText;
      // Greeting verification
      state.answers.verifyGreeting = isChecked("verify-greeting");
      state.answers.greetingText = val("greeting-text") || state.answers.greetingText;
      break;

    case "ivr":
      state.answers.hasIvr = isChecked("has-ivr");
      state.answers.routeType = getSelectedOption("route-type") || state.answers.routeType;
      state.answers.targetQueue = val("target-queue");
      state.answers.targetAgent = val("target-agent") || state.answers.targetAgent;
      state.answers.extension = val("extension-number") || state.answers.extension;
      // Collect skills
      if (state.answers.routeType === "skill") {
        collectSkills();
      }
      // Collect IVR levels
      if (state.answers.hasIvr) {
        collectIvrLevels();
        // Sync ivrDigits from levels
        state.answers.ivrDigits = state.answers.ivrLevels
          .map((l) => l.digits)
          .filter(Boolean)
          .join("");
        state.answers.ivrDelayMs = (state.answers.ivrLevels[0]?.delaySec || 4) * 1000;
      }
      break;

    case "agent":
      state.answers.expectScreenPop = isChecked("expect-screenpop");
      state.answers.expectTranscript = isChecked("expect-transcript");
      state.answers.transcriptPhrase = val("transcript-phrase");
      state.answers.transcriptTimeout = parseInt(val("transcript-timeout") || "30", 10);
      state.answers.conversationEnabled = isChecked("conversation-enabled");
      break;

    case "conversation":
      state.answers.agentSpeaks = isChecked("agent-speaks");
      state.answers.agentSpeechText = val("agent-speech-text") || state.answers.agentSpeechText;
      state.answers.agentVoice = val("agent-voice") || state.answers.agentVoice;
      state.answers.callerSpeaks = isChecked("caller-speaks");
      state.answers.callerSpeechText = val("caller-speech-text") || state.answers.callerSpeechText;
      state.answers.callerVoice = val("caller-voice") || state.answers.callerVoice;
      state.answers.verifyConvoTranscript = isChecked("verify-convo-transcript");
      state.answers.convoTranscriptPhrase = val("convo-transcript-phrase");
      state.answers.convoTranscriptTimeout = parseInt(val("convo-transcript-timeout") || "30", 10);
      state.answers.testHoldResume = isChecked("test-hold-resume");
      state.answers.holdDurationSec = parseInt(val("hold-duration") || "5", 10);
      state.answers.agentEndsCall = isChecked("agent-ends-call");
      state.answers.completeAcw = isChecked("complete-acw");
      state.answers.acwDisposition = val("acw-disposition") || state.answers.acwDisposition;
      state.answers.acwNotes = val("acw-notes");
      break;

    case "supervisor":
      state.answers.supervisorEnabled = isChecked("supervisor-enabled");
      state.answers.observeAgentOffer = isChecked("observe-agent-offer");
      state.answers.supervisorSurface = val("supervisor-surface") || "Command Center for Service";
      state.answers.supervisorCheckBeforeAccept = isChecked("supervisor-check-before");
      break;

    case "details": {
      state.answers.description = val("scenario-desc");
      state.answers.id = val("scenario-id");
      state.answers.ringTimeout = parseInt(val("ring-timeout") || "90", 10);
      const execStatus = getSelectedOption("exec-status") || "active";
      state.answers.allowFailure = execStatus === "soft-fail";
      state.answers.enabled = execStatus !== "inactive";
      break;
    }
  }
}

function collectIvrLevels() {
  const container = document.getElementById("ivr-levels-container");
  if (!container) return;
  const rows = container.querySelectorAll(".ivr-fc-level");
  const levels = [];
  rows.forEach((row) => {
    levels.push({
      digits: row.querySelector(".ivr-level-digits")?.value.trim() || "",
      label: row.querySelector(".ivr-level-label")?.value.trim() || "",
      delaySec: parseInt(row.querySelector(".ivr-level-delay")?.value || "4", 10),
    });
  });
  if (levels.length > 0) {
    state.answers.ivrLevels = levels;
  }
}

// ── Wizard: Step Renderers ──────────────────────────────────────────────────

function renderWizardStep() {
  const container = document.getElementById("wizard-step-container");
  const stepId = STEPS[state.wizardStep].id;

  const btnNext = document.getElementById("btn-next");
  const btnBack = document.getElementById("btn-back");
  btnBack.disabled = state.wizardStep === 0;
  btnNext.textContent = state.wizardStep === STEPS.length - 1 ? "Preview & Save" : "Next";

  switch (stepId) {
    case "call":
      container.innerHTML = renderCallStep();
      bindCallOutcomeCards();
      break;
    case "ivr":
      container.innerHTML = renderIvrStep();
      bindIvrToggle();
      break;
    case "agent":
      container.innerHTML = renderAgentStep();
      bindTranscriptToggle();
      break;
    case "conversation":
      container.innerHTML = renderConversationStep();
      bindConversationToggles();
      break;
    case "supervisor":
      container.innerHTML = renderSupervisorStep();
      bindSupervisorToggle();
      break;
    case "details":
      container.innerHTML = renderDetailsStep();
      bindAutoSlug();
      break;
    case "review":
      container.innerHTML = renderReviewStep();
      bindAdvancedStepEditor();
      break;
  }

  // Bind option cards
  container.querySelectorAll(".option-cards").forEach((group) => {
    group.querySelectorAll(".option-card").forEach((card) => {
      card.addEventListener("click", () => {
        group.querySelectorAll(".option-card").forEach((c) => c.classList.remove("selected"));
        card.classList.add("selected");
      });
    });
  });
}

function renderCallStep() {
  const a = state.answers;
  const showVoicemail = a.callOutcome === "voicemail";
  const showCallback = a.callOutcome === "callback";
  const showClosed = a.callOutcome === "closed_hours";
  const showPromptFields = a.callOutcome !== "agent_answer";
  return `
    <div class="wizard-step">
      <div class="step-header">
        <h2>Incoming Call Setup</h2>
        <p>What number does the caller dial, and what should happen?</p>
      </div>

      <div class="form-group">
        <label class="form-label">Entry Point Number</label>
        <input class="form-input" id="entry-number" type="tel"
               placeholder="+18005550199" value="${esc(a.entryNumber)}" />
        <div class="form-hint">The phone number the caller dials to reach your contact center</div>
      </div>

      <div class="form-group">
        <label class="form-label">How is the call placed?</label>
        <div class="option-cards" data-name="call-mode">
          ${optionCard("connect_ccp", "CCP Softphone", "Automated via Amazon Connect CCP panel", a.callMode === "connect_ccp")}
          ${optionCard("twilio", "Twilio API", "Call placed via Twilio programmable voice", a.callMode === "twilio")}
          ${optionCard("manual", "Manual Dial", "Tester dials from a real phone", a.callMode === "manual")}
        </div>
      </div>

      <div class="section-divider"></div>

      <div class="form-group">
        <label class="form-label">Expected Call Outcome</label>
        <div class="form-hint" style="margin-bottom: 8px;">What should happen when the call reaches your contact center?</div>
        <div class="option-cards" data-name="call-outcome">
          ${optionCard("agent_answer", "Agent Answers", "Call is routed to an agent who accepts it", a.callOutcome === "agent_answer")}
          ${optionCard("voicemail", "Voicemail", "No agent available — caller leaves voicemail", a.callOutcome === "voicemail")}
          ${optionCard("callback", "Callback", "Caller requests a callback instead of waiting", a.callOutcome === "callback")}
          ${optionCard("closed_hours", "Closed Hours", "Call outside business hours — plays closed message", a.callOutcome === "closed_hours")}
        </div>
      </div>

      <div id="voicemail-fields" class="${showVoicemail ? "" : "hidden"}">
        <div class="form-group">
          <label class="form-label">Voicemail Message</label>
          <textarea class="form-input" id="voicemail-text" rows="2"
                    placeholder="Hi, I am calling about my account...">${esc(a.voicemailText)}</textarea>
          <div class="form-hint">Text that will be converted to speech and left as voicemail</div>
        </div>
        <div class="form-group">
          <label class="form-label">Voicemail Duration (sec)</label>
          <input class="form-input" id="voicemail-duration" type="number" min="3" max="120"
                 value="${a.voicemailDurationSec}" style="width: 100px;" />
        </div>
      </div>

      <div id="callback-fields" class="${showCallback ? "" : "hidden"}">
        <div class="form-group">
          <label class="form-label">Callback Phone <span class="optional">(optional)</span></label>
          <input class="form-input" id="callback-phone" type="tel"
                 placeholder="Same as entry number" value="${esc(a.callbackPhone)}" />
          <div class="form-hint">Number for the system to call back — defaults to caller's number</div>
        </div>
      </div>

      <div id="closed-hours-fields" class="${showClosed ? "" : "hidden"}">
        <div class="form-group">
          <label class="form-label">Closed Message Text</label>
          <input class="form-input" id="closed-message-text"
                 placeholder="office is currently closed"
                 value="${esc(a.closedMessageText)}" />
          <div class="form-hint">Expected text in the closed-hours announcement (for transcript matching)</div>
        </div>
      </div>

      <div id="prompt-verify-fields" class="${showPromptFields ? "" : "hidden"}">
      </div>

      <div class="toggle-row" style="margin-top: 12px;">
        <div>
          <div class="tr-label">Verify Greeting Prompt</div>
          <div class="tr-desc">Check that the IVR greeting plays the expected message</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="verify-greeting" ${a.verifyGreeting ? "checked" : ""} />
          <span class="slider"></span>
        </label>
      </div>
      <div class="indent-group ${a.verifyGreeting ? "" : "hidden"}" id="greeting-text-field">
        <div class="form-group">
          <label class="form-label">Expected Greeting Text</label>
          <input class="form-input" id="greeting-text"
                 placeholder="thank you for calling"
                 value="${esc(a.greetingText)}" />
        </div>
      </div>
    </div>
  `;
}

function bindCallOutcomeCards() {
  // Call outcome card toggling — show/hide voicemail, callback, closed hours fields
  const outcomeCards = document.querySelectorAll('[data-name="call-outcome"] .option-card');
  outcomeCards.forEach((card) => {
    card.addEventListener("click", () => {
      const outcome = card.dataset.value;
      document.getElementById("voicemail-fields").classList.toggle("hidden", outcome !== "voicemail");
      document.getElementById("callback-fields").classList.toggle("hidden", outcome !== "callback");
      document.getElementById("closed-hours-fields").classList.toggle("hidden", outcome !== "closed_hours");
      document.getElementById("prompt-verify-fields").classList.toggle("hidden", outcome === "agent_answer");
    });
  });

  // Greeting verification toggle
  const greetingToggle = document.getElementById("verify-greeting");
  if (greetingToggle) {
    greetingToggle.addEventListener("change", () => {
      const field = document.getElementById("greeting-text-field");
      if (field) field.classList.toggle("hidden", !greetingToggle.checked);
    });
  }
}

function renderIvrStep() {
  const a = state.answers;
  const showIvrFields = a.hasIvr;
  const showQueueField = a.routeType === "queue" || a.hasIvr;

  return `
    <div class="wizard-step">
      <div class="step-header">
        <h2>IVR & Call Routing</h2>
        <p>Does the caller interact with an IVR menu? Where should the call land?</p>
      </div>

      <div class="toggle-row">
        <div>
          <div class="tr-label">IVR Menu</div>
          <div class="tr-desc">Caller hears an automated menu and presses digits</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="has-ivr" ${a.hasIvr ? "checked" : ""} />
          <span class="slider"></span>
        </label>
      </div>

      <div id="ivr-fields" class="${showIvrFields ? "" : "hidden"}">
        <div class="form-group">
          <label class="form-label">IVR Menu Navigation</label>
          <div class="form-hint" style="margin-bottom: 10px;">
            Define how the caller navigates through IVR menus to reach the target queue.<br/>
            Each level = one menu the caller hears and responds to. Multiple levels mean nested menus<br/>
            (e.g. "Press 1 for English" → "Press 3 for Billing" → lands in Billing Queue).
          </div>
          <div id="ivr-levels-container" class="ivr-flowchart">
            ${renderIvrFlowchart(a.ivrLevels, a.entryNumber, a.targetQueue)}
          </div>
        </div>
      </div>

      <div id="no-ivr-routing" class="${showIvrFields ? "hidden" : ""}">
        <div class="form-group">
          <label class="form-label">Call Routing</label>
          <div class="option-cards" data-name="route-type">
            ${optionCard("direct", "Direct to Agent", "Call goes straight to the available agent", a.routeType === "direct")}
            ${optionCard("queue", "Via Queue", "Call enters a queue before reaching agent", a.routeType === "queue")}
            ${optionCard("skill", "Skill-Based", "Call routed to agent with matching skills", a.routeType === "skill")}
            ${optionCard("extension", "Extension", "Caller dials an extension number", a.routeType === "extension")}
          </div>
        </div>
      </div>

      <div class="form-group ${showQueueField ? "" : "hidden"}" id="queue-field">
        <label class="form-label">Target Queue Name</label>
        <input class="form-input" id="target-queue" placeholder="Support Queue"
               value="${esc(a.targetQueue)}" />
        <div class="form-hint">The queue name as it appears in your org (auto-detected during preflight)</div>
      </div>

      <div class="form-group ${a.routeType === "skill" ? "" : "hidden"}" id="skill-routing-fields">
        <label class="form-label">Required Skills</label>
        <div class="form-hint" style="margin-bottom: 10px;">
          Specify one or more skills the agent must have to receive this call.<br/>
          Skills are auto-discovered from your Salesforce org during preflight.
        </div>
        <div id="skills-container">
          ${(a.routingSkills.length > 0 ? a.routingSkills : [{ name: "", minLevel: 1 }])
            .map((sk, i) => renderSkillRow(sk, i))
            .join("")}
        </div>
        <button class="btn btn-outline btn-sm" id="btn-add-skill" style="margin-top: 8px;">+ Add Skill</button>
      </div>

      <div class="form-group ${a.routeType === "direct" ? "" : "hidden"}" id="direct-agent-field">
        <label class="form-label">Target Agent <span class="optional">(optional)</span></label>
        <input class="form-input" id="target-agent" placeholder="agent@company.com"
               value="${esc(a.targetAgent)}" />
        <div class="form-hint">Agent username — leave blank to route to any available agent</div>
      </div>

      <div class="form-group ${a.routeType === "extension" ? "" : "hidden"}" id="extension-field">
        <label class="form-label">Extension Number</label>
        <input class="form-input" id="extension-number" placeholder="2001"
               value="${esc(a.extension)}" />
        <div class="form-hint">The extension the caller dials after connecting</div>
      </div>
    </div>
  `;
}

function renderIvrFlowchartNode(level, index, totalLevels) {
  const showRemove = totalLevels > 1;
  return `
    <div class="ivr-fc-node ivr-fc-level" data-index="${index}">
      <div class="ivr-fc-accent"></div>
      <div class="ivr-fc-icon">#</div>
      <div class="ivr-fc-body">
        <div class="ivr-fc-node-header">
          <span class="ivr-fc-node-num">Level ${index + 1}</span>
          ${showRemove ? `<button class="btn btn-ghost btn-sm ivr-fc-remove" data-index="${index}">Remove</button>` : ""}
        </div>
        <div class="ivr-fc-fields">
          <div class="ivr-fc-field">
            <label>Digits</label>
            <input class="form-input ivr-level-digits" placeholder="1" value="${esc(level.digits)}" maxlength="10" />
          </div>
          <div class="ivr-fc-field ivr-fc-field-grow">
            <label>Label <span class="optional">(optional)</span></label>
            <input class="form-input ivr-level-label" placeholder="e.g. English, Billing" value="${esc(level.label)}" />
          </div>
          <div class="ivr-fc-field ivr-fc-field-sm">
            <label>Wait (sec)</label>
            <input class="form-input ivr-level-delay" type="number" min="0" max="30" value="${level.delaySec}" />
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderIvrFlowchart(levels, entryNumber, targetQueue) {
  const total = levels.length;

  const startNode = `
    <div class="ivr-fc-node ivr-fc-start">
      <div class="ivr-fc-accent"></div>
      <div class="ivr-fc-icon">&#x260E;</div>
      <div class="ivr-fc-body">
        <div class="ivr-fc-title">Caller Dials</div>
        <div class="ivr-fc-detail">${esc(entryNumber || "+18005550199")}</div>
      </div>
    </div>
  `;

  const levelNodes = levels.map((lvl, i) => {
    const node = renderIvrFlowchartNode(lvl, i, total);
    const addBtn = `
      <div class="ivr-fc-connector"></div>
      <button class="ivr-fc-add-btn" data-insert-after="${i}" title="Add level after Level ${i + 1}">
        <span class="ivr-fc-add-icon">+</span>
      </button>
    `;
    return `<div class="ivr-fc-connector"></div>${node}${addBtn}`;
  }).join("");

  const queueLabel = targetQueue ? esc(targetQueue) : "Set below";
  const endNode = `
    <div class="ivr-fc-connector"></div>
    <div class="ivr-fc-node ivr-fc-end">
      <div class="ivr-fc-accent"></div>
      <div class="ivr-fc-icon">&#x2611;</div>
      <div class="ivr-fc-body">
        <div class="ivr-fc-title">Target Queue</div>
        <div class="ivr-fc-detail">${queueLabel}</div>
      </div>
    </div>
  `;

  return startNode + levelNodes + endNode;
}

function bindIvrToggle() {
  const toggle = document.getElementById("has-ivr");
  if (!toggle) return;
  toggle.addEventListener("change", () => {
    const on = toggle.checked;
    document.getElementById("ivr-fields").classList.toggle("hidden", !on);
    document.getElementById("no-ivr-routing").classList.toggle("hidden", on);
    const routeType = getSelectedOption("route-type");
    document.getElementById("queue-field").classList.toggle("hidden", !on && routeType !== "queue");
    if (on && !state.answers.supervisorEnabled) {
      state.answers.supervisorEnabled = true;
    }
  });

  // Route-type option cards
  const routeCards = document.querySelectorAll('[data-name="route-type"] .option-card');
  routeCards.forEach((card) => {
    card.addEventListener("click", () => {
      const val = card.dataset.value;
      const queueField = document.getElementById("queue-field");
      const skillField = document.getElementById("skill-routing-fields");
      const directField = document.getElementById("direct-agent-field");
      const extensionField = document.getElementById("extension-field");
      if (queueField) queueField.classList.toggle("hidden", val !== "queue" && val !== "skill");
      if (skillField) skillField.classList.toggle("hidden", val !== "skill");
      if (directField) directField.classList.toggle("hidden", val !== "direct");
      if (extensionField) extensionField.classList.toggle("hidden", val !== "extension");
    });
  });

  // Add skill button
  const addSkillBtn = document.getElementById("btn-add-skill");
  if (addSkillBtn) {
    addSkillBtn.addEventListener("click", () => {
      collectSkills();
      state.answers.routingSkills.push({ name: "", minLevel: 1 });
      rerenderSkills();
    });
  }
  bindSkillRemove();

  // Bind flowchart add/remove events
  bindIvrFlowchartEvents();
}

function rerenderIvrLevels() {
  const container = document.getElementById("ivr-levels-container");
  if (!container) return;
  const a = state.answers;
  container.innerHTML = renderIvrFlowchart(a.ivrLevels, a.entryNumber, a.targetQueue);
  bindIvrFlowchartEvents();
}

function bindIvrFlowchartEvents() {
  // Remove buttons on level nodes
  document.querySelectorAll(".ivr-fc-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      collectIvrLevels();
      const idx = parseInt(btn.dataset.index, 10);
      state.answers.ivrLevels.splice(idx, 1);
      if (state.answers.ivrLevels.length === 0) {
        state.answers.ivrLevels = [{ digits: "", label: "", delaySec: 4 }];
      }
      rerenderIvrLevels();
    });
  });

  // Inline add buttons (insert level at position)
  document.querySelectorAll(".ivr-fc-add-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      collectIvrLevels();
      const afterIdx = parseInt(btn.dataset.insertAfter, 10);
      state.answers.ivrLevels.splice(afterIdx + 1, 0, { digits: "", label: "", delaySec: 2 });
      rerenderIvrLevels();
    });
  });
}

// ── Skill-Based Routing UI ──────────────────────────────────────────────────

function renderSkillRow(skill, index) {
  return `
    <div class="skill-row" data-index="${index}">
      <div class="skill-fields">
        <div class="skill-field">
          <label>Skill Name</label>
          <input class="form-input skill-name" placeholder="e.g. Spanish, Billing, Premium"
                 value="${esc(skill.name)}" />
        </div>
        <div class="skill-field skill-field-sm">
          <label>Min Level</label>
          <input class="form-input skill-level" type="number" min="1" max="10"
                 value="${skill.minLevel || 1}" />
        </div>
        <div class="skill-field skill-field-action">
          ${index > 0 ? `<button class="btn btn-ghost btn-sm skill-remove" data-index="${index}">Remove</button>` : ""}
        </div>
      </div>
    </div>
  `;
}

function collectSkills() {
  const rows = document.querySelectorAll(".skill-row");
  state.answers.routingSkills = Array.from(rows).map((row) => ({
    name: row.querySelector(".skill-name")?.value?.trim() || "",
    minLevel: parseInt(row.querySelector(".skill-level")?.value || "1", 10),
  }));
}

function rerenderSkills() {
  const container = document.getElementById("skills-container");
  if (!container) return;
  const skills = state.answers.routingSkills.length > 0
    ? state.answers.routingSkills
    : [{ name: "", minLevel: 1 }];
  container.innerHTML = skills.map((sk, i) => renderSkillRow(sk, i)).join("");
  bindSkillRemove();
}

function bindSkillRemove() {
  document.querySelectorAll(".skill-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      collectSkills();
      const idx = parseInt(btn.dataset.index, 10);
      state.answers.routingSkills.splice(idx, 1);
      if (state.answers.routingSkills.length === 0) {
        state.answers.routingSkills = [{ name: "", minLevel: 1 }];
      }
      rerenderSkills();
    });
  });
}

// renderIvrPathPreview — replaced by renderIvrFlowchart() above

// ── Natural Language Rule Translation ───────────────────────────────────────

function scenarioToNaturalLanguage(scenario) {
  const lines = [];
  const ct = scenario.callTrigger || {};
  const steps = scenario.steps || [];
  const expects = scenario.expect || [];

  // Scenario header
  lines.push(`Scenario: ${scenario.description || scenario.id}`);
  lines.push("");

  // Given — context
  const mode = ct.mode === "connect_ccp" ? "via CCP softphone"
    : ct.mode === "twilio" ? "via Twilio API"
    : "manually";
  lines.push(`Given a caller dials ${ct.entryNumber || "the entry number"} ${mode}`);

  // Business hours context
  if (ct.callTiming?.window === "after_hours") {
    lines.push(`And the call is placed outside business hours`);
  }

  // No-agent behavior context
  if (ct.noAgentBehavior === "voicemail") {
    lines.push(`And no agent is available to take the call`);
  } else if (ct.noAgentBehavior === "callback") {
    lines.push(`And the queue is full — no agent available`);
  }

  // Routing context
  if (ct.routingType === "skill" && ct.requiredSkills?.length > 0) {
    const skillNames = ct.requiredSkills.map((s) => {
      const level = s.minLevel > 1 ? ` (level ${s.minLevel}+)` : "";
      return `"${s.name}"${level}`;
    }).join(" and ");
    lines.push(`And the call requires agent skills: ${skillNames}`);
  } else if (ct.routingType === "direct_agent" && ct.targetAgent) {
    lines.push(`And the call is routed directly to agent "${ct.targetAgent}"`);
  } else if (ct.routingType === "extension" && ct.extension) {
    lines.push(`And the caller dials extension ${ct.extension}`);
  }

  // IVR navigation
  const dtmfSteps = steps.filter((s) => s.action === "send_dtmf_sequence");
  if (ct.ivrDigits && dtmfSteps.length === 0) {
    if (ct.ivrDigits === "") {
      lines.push(`And the caller does not press any digits (IVR timeout)`);
    } else {
      lines.push(`And the caller presses ${ct.ivrDigits} on the IVR menu`);
    }
  } else if (dtmfSteps.length > 0 || ct.ivrDigits) {
    if (ct.ivrDigits) {
      lines.push(`And the caller presses ${ct.ivrDigits} on the first IVR menu`);
    }
    dtmfSteps.forEach((s) => {
      const label = s.label ? ` for ${s.label}` : "";
      lines.push(`And waits for the next menu, then presses ${s.digits}${label}`);
    });
  }

  // When — actions
  lines.push("");

  const supStep = steps.find((s) => s.action === "start_supervisor");
  if (supStep) {
    const skillInfo = supStep.skill ? ` (skill: ${supStep.skill})` : "";
    lines.push(`When a supervisor opens ${supStep.surface || "Command Center"} to monitor "${supStep.queue || "incoming calls"}"${skillInfo}`);
  }

  lines.push(`When the call is placed and the system routes it`);

  // Prompt listening (IVR greeting, closed message, etc.)
  const listenSteps = steps.filter((s) => s.action === "listen_for_prompt");
  for (const ls of listenSteps) {
    lines.push(`And the system plays a prompt containing "${ls.promptText || "message"}"`);
  }

  // Voicemail
  const vmStep = steps.find((s) => s.action === "leave_voicemail");
  if (vmStep) {
    lines.push(`And the caller leaves a voicemail: "${vmStep.voicemailText || "message"}"`);
  }

  // Callback request
  const cbStep = steps.find((s) => s.action === "request_callback");
  if (cbStep) {
    lines.push(`And the caller requests a callback${cbStep.callbackPhone ? ` at ${cbStep.callbackPhone}` : ""}`);
  }

  // Wait for disconnect
  if (steps.some((s) => s.action === "wait_for_disconnect")) {
    lines.push(`And the system disconnects the call`);
  }

  const detectStep = steps.find((s) => s.action === "detect_incoming");
  if (detectStep) {
    lines.push(`And the agent waits for the incoming call (up to ${detectStep.timeoutSec || 90}s)`);
  }

  if (steps.some((s) => s.action === "accept_call")) {
    lines.push(`And the agent accepts the call`);
  }

  // Conversation
  const agentAudio = steps.find((s) => s.action === "play_agent_audio");
  if (agentAudio) {
    lines.push(`And the agent says "${agentAudio.text}"`);
  }

  const callerAudio = steps.find((s) => s.action === "play_caller_audio");
  if (callerAudio) {
    lines.push(`And the caller says "${callerAudio.text}"`);
  }

  const holdStep = steps.find((s) => s.action === "hold_call");
  if (holdStep) {
    const waitStep = steps.find((s, i) => s.action === "wait" && i > steps.indexOf(holdStep));
    lines.push(`And the agent puts the caller on hold for ${waitStep?.seconds || 5} seconds`);
    lines.push(`And the agent resumes the call`);
  }

  if (steps.some((s) => s.action === "end_call")) {
    lines.push(`And the agent ends the call`);
  }

  const acwStep = steps.find((s) => s.action === "complete_acw");
  if (acwStep) {
    lines.push(`And the agent completes after-call work${acwStep.disposition ? ` with disposition "${acwStep.disposition}"` : ""}`);
  }

  // Then — assertions
  lines.push("");

  for (const e of expects) {
    switch (e.type) {
      case "e2e.call_connected":
        lines.push(`Then the call should be connected successfully`);
        break;
      case "e2e.screen_pop_detected":
        lines.push(`And a VoiceCall record should appear as a screen pop`);
        break;
      case "e2e.supervisor_queue_observed":
        lines.push(`And the supervisor should see the call in "${e.queue}"`);
        break;
      case "e2e.supervisor_agent_offer":
        lines.push(`And the supervisor should see the agent receive the call offer`);
        break;
      case "e2e.transcript_captured":
        if (e.contains) {
          lines.push(`And the real-time transcript should contain "${e.contains}"`);
        } else {
          lines.push(`And the real-time transcript should capture speech`);
        }
        break;
      case "e2e.hold_resume_completed":
        lines.push(`And the hold/resume cycle should complete without errors`);
        break;
      case "e2e.acw_completed":
        lines.push(`And after-call work should be marked complete`);
        break;
      case "e2e.routing_type":
        lines.push(`And the routing type should be "${e.equals}"`);
        break;
      case "e2e.skill_matched":
        lines.push(`And the agent should have the required skill "${e.skill}"`);
        break;
      case "sf.attendance.psr_routing_type":
        lines.push(`And the PendingServiceRouting record should show routing type "${e.equals}"`);
        break;
      case "sf.attendance.psr_skill":
        lines.push(`And the routing should require skill "${e.skill}"`);
        break;
      case "sf.attendance.voicecall_call_type":
        lines.push(`And the VoiceCall record should have CallType "${e.equals}"`);
        break;
      case "sf.attendance.agentwork_routing_type":
        lines.push(`And AgentWork should show routing type "${e.equals}"`);
        break;
      case "sf.attendance.psr_created":
        lines.push(`And a PendingServiceRouting record should be created`);
        break;
      // Business hours / voicemail / callback assertions
      case "e2e.call_disconnected_by_system":
        lines.push(`Then the system should disconnect the call automatically`);
        break;
      case "e2e.prompt_played":
        lines.push(`And a prompt containing "${e.contains || "message"}" should play`);
        break;
      case "e2e.voicemail_recorded":
        lines.push(`Then the voicemail should be recorded successfully`);
        break;
      case "e2e.callback_task_created":
        lines.push(`Then a callback task should be created`);
        break;
      case "e2e.no_agent_offer":
        lines.push(`And no agent should receive a call offer`);
        break;
      case "connect.business_hours_check":
        lines.push(`And Connect should report business hours as "${e.equals}"`);
        break;
      case "sf.attendance.voicemail_created":
        lines.push(`And a voicemail record should be created in Salesforce`);
        break;
      case "sf.attendance.voicemail_transcript":
        lines.push(`And the voicemail transcript should contain "${e.contains}"`);
        break;
      case "sf.attendance.voicemail_duration_gte":
        lines.push(`And the voicemail duration should be at least ${e.gte}s`);
        break;
      case "sf.attendance.callback_task_created":
        lines.push(`And a callback task should be created in Salesforce`);
        break;
      case "sf.attendance.callback_task_status":
        lines.push(`And the callback task status should be "${e.equals}"`);
        break;
      case "connect.voicemail_flow_entered":
        lines.push(`And the voicemail flow should be entered in Connect`);
        break;
      case "connect.callback_flow_entered":
        lines.push(`And the callback flow should be entered in Connect`);
        break;
      default:
        lines.push(`And ${e.type} should equal ${e.equals ?? e.contains ?? "true"}`);
    }
  }

  return lines.join("\n");
}

function renderAgentStep() {
  const a = state.answers;
  return `
    <div class="wizard-step">
      <div class="step-header">
        <h2>Agent Experience</h2>
        <p>What should the agent see after accepting the call?</p>
      </div>

      <div class="toggle-row">
        <div>
          <div class="tr-label">Verify Screen Pop</div>
          <div class="tr-desc">Check that VoiceCall record appears after agent accepts</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="expect-screenpop" ${a.expectScreenPop ? "checked" : ""} />
          <span class="slider"></span>
        </label>
      </div>

      <div class="toggle-row">
        <div>
          <div class="tr-label">Verify Real-Time Transcript</div>
          <div class="tr-desc">Check that the transcript panel captures speech</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="expect-transcript" ${a.expectTranscript ? "checked" : ""} />
          <span class="slider"></span>
        </label>
      </div>

      <div id="transcript-fields" class="${a.expectTranscript ? "" : "hidden"}">
        <div class="form-group">
          <label class="form-label">Expected Phrase (optional)</label>
          <input class="form-input" id="transcript-phrase" placeholder="How can I help you?"
                 value="${esc(a.transcriptPhrase)}" />
          <div class="form-hint">Leave blank to verify any transcript growth</div>
        </div>
        <div class="form-group">
          <label class="form-label">Transcript Wait Timeout (seconds)</label>
          <input class="form-input" id="transcript-timeout" type="number" min="5" max="120"
                 value="${a.transcriptTimeout}" />
        </div>
      </div>

      <div class="section-divider"></div>

      <div class="toggle-row highlight-toggle">
        <div>
          <div class="tr-label">Post-Accept Conversation</div>
          <div class="tr-desc">Add steps after call accept: audio injection, hold/resume, transcript verify, end call, ACW</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="conversation-enabled" ${a.conversationEnabled ? "checked" : ""} />
          <span class="slider"></span>
        </label>
      </div>
      ${a.conversationEnabled ? '<div class="form-hint" style="margin-top: -4px; margin-bottom: 8px; padding-left: 16px;">Configure conversation details in the next step.</div>' : ""}
    </div>
  `;
}

function bindTranscriptToggle() {
  const toggle = document.getElementById("expect-transcript");
  if (!toggle) return;
  toggle.addEventListener("change", () => {
    document.getElementById("transcript-fields").classList.toggle("hidden", !toggle.checked);
  });
}

function renderConversationStep() {
  const a = state.answers;
  return `
    <div class="wizard-step">
      <div class="step-header">
        <h2>Post-Accept Conversation</h2>
        <p>What happens after the agent accepts the call? Configure the conversation lifecycle.</p>
      </div>

      <!-- Agent Audio -->
      <div class="toggle-row">
        <div>
          <div class="tr-label">Agent Speaks</div>
          <div class="tr-desc">Inject fake audio from the agent's microphone into the call</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="agent-speaks" ${a.agentSpeaks ? "checked" : ""} />
          <span class="slider"></span>
        </label>
      </div>
      <div id="agent-audio-fields" class="${a.agentSpeaks ? "" : "hidden"}">
        <div class="form-group indent-group">
          <label class="form-label">Agent Speech Text</label>
          <input class="form-input" id="agent-speech-text" placeholder="Hello, how can I help you?"
                 value="${esc(a.agentSpeechText)}" />
          <div class="form-hint">Text will be converted to audio via TTS and injected into the call</div>
        </div>
        <div class="form-group indent-group">
          <label class="form-label">Voice</label>
          <select class="form-input" id="agent-voice">
            <option value="Samantha" ${a.agentVoice === "Samantha" ? "selected" : ""}>Samantha (Female)</option>
            <option value="Alex" ${a.agentVoice === "Alex" ? "selected" : ""}>Alex (Male)</option>
            <option value="Victoria" ${a.agentVoice === "Victoria" ? "selected" : ""}>Victoria (Female)</option>
            <option value="Daniel" ${a.agentVoice === "Daniel" ? "selected" : ""}>Daniel (Male)</option>
          </select>
        </div>
      </div>

      <!-- Caller Audio -->
      <div class="toggle-row">
        <div>
          <div class="tr-label">Caller Speaks</div>
          <div class="tr-desc">Inject audio from the caller side (via Twilio or CCP fake stream)</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="caller-speaks" ${a.callerSpeaks ? "checked" : ""} />
          <span class="slider"></span>
        </label>
      </div>
      <div id="caller-audio-fields" class="${a.callerSpeaks ? "" : "hidden"}">
        <div class="form-group indent-group">
          <label class="form-label">Caller Speech Text</label>
          <input class="form-input" id="caller-speech-text" placeholder="I need help with my account"
                 value="${esc(a.callerSpeechText)}" />
        </div>
        <div class="form-group indent-group">
          <label class="form-label">Voice</label>
          <select class="form-input" id="caller-voice">
            <option value="Alex" ${a.callerVoice === "Alex" ? "selected" : ""}>Alex (Male)</option>
            <option value="Samantha" ${a.callerVoice === "Samantha" ? "selected" : ""}>Samantha (Female)</option>
            <option value="Victoria" ${a.callerVoice === "Victoria" ? "selected" : ""}>Victoria (Female)</option>
            <option value="Daniel" ${a.callerVoice === "Daniel" ? "selected" : ""}>Daniel (Male)</option>
          </select>
        </div>
      </div>

      <!-- Transcript Verification -->
      <div class="toggle-row">
        <div>
          <div class="tr-label">Verify Conversation Transcript</div>
          <div class="tr-desc">Wait for transcript to capture specific text from the conversation</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="verify-convo-transcript" ${a.verifyConvoTranscript ? "checked" : ""} />
          <span class="slider"></span>
        </label>
      </div>
      <div id="convo-transcript-fields" class="${a.verifyConvoTranscript ? "" : "hidden"}">
        <div class="form-group indent-group">
          <label class="form-label">Expected Phrase</label>
          <input class="form-input" id="convo-transcript-phrase" placeholder="billing"
                 value="${esc(a.convoTranscriptPhrase)}" />
          <div class="form-hint">Text to look for in the live transcript widget</div>
        </div>
        <div class="form-group indent-group">
          <label class="form-label">Timeout (seconds)</label>
          <input class="form-input" id="convo-transcript-timeout" type="number" min="5" max="120"
                 value="${a.convoTranscriptTimeout}" />
        </div>
      </div>

      <div class="section-divider"></div>

      <!-- Hold/Resume -->
      <div class="toggle-row">
        <div>
          <div class="tr-label">Test Hold / Resume</div>
          <div class="tr-desc">Agent puts caller on hold, waits, then resumes</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="test-hold-resume" ${a.testHoldResume ? "checked" : ""} />
          <span class="slider"></span>
        </label>
      </div>
      <div id="hold-fields" class="${a.testHoldResume ? "" : "hidden"}">
        <div class="form-group indent-group">
          <label class="form-label">Hold Duration (seconds)</label>
          <input class="form-input" id="hold-duration" type="number" min="1" max="60"
                 value="${a.holdDurationSec}" />
        </div>
      </div>

      <!-- End Call -->
      <div class="toggle-row">
        <div>
          <div class="tr-label">Agent Ends Call</div>
          <div class="tr-desc">Agent-initiated graceful disconnect (triggers ACW flow)</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="agent-ends-call" ${a.agentEndsCall ? "checked" : ""} />
          <span class="slider"></span>
        </label>
      </div>

      <!-- ACW -->
      <div class="toggle-row">
        <div>
          <div class="tr-label">Complete After-Call Work</div>
          <div class="tr-desc">Set disposition and complete ACW in Salesforce</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="complete-acw" ${a.completeAcw ? "checked" : ""} />
          <span class="slider"></span>
        </label>
      </div>
      <div id="acw-fields" class="${a.completeAcw ? "" : "hidden"}">
        <div class="form-group indent-group">
          <label class="form-label">Disposition</label>
          <input class="form-input" id="acw-disposition" placeholder="Resolved"
                 value="${esc(a.acwDisposition)}" />
        </div>
        <div class="form-group indent-group">
          <label class="form-label">Notes <span class="optional">(optional)</span></label>
          <input class="form-input" id="acw-notes" placeholder="Billing inquiry resolved"
                 value="${esc(a.acwNotes)}" />
        </div>
      </div>
    </div>
  `;
}

function bindConversationToggles() {
  const toggleMap = {
    "agent-speaks": "agent-audio-fields",
    "caller-speaks": "caller-audio-fields",
    "verify-convo-transcript": "convo-transcript-fields",
    "test-hold-resume": "hold-fields",
    "complete-acw": "acw-fields",
  };

  Object.entries(toggleMap).forEach(([toggleId, fieldsId]) => {
    const toggle = document.getElementById(toggleId);
    const fields = document.getElementById(fieldsId);
    if (toggle && fields) {
      toggle.addEventListener("change", () => {
        fields.classList.toggle("hidden", !toggle.checked);
      });
    }
  });
}

function renderSupervisorStep() {
  const a = state.answers;
  return `
    <div class="wizard-step">
      <div class="step-header">
        <h2>Supervisor Monitoring</h2>
        <p>${a.targetQueue
          ? `Should a supervisor verify the call appears in "${a.targetQueue}"?`
          : "Should a supervisor monitor this call?"}</p>
      </div>

      <div class="toggle-row">
        <div>
          <div class="tr-label">Enable Supervisor Observation</div>
          <div class="tr-desc">Supervisor browser verifies call presence in queue backlog</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="supervisor-enabled" ${a.supervisorEnabled ? "checked" : ""} />
          <span class="slider"></span>
        </label>
      </div>

      <div id="supervisor-fields" class="${a.supervisorEnabled ? "" : "hidden"}">
        <div class="toggle-row">
          <div>
            <div class="tr-label">Observe Agent Offer</div>
            <div class="tr-desc">Also verify the agent receives the call offer (In-Progress work)</div>
          </div>
          <label class="toggle">
            <input type="checkbox" id="observe-agent-offer" ${a.observeAgentOffer ? "checked" : ""} />
            <span class="slider"></span>
          </label>
        </div>

        <div class="toggle-row">
          <div>
            <div class="tr-label">Check Before Accept</div>
            <div class="tr-desc">Supervisor observes queue before the agent accepts the call</div>
          </div>
          <label class="toggle">
            <input type="checkbox" id="supervisor-check-before" ${a.supervisorCheckBeforeAccept ? "checked" : ""} />
            <span class="slider"></span>
          </label>
        </div>

        <div class="form-group">
          <label class="form-label">Supervisor App / Surface</label>
          <input class="form-input" id="supervisor-surface"
                 placeholder="Command Center for Service"
                 value="${esc(a.supervisorSurface)}" />
          <div class="form-hint">Name of the supervisor console in your Salesforce org</div>
        </div>
      </div>
    </div>
  `;
}

function bindSupervisorToggle() {
  const toggle = document.getElementById("supervisor-enabled");
  if (!toggle) return;
  toggle.addEventListener("change", () => {
    document.getElementById("supervisor-fields").classList.toggle("hidden", !toggle.checked);
  });
}

function renderDetailsStep() {
  const a = state.answers;
  const autoDesc = buildAutoDescription();
  const autoId = slugify(a.description || autoDesc);

  return `
    <div class="wizard-step">
      <div class="step-header">
        <h2>Scenario Details</h2>
        <p>Name your test case and configure timeouts.</p>
      </div>

      <div class="form-group">
        <label class="form-label">Description</label>
        <input class="form-input" id="scenario-desc"
               placeholder="${esc(autoDesc)}"
               value="${esc(a.description || autoDesc)}" />
      </div>

      <div class="form-group">
        <label class="form-label">Scenario ID (kebab-case)</label>
        <input class="form-input" id="scenario-id"
               placeholder="${esc(autoId)}"
               value="${esc(a.id || autoId)}" />
        <div class="form-hint">Unique identifier used in test results and video filenames</div>
      </div>

      <div class="form-group">
        <label class="form-label">Ring Timeout (seconds)</label>
        <input class="form-input" id="ring-timeout" type="number" min="15" max="300"
               value="${a.ringTimeout}" />
        <div class="form-hint">Max time to wait for the incoming call to arrive at the agent</div>
      </div>

      <div class="form-group">
        <label class="form-label">Execution Status</label>
        <div class="option-cards" data-name="exec-status">
          ${optionCard("active", "Active", "Included in suite runs", a.enabled !== false && !a.allowFailure)}
          ${optionCard("soft-fail", "Soft Fail", "Runs but suite continues if it fails", a.allowFailure && a.enabled !== false)}
          ${optionCard("inactive", "Inactive", "Skipped during suite runs", a.enabled === false)}
        </div>
      </div>
    </div>
  `;
}

function bindAutoSlug() {
  const descInput = document.getElementById("scenario-desc");
  const idInput = document.getElementById("scenario-id");
  if (!descInput || !idInput) return;
  let isAutoId = !state.answers.id || state.answers.id === slugify(state.answers.description || buildAutoDescription());
  descInput.addEventListener("input", () => {
    if (isAutoId) {
      idInput.value = slugify(descInput.value);
    }
  });
  idInput.addEventListener("input", () => {
    isAutoId = false;
  });
}

function renderReviewStep() {
  const a = state.answers;
  const scenario = answersToScenario();
  const steps = scenario.steps || [];
  const expects = scenario.expect || [];
  const nlText = scenarioToNaturalLanguage(scenario);

  return `
    <div class="wizard-step">
      <div class="step-header">
        <h2>Review Your Scenario</h2>
        <p>Verify the plain-English rules below, then check the generated steps.</p>
      </div>

      <!-- Natural Language Rules -->
      <div class="nl-rules-card">
        <div class="nl-rules-header">
          <label class="form-label" style="margin-bottom: 0;">Test Rules (Plain English)</label>
          <button class="btn btn-ghost btn-sm" id="btn-copy-nl">Copy</button>
        </div>
        <pre class="nl-rules-body">${esc(nlText)}</pre>
      </div>

      <div class="review-card">
        <div class="form-group">
          <label class="form-label">Scenario</label>
          <div style="font-size: 16px; font-weight: 600; margin-bottom: 4px;">${esc(scenario.id)}</div>
          <div style="color: var(--text-secondary); font-size: 13px;">${esc(scenario.description)}</div>
        </div>

        <div class="review-tabs-row">
          <button class="review-tab-btn active" data-review-tab="steps">Steps (${steps.length})</button>
          <button class="review-tab-btn" data-review-tab="assertions">Assertions (${expects.length})</button>
          <button class="review-tab-btn" data-review-tab="trigger">Call Trigger</button>
        </div>

        <!-- Steps tab -->
        <div class="review-tab-content" data-review-content="steps">
          <div class="step-list-review" id="step-list-review">
            ${steps.map((s, i) => {
              const icon = stepIcon(s.action);
              const detail = stepDetail(s);
              return `
                <div class="step-review-item" data-index="${i}">
                  <div class="sri-left">
                    <span class="sri-num">${i + 1}</span>
                    <span class="sri-icon ${icon.cls}">${icon.char}</span>
                    <span class="sri-action">${s.action}</span>
                    ${detail ? `<span class="sri-detail">${detail}</span>` : ""}
                  </div>
                </div>
              `;
            }).join("")}
          </div>
        </div>

        <!-- Assertions tab -->
        <div class="review-tab-content hidden" data-review-content="assertions">
          <div class="assertion-list">
            ${expects.map((e) => `
              <div class="assertion-item">
                <span class="ai-icon">&#x2713;</span>
                <span class="ai-text">${esc(e.type)}${e.queue ? ` (${esc(e.queue)})` : ""}${e.equals !== undefined ? ` = ${e.equals}` : ""}${e.contains ? ` contains "${esc(e.contains)}"` : ""}</span>
              </div>
            `).join("")}
          </div>
        </div>

        <!-- Trigger tab -->
        <div class="review-tab-content hidden" data-review-content="trigger">
          <div style="font-size: 13px; color: var(--text-secondary); padding: 8px 0;">
            <div style="margin-bottom: 6px;">Mode: <strong>${esc(scenario.callTrigger?.mode || "connect_ccp")}</strong></div>
            ${scenario.callTrigger?.entryNumber ? `<div style="margin-bottom: 6px;">Number: <strong>${esc(scenario.callTrigger.entryNumber)}</strong></div>` : ""}
            ${scenario.callTrigger?.ivrDigits !== undefined ? `<div style="margin-bottom: 6px;">IVR Digits: <strong>${scenario.callTrigger.ivrDigits === "" ? "(none — timeout)" : `DTMF ${esc(scenario.callTrigger.ivrDigits)}`}</strong></div>` : ""}
            ${scenario.callTrigger?.ivrInitialDelayMs ? `<div style="margin-bottom: 6px;">IVR Wait: <strong>${scenario.callTrigger.ivrInitialDelayMs / 1000}s</strong></div>` : ""}
          </div>
        </div>

        <div style="margin-top: 12px;">
          ${scenario.enabled === false
            ? '<span class="badge badge-inactive">Inactive — Skipped</span>'
            : scenario.allowFailure
              ? '<span class="badge badge-allow-fail">Soft Fail</span>'
              : '<span class="badge badge-active">Active</span>'}
        </div>
      </div>

      <!-- Advanced Step Editor -->
      <div class="advanced-editor-section">
        <button class="btn btn-outline btn-sm" id="btn-toggle-advanced">Advanced: Edit Steps Manually</button>
        <div id="advanced-editor" class="hidden">
          <div class="form-hint" style="margin: 10px 0;">
            Add, remove, or reorder steps. Each step is a JSON object with an "action" key.
          </div>
          <div id="advanced-step-list">
            ${steps.map((s, i) => renderAdvancedStepRow(s, i, steps.length)).join("")}
          </div>
          <div class="advanced-add-row">
            <select class="form-input" id="add-step-select" style="max-width: 280px;">
              <option value="">+ Add a step...</option>
              ${ALL_STEP_ACTIONS.map((a) => `<option value="${a.action}">${a.label} — ${a.desc}</option>`).join("")}
            </select>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderAdvancedStepRow(step, index, total) {
  const icon = stepIcon(step.action);
  const configFields = renderStepConfigFields(step);
  return `
    <div class="adv-step-row" data-index="${index}">
      <div class="adv-step-header">
        <div class="adv-step-left">
          <span class="adv-step-grip" title="Drag to reorder">&#x2630;</span>
          <span class="adv-step-num">${index + 1}</span>
          <span class="sri-icon ${icon.cls}">${icon.char}</span>
          <span class="adv-step-action">${step.action}</span>
        </div>
        <div class="adv-step-right">
          ${index > 0 ? `<button class="btn btn-ghost btn-sm adv-move-up" data-index="${index}" title="Move up">&#x25B2;</button>` : ""}
          ${index < total - 1 ? `<button class="btn btn-ghost btn-sm adv-move-down" data-index="${index}" title="Move down">&#x25BC;</button>` : ""}
          <button class="btn btn-ghost btn-sm adv-remove" data-index="${index}" title="Remove">&#x2715;</button>
        </div>
      </div>
      ${configFields ? `<div class="adv-step-config">${configFields}</div>` : ""}
    </div>
  `;
}

function renderStepConfigFields(step) {
  switch (step.action) {
    case "detect_incoming":
      return `<label>Timeout (sec): <input class="form-input form-input-sm adv-cfg" data-key="timeoutSec" type="number" value="${step.timeoutSec || 90}" /></label>`;
    case "start_supervisor":
      return `
        <label>Queue: <input class="form-input form-input-sm adv-cfg" data-key="queue" value="${esc(step.queue || "")}" /></label>
        <label>Surface: <input class="form-input form-input-sm adv-cfg" data-key="surface" value="${esc(step.surface || "")}" /></label>
      `;
    case "send_dtmf_sequence":
      return `
        <label>Digits: <input class="form-input form-input-sm adv-cfg" data-key="digits" value="${esc(step.digits || "")}" /></label>
        <label>Delay Before (ms): <input class="form-input form-input-sm adv-cfg" data-key="delayBeforeMs" type="number" value="${step.delayBeforeMs || 4000}" /></label>
      `;
    case "wait_for_ivr_prompt":
      return `<label>Timeout (sec): <input class="form-input form-input-sm adv-cfg" data-key="timeoutSec" type="number" value="${step.timeoutSec || 10}" /></label>`;
    case "play_agent_audio":
    case "play_caller_audio":
      return `
        <label>Text: <input class="form-input form-input-sm adv-cfg" data-key="text" value="${esc(step.text || "")}" /></label>
        <label>Voice: <input class="form-input form-input-sm adv-cfg" data-key="voice" value="${esc(step.voice || "Samantha")}" /></label>
        <label>Duration (ms): <input class="form-input form-input-sm adv-cfg" data-key="durationMs" type="number" value="${step.durationMs || 4000}" /></label>
      `;
    case "wait_for_transcript":
      return `
        <label>Contains: <input class="form-input form-input-sm adv-cfg" data-key="contains" value="${esc(step.contains || "")}" /></label>
        <label>Timeout (sec): <input class="form-input form-input-sm adv-cfg" data-key="timeoutSec" type="number" value="${step.timeoutSec || 30}" /></label>
      `;
    case "verify_transcript":
      return `
        <label>Phrase: <input class="form-input form-input-sm adv-cfg" data-key="expectPhrase" value="${esc(step.expectPhrase || "")}" /></label>
        <label>Timeout (sec): <input class="form-input form-input-sm adv-cfg" data-key="timeoutSec" type="number" value="${step.timeoutSec || 30}" /></label>
      `;
    case "wait":
      return `<label>Seconds: <input class="form-input form-input-sm adv-cfg" data-key="seconds" type="number" value="${step.seconds || 5}" /></label>`;
    case "complete_acw":
      return `
        <label>Disposition: <input class="form-input form-input-sm adv-cfg" data-key="disposition" value="${esc(step.disposition || "")}" /></label>
        <label>Notes: <input class="form-input form-input-sm adv-cfg" data-key="notes" value="${esc(step.notes || "")}" /></label>
      `;
    default:
      return "";
  }
}

function bindAdvancedStepEditor() {
  // Review tabs
  document.querySelectorAll(".review-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.reviewTab;
      document.querySelectorAll(".review-tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.reviewTab === tab));
      document.querySelectorAll(".review-tab-content").forEach((c) => c.classList.toggle("hidden", c.dataset.reviewContent !== tab));
    });
  });

  // Copy NL button
  const copyNlBtn = document.getElementById("btn-copy-nl");
  if (copyNlBtn) {
    copyNlBtn.addEventListener("click", async () => {
      const nlText = document.querySelector(".nl-rules-body")?.textContent || "";
      try {
        await navigator.clipboard.writeText(nlText);
        toast("Rules copied to clipboard", "success");
      } catch {
        toast("Copy failed", "error");
      }
    });
  }

  const toggleBtn = document.getElementById("btn-toggle-advanced");
  const editor = document.getElementById("advanced-editor");
  if (!toggleBtn || !editor) return;

  toggleBtn.addEventListener("click", () => {
    const hidden = editor.classList.toggle("hidden");
    toggleBtn.textContent = hidden ? "Advanced: Edit Steps Manually" : "Hide Advanced Editor";
  });

  // Add step dropdown
  const addSelect = document.getElementById("add-step-select");
  if (addSelect) {
    addSelect.addEventListener("change", () => {
      const action = addSelect.value;
      if (!action) return;
      addSelect.value = "";

      // Get current steps from the advanced editor
      const currentSteps = collectAdvancedSteps();
      const newStep = { action };
      // Set defaults for certain actions
      if (action === "detect_incoming") newStep.timeoutSec = 90;
      if (action === "wait") newStep.seconds = 5;
      if (action === "wait_for_ivr_prompt") newStep.timeoutSec = 10;
      currentSteps.push(newStep);
      state.answers.customSteps = currentSteps;
      rerenderAdvancedSteps();
    });
  }

  bindAdvancedStepActions();
}

function collectAdvancedSteps() {
  const rows = document.querySelectorAll(".adv-step-row");
  const steps = [];
  rows.forEach((row) => {
    const action = row.querySelector(".adv-step-action")?.textContent;
    if (!action) return;
    const step = { action };
    row.querySelectorAll(".adv-cfg").forEach((input) => {
      const key = input.dataset.key;
      let val = input.value.trim();
      if (input.type === "number") val = parseFloat(val) || 0;
      if (val !== "" && val !== 0) step[key] = val;
    });
    steps.push(step);
  });
  return steps;
}

function rerenderAdvancedSteps() {
  const container = document.getElementById("advanced-step-list");
  if (!container) return;
  const steps = state.answers.customSteps || answersToScenario().steps;
  container.innerHTML = steps
    .map((s, i) => renderAdvancedStepRow(s, i, steps.length))
    .join("");
  bindAdvancedStepActions();
  // Also update the main review step list
  const reviewList = document.getElementById("step-list-review");
  if (reviewList) {
    reviewList.innerHTML = steps.map((s, i) => {
      const icon = stepIcon(s.action);
      const detail = stepDetail(s);
      return `
        <div class="step-review-item" data-index="${i}">
          <div class="sri-left">
            <span class="sri-num">${i + 1}</span>
            <span class="sri-icon ${icon.cls}">${icon.char}</span>
            <span class="sri-action">${s.action}</span>
            ${detail ? `<span class="sri-detail">${detail}</span>` : ""}
          </div>
        </div>
      `;
    }).join("");
  }
}

function bindAdvancedStepActions() {
  // Move up
  document.querySelectorAll(".adv-move-up").forEach((btn) => {
    btn.addEventListener("click", () => {
      const steps = collectAdvancedSteps();
      const i = parseInt(btn.dataset.index, 10);
      if (i > 0) [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]];
      state.answers.customSteps = steps;
      rerenderAdvancedSteps();
    });
  });

  // Move down
  document.querySelectorAll(".adv-move-down").forEach((btn) => {
    btn.addEventListener("click", () => {
      const steps = collectAdvancedSteps();
      const i = parseInt(btn.dataset.index, 10);
      if (i < steps.length - 1) [steps[i], steps[i + 1]] = [steps[i + 1], steps[i]];
      state.answers.customSteps = steps;
      rerenderAdvancedSteps();
    });
  });

  // Remove
  document.querySelectorAll(".adv-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      const steps = collectAdvancedSteps();
      const i = parseInt(btn.dataset.index, 10);
      steps.splice(i, 1);
      state.answers.customSteps = steps;
      rerenderAdvancedSteps();
    });
  });
}

// ── Build Scenario from Answers ─────────────────────────────────────────────

function answersToScenario() {
  const a = state.answers;

  const scenario = {
    id: a.id || slugify(a.description || buildAutoDescription()) || "my-scenario",
    description: a.description || buildAutoDescription(),
  };

  if (a.enabled === false) {
    scenario.enabled = false;
  }
  if (a.allowFailure) {
    scenario.allowFailure = true;
  }

  // Call trigger
  const callTrigger = { mode: a.callMode };
  if (a.entryNumber) callTrigger.entryNumber = a.entryNumber;

  const isMultiLevelIvr = a.hasIvr && a.ivrLevels.filter((l) => l.digits).length > 1;

  if (a.hasIvr && !isMultiLevelIvr) {
    const firstLevel = a.ivrLevels[0];
    callTrigger.ivrDigits = firstLevel?.digits || a.ivrDigits || "";
    callTrigger.ivrInitialDelayMs = (firstLevel?.delaySec || 4) * 1000;
    callTrigger.ivrInterDigitDelayMs = a.ivrInterDigitDelayMs || 450;
    callTrigger.ivrPostDelayMs = 1200;
    callTrigger.dtmfMinCallElapsedSec = 5;
  } else if (a.hasIvr && isMultiLevelIvr) {
    const firstLevel = a.ivrLevels[0];
    callTrigger.ivrDigits = firstLevel?.digits || "";
    callTrigger.ivrInitialDelayMs = (firstLevel?.delaySec || 4) * 1000;
    callTrigger.ivrPostDelayMs = 1200;
    callTrigger.dtmfMinCallElapsedSec = 5;
  } else if (a.routeType === "queue" && !a.ivrDigits) {
    callTrigger.ivrDigits = "";
  }

  // Call outcome: closed hours
  if (a.callOutcome === "closed_hours") {
    callTrigger.callTiming = { window: "after_hours" };
    callTrigger.noAgentBehavior = "prompt_and_disconnect";
  } else if (a.callOutcome === "voicemail") {
    callTrigger.noAgentBehavior = "voicemail";
  } else if (a.callOutcome === "callback") {
    callTrigger.noAgentBehavior = "callback";
  }

  // Routing type
  if (a.routeType === "skill") {
    callTrigger.routingType = "skill";
    const skills = (a.routingSkills || []).filter((s) => s.name);
    if (skills.length > 0) {
      callTrigger.requiredSkills = skills.map((s) => ({
        name: s.name,
        ...(s.minLevel > 1 ? { minLevel: s.minLevel } : {}),
      }));
    }
  } else if (a.routeType === "extension") {
    callTrigger.routingType = "extension";
    if (a.extension) callTrigger.extension = a.extension;
  } else if (a.routeType === "direct" && a.targetAgent) {
    callTrigger.routingType = "direct_agent";
    callTrigger.targetAgent = a.targetAgent;
  } else if (a.routeType === "queue") {
    callTrigger.routingType = "queue";
  }

  scenario.callTrigger = callTrigger;

  // If custom steps from advanced editor, use those directly
  if (a.customSteps) {
    scenario.steps = a.customSteps;
  } else if (a.callOutcome === "closed_hours") {
    // ── Closed Hours scenario steps ──
    const steps = [{ action: "preflight" }, { action: "trigger_call" }];
    if (a.closedMessageText) {
      steps.push({ action: "listen_for_prompt", promptText: a.closedMessageText, listenTimeoutSec: 15 });
    }
    steps.push({ action: "wait_for_disconnect", timeoutSec: 30 });
    scenario.steps = steps;
  } else if (a.callOutcome === "voicemail") {
    // ── Voicemail scenario steps ──
    const steps = [{ action: "preflight" }, { action: "trigger_call" }];
    steps.push({ action: "listen_for_prompt", promptText: "leave a message after the tone", listenTimeoutSec: 30 });
    if (a.voicemailText) {
      steps.push({
        action: "leave_voicemail",
        voicemailText: a.voicemailText,
        voicemailDurationSec: a.voicemailDurationSec || 8,
      });
    }
    steps.push({ action: "wait_for_disconnect", timeoutSec: 15 });
    scenario.steps = steps;
  } else if (a.callOutcome === "callback") {
    // ── Callback scenario steps ──
    const steps = [{ action: "preflight" }, { action: "trigger_call" }];
    steps.push({ action: "listen_for_prompt", promptText: "request a callback", listenTimeoutSec: 60 });
    const cbStep = { action: "request_callback", digits: "1" };
    if (a.callbackPhone) cbStep.callbackPhone = a.callbackPhone;
    steps.push(cbStep);
    steps.push({ action: "listen_for_prompt", promptText: "we will call you back", listenTimeoutSec: 10 });
    steps.push({ action: "wait_for_disconnect", timeoutSec: 15 });
    scenario.steps = steps;
  } else {
    // ── Agent answer scenario steps (existing) ──
    const steps = [];
    steps.push({ action: "preflight" });

    if (a.supervisorEnabled && (a.targetQueue || a.routeType === "skill")) {
      const supStep = { action: "start_supervisor" };
      if (a.targetQueue) supStep.queue = a.targetQueue;
      if (a.supervisorSurface && a.supervisorSurface !== "Command Center for Service") {
        supStep.surface = a.supervisorSurface;
      }
      if (a.routeType === "skill" && a.routingSkills?.length > 0) {
        const firstSkill = a.routingSkills.find((s) => s.name);
        if (firstSkill) {
          supStep.skill = firstSkill.name;
          if (firstSkill.minLevel > 1) supStep.skillLevel = firstSkill.minLevel;
        }
      }
      if (a.observeAgentOffer) supStep.observeAgentOffer = true;
      supStep.checkBeforeAccept = a.supervisorCheckBeforeAccept;
      steps.push(supStep);
    }

    steps.push({ action: "trigger_call" });

    // Greeting verification (before IVR navigation)
    if (a.verifyGreeting && a.greetingText) {
      steps.push({ action: "listen_for_prompt", promptText: a.greetingText, listenTimeoutSec: 10 });
    }

    // Multi-level IVR: add DTMF steps for levels 2+
    if (isMultiLevelIvr) {
      for (let i = 1; i < a.ivrLevels.length; i++) {
        const lvl = a.ivrLevels[i];
        if (lvl.digits) {
          steps.push({ action: "wait_for_ivr_prompt", timeoutSec: 10, silenceThresholdMs: 2000 });
          const dtmfStep = { action: "send_dtmf_sequence", digits: lvl.digits, delayBeforeMs: lvl.delaySec * 1000 };
          if (lvl.label) dtmfStep.label = lvl.label;
          steps.push(dtmfStep);
        }
      }
    }

    steps.push({ action: "detect_incoming", timeoutSec: a.ringTimeout });
    steps.push({ action: "accept_call" });

    if (a.expectScreenPop) {
      steps.push({ action: "verify_screen_pop" });
    }

    if (a.expectTranscript) {
      const ts = { action: "verify_transcript" };
      if (a.transcriptPhrase) ts.expectPhrase = a.transcriptPhrase;
      ts.timeoutSec = a.transcriptTimeout;
      steps.push(ts);
    }

    // Conversation steps (post-accept)
    if (a.conversationEnabled) {
      if (a.agentSpeaks) {
        steps.push({
          action: "play_agent_audio",
          text: a.agentSpeechText,
          voice: a.agentVoice,
          durationMs: 4000,
        });
      }

      if (a.callerSpeaks) {
        steps.push({
          action: "play_caller_audio",
          text: a.callerSpeechText,
          voice: a.callerVoice,
          durationMs: 3000,
        });
      }

      if (a.verifyConvoTranscript) {
        const wt = { action: "wait_for_transcript", timeoutSec: a.convoTranscriptTimeout };
        if (a.convoTranscriptPhrase) wt.contains = a.convoTranscriptPhrase;
        steps.push(wt);
      }

      if (a.testHoldResume) {
        steps.push({ action: "hold_call" });
        steps.push({ action: "wait", seconds: a.holdDurationSec });
        steps.push({ action: "resume_call" });
      }

      if (a.agentEndsCall) {
        steps.push({ action: "end_call" });
      }

      if (a.completeAcw) {
        const acwStep = { action: "complete_acw" };
        if (a.acwDisposition) acwStep.disposition = a.acwDisposition;
        if (a.acwNotes) acwStep.notes = a.acwNotes;
        steps.push(acwStep);
      }
    }

    scenario.steps = steps;
  }

  // Assertions
  const expect = [];
  const isAgentAnswer = !a.callOutcome || a.callOutcome === "agent_answer";

  if (isAgentAnswer) {
    expect.push({ type: "e2e.call_connected", equals: true });

    if (a.supervisorEnabled && a.targetQueue) {
      expect.push({ type: "e2e.supervisor_queue_observed", queue: a.targetQueue });
    }
    if (a.observeAgentOffer) {
      expect.push({ type: "e2e.supervisor_agent_offer", equals: true });
    }
    if (a.expectScreenPop) {
      expect.push({ type: "e2e.screen_pop_detected", equals: true });
    }
    if (a.expectTranscript) {
      const ea = { type: "e2e.transcript_captured", equals: true };
      if (a.transcriptPhrase) ea.contains = a.transcriptPhrase;
      expect.push(ea);
    }

    // Greeting prompt assertion
    if (a.verifyGreeting && a.greetingText) {
      expect.push({ type: "e2e.prompt_played", contains: a.greetingText, equals: true });
    }

    // Skill-based routing assertions
    if (a.routeType === "skill") {
      expect.push({ type: "e2e.routing_type", equals: "skill" });
      const skills = (a.routingSkills || []).filter((s) => s.name);
      if (skills.length > 0) {
        expect.push({ type: "e2e.skill_matched", skill: skills[0].name, equals: true });
        expect.push({ type: "sf.attendance.psr_routing_type", equals: "SkillsBased" });
        expect.push({ type: "sf.attendance.psr_skill", skill: skills[0].name, equals: true });
      }
    }

    // Conversation assertions
    if (a.conversationEnabled) {
      if (a.verifyConvoTranscript && a.convoTranscriptPhrase) {
        expect.push({ type: "e2e.transcript_captured", contains: a.convoTranscriptPhrase });
      }
      if (a.testHoldResume) {
        expect.push({ type: "e2e.hold_resume_completed", equals: true });
      }
      if (a.completeAcw) {
        expect.push({ type: "e2e.acw_completed", equals: true });
      }
    }
  } else if (a.callOutcome === "closed_hours") {
    if (a.closedMessageText) {
      expect.push({ type: "e2e.prompt_played", contains: a.closedMessageText, equals: true });
    }
    expect.push({ type: "e2e.call_disconnected_by_system", equals: true });
    expect.push({ type: "e2e.no_agent_offer", equals: true });
    expect.push({ type: "connect.business_hours_check", equals: "closed" });
  } else if (a.callOutcome === "voicemail") {
    expect.push({ type: "e2e.voicemail_recorded", equals: true });
    expect.push({ type: "e2e.no_agent_offer", equals: true });
    expect.push({ type: "sf.attendance.voicemail_created", equals: true });
    if (a.voicemailText) {
      // Extract a key phrase from voicemail text for transcript matching
      const words = a.voicemailText.split(/\s+/).slice(0, 5).join(" ");
      expect.push({ type: "sf.attendance.voicemail_transcript", contains: words });
    }
    expect.push({ type: "sf.attendance.voicemail_duration_gte", gte: Math.max(3, (a.voicemailDurationSec || 8) - 3) });
    expect.push({ type: "connect.voicemail_flow_entered", equals: true });
  } else if (a.callOutcome === "callback") {
    expect.push({ type: "e2e.callback_task_created", equals: true });
    expect.push({ type: "e2e.call_disconnected_by_system", equals: true });
    expect.push({ type: "sf.attendance.callback_task_created", equals: true });
    expect.push({ type: "sf.attendance.callback_task_status", equals: "Open" });
    expect.push({ type: "connect.callback_flow_entered", equals: true });
  }
  scenario.expect = expect;

  // Timeouts
  const timeouts = {};
  if (a.ringTimeout !== 90) timeouts.ringSec = a.ringTimeout;
  if (isAgentAnswer && a.supervisorEnabled && a.ringTimeout > 120) {
    timeouts.supervisorQueueSec = a.ringTimeout;
    timeouts.offerAfterQueueSec = a.ringTimeout;
  }
  if (a.hasIvr) {
    timeouts.supervisorPostQueueHoldSec = 4;
  }
  if (Object.keys(timeouts).length > 0) {
    scenario.timeouts = timeouts;
  }

  return scenario;
}

function buildAutoDescription() {
  const a = state.answers;
  const parts = [];

  // Call outcome prefix
  if (a.callOutcome === "closed_hours") {
    parts.push("After-hours call");
    if (a.closedMessageText) parts.push(`plays "${a.closedMessageText}" and disconnects`);
    return parts.join(" — ") || "Call outside business hours — system plays closed message";
  } else if (a.callOutcome === "voicemail") {
    parts.push("No agent available — voicemail");
    return parts.join(" — ") || "Voicemail scenario — caller leaves message";
  } else if (a.callOutcome === "callback") {
    parts.push("Queue full — callback requested");
    return parts.join(" — ") || "Callback scenario — caller requests callback";
  }

  if (a.hasIvr && a.ivrLevels.filter((l) => l.digits).length > 1) {
    const labels = a.ivrLevels.filter((l) => l.digits).map((l) => l.label || `DTMF ${l.digits}`);
    parts.push(`Multi-level IVR (${labels.join(" > ")})`);
  } else if (a.hasIvr && a.ivrDigits) {
    parts.push(`DTMF ${a.ivrDigits}`);
  }

  if (a.routeType === "skill") {
    const skillNames = (a.routingSkills || []).filter((s) => s.name).map((s) => s.name);
    if (skillNames.length > 0) {
      parts.push(`skill-based routing (${skillNames.join(", ")})`);
    } else {
      parts.push("skill-based routing");
    }
    if (a.targetQueue) parts.push(`via ${a.targetQueue}`);
  } else if (a.routeType === "extension") {
    parts.push(`extension ${a.extension || "dial"}`);
  } else if (a.targetQueue) {
    parts.push(`routes to ${a.targetQueue}`);
  } else if (a.routeType === "direct" && a.targetAgent) {
    parts.push(`direct to ${a.targetAgent}`);
  } else {
    parts.push("Direct inbound call");
  }

  if (a.conversationEnabled) {
    const convoFeatures = [];
    if (a.agentSpeaks || a.callerSpeaks) convoFeatures.push("audio");
    if (a.testHoldResume) convoFeatures.push("hold/resume");
    if (a.agentEndsCall) convoFeatures.push("end call");
    if (a.completeAcw) convoFeatures.push("ACW");
    if (convoFeatures.length > 0) {
      parts.push(`with ${convoFeatures.join(", ")}`);
    }
  }

  return parts.join(" — ") || "Direct inbound call — agent accepts and verifies screen pop";
}

// ── Preview ─────────────────────────────────────────────────────────────────

function showPreview() {
  collectCurrentStepAnswers();
  const scenario = answersToScenario();

  document.getElementById("wizard").classList.add("hidden");
  document.getElementById("preview-panel").classList.remove("hidden");

  document.getElementById("preview-json").textContent = JSON.stringify(scenario, null, 2);
  renderFlowPreview(scenario);
  switchPreviewTab("json");
}

function closePreview() {
  document.getElementById("preview-panel").classList.add("hidden");
  document.getElementById("wizard").classList.remove("hidden");
}

function switchPreviewTab(tab) {
  document.querySelectorAll(".preview-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === tab);
  });
  document.getElementById("preview-json").classList.toggle("hidden", tab !== "json");
  document.getElementById("preview-env").classList.toggle("hidden", tab !== "env");
  document.getElementById("preview-flow").classList.toggle("hidden", tab !== "steps");
}

async function showEnvPreview() {
  const scenario = answersToScenario();
  const defaults = state.currentSuite?.defaults || {};
  try {
    const data = await api("/env-preview", {
      method: "POST",
      body: JSON.stringify({ scenario, defaults }),
    });
    document.getElementById("preview-env").textContent = Object.entries(data.env || {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    switchPreviewTab("env");
  } catch (err) {
    toast("Failed to generate env preview", "error");
  }
}

function renderFlowPreview(scenario) {
  const container = document.getElementById("preview-flow");
  const steps = scenario.steps || [];
  container.innerHTML = steps
    .map((s, i) => {
      const icon = stepIcon(s.action);
      const detail = stepDetail(s);
      return `
        <div class="flow-step">
          <div class="fs-icon ${icon.cls}">${icon.char}</div>
          <div>
            <div class="fs-label">${s.action}</div>
            ${detail ? `<div class="fs-detail">${detail}</div>` : ""}
          </div>
        </div>
        ${i < steps.length - 1 ? '<div class="flow-connector"></div>' : ""}
      `;
    })
    .join("");
}

async function copyJson() {
  const json = document.getElementById("preview-json").textContent;
  try {
    await navigator.clipboard.writeText(json);
    toast("JSON copied to clipboard", "success");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = json;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    toast("JSON copied to clipboard", "success");
  }
}

async function saveScenario() {
  const scenario = answersToScenario();
  let suiteFile = state.currentSuiteFile;

  if (!suiteFile) {
    suiteFile = "scenarios/e2e/full-suite-v2.json";
  }

  try {
    const result = await api("/scenario", {
      method: "POST",
      body: JSON.stringify({ scenario, suiteFile }),
    });
    toast(result.message || "Scenario saved!", "success");
    await loadSuite(suiteFile);
    state.editingScenarioId = scenario.id;
    renderScenarioList();
  } catch (err) {
    toast("Failed to save scenario", "error");
  }
}

// ── Progress ────────────────────────────────────────────────────────────────

function updateProgress() {
  const container = document.getElementById("progress-steps");
  const isEditing = !!state.editingScenarioId;

  container.innerHTML = STEPS.map((s, i) => {
    const skipped = shouldSkipStep(s.id);
    if (skipped && i !== state.wizardStep) return ""; // Hide skipped steps
    let cls = "";
    if (i === state.wizardStep) cls = "active";
    else if (i < state.wizardStep) cls = "completed";
    else if (isEditing) cls = "clickable";
    return `<span class="progress-step ${cls}" data-step="${i}">${s.label}</span>`;
  }).join("");

  container.querySelectorAll(".progress-step").forEach((el) => {
    el.addEventListener("click", () => {
      const target = parseInt(el.dataset.step, 10);
      if (isEditing || target <= state.wizardStep) {
        collectCurrentStepAnswers();
        state.wizardStep = target;
        renderWizardStep();
        updateProgress();
        updateLiveFlow();
      }
    });
  });

  const pct = ((state.wizardStep + 1) / STEPS.length) * 100;
  document.getElementById("progress-fill").style.width = `${pct}%`;
}

// ── Live Flow (Right Panel) ─────────────────────────────────────────────────

function updateLiveFlow() {
  const container = document.getElementById("live-flow");
  const scenario = answersToScenario();
  const steps = scenario.steps || [];

  if (steps.length === 0) {
    container.innerHTML = '<div class="flow-placeholder">Steps will appear here as you build</div>';
    return;
  }

  // NL summary at top of live flow
  const nlText = scenarioToNaturalLanguage(scenario);
  const nlLines = nlText.split("\n").filter(Boolean);
  // Show condensed version in the side panel — just the Given/When/Then lines
  const condensed = nlLines
    .filter((l) => /^(Given|And|When|Then|Scenario:)/.test(l.trim()))
    .map((l) => {
      const trimmed = l.trim();
      if (trimmed.startsWith("Scenario:")) return `<div class="lf-nl-scenario">${esc(trimmed)}</div>`;
      if (trimmed.startsWith("Given")) return `<div class="lf-nl-line lf-nl-given">${esc(trimmed)}</div>`;
      if (trimmed.startsWith("When")) return `<div class="lf-nl-line lf-nl-when">${esc(trimmed)}</div>`;
      if (trimmed.startsWith("Then")) return `<div class="lf-nl-line lf-nl-then">${esc(trimmed)}</div>`;
      return `<div class="lf-nl-line lf-nl-and">${esc(trimmed)}</div>`;
    })
    .join("");

  const stepsHtml = steps
    .map((s, i) => {
      const icon = stepIcon(s.action);
      const detail = stepDetail(s);
      return `
        <div class="flow-step">
          <div class="fs-icon ${icon.cls}">${icon.char}</div>
          <div>
            <div class="fs-label">${s.action}</div>
            ${detail ? `<div class="fs-detail">${detail}</div>` : ""}
          </div>
        </div>
        ${i < steps.length - 1 ? '<div class="flow-connector"></div>' : ""}
      `;
    })
    .join("");

  container.innerHTML = `
    <div class="lf-nl-summary">${condensed}</div>
    <div class="lf-divider"></div>
    ${stepsHtml}
  `;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function stepIcon(action) {
  const map = {
    preflight: { char: "P", cls: "preflight" },
    trigger_call: { char: "D", cls: "call" },
    detect_incoming: { char: "R", cls: "call" },
    accept_call: { char: "A", cls: "call" },
    start_supervisor: { char: "S", cls: "supervisor" },
    verify_screen_pop: { char: "V", cls: "verify" },
    verify_transcript: { char: "T", cls: "verify" },
    verify_voicecall_record: { char: "R", cls: "verify" },
    // Multi-level IVR
    send_dtmf_sequence: { char: "#", cls: "ivr" },
    wait_for_ivr_prompt: { char: "W", cls: "ivr" },
    // Conversation
    play_agent_audio: { char: "A", cls: "audio" },
    play_caller_audio: { char: "C", cls: "audio" },
    wait_for_transcript: { char: "T", cls: "verify" },
    hold_call: { char: "H", cls: "hold" },
    resume_call: { char: "R", cls: "hold" },
    end_call: { char: "E", cls: "danger" },
    complete_acw: { char: "W", cls: "acw" },
    wait: { char: "Z", cls: "preflight" },
    // Business hours / voicemail / callback
    listen_for_prompt: { char: "L", cls: "ivr" },
    wait_for_disconnect: { char: "X", cls: "danger" },
    leave_voicemail: { char: "M", cls: "audio" },
    request_callback: { char: "B", cls: "call" },
    wait_for_voicemail_prompt: { char: "V", cls: "ivr" },
    verify_callback_created: { char: "C", cls: "verify" },
    verify_voicemail_created: { char: "V", cls: "verify" },
    verify_business_hours_routing: { char: "H", cls: "verify" },
    verify_prompt_played: { char: "P", cls: "verify" },
    verify_no_agent_offer: { char: "N", cls: "verify" },
    decline_call: { char: "D", cls: "danger" },
  };
  return map[action] || { char: "?", cls: "preflight" };
}

function stepDetail(step) {
  switch (step.action) {
    case "detect_incoming":
      return step.timeoutSec ? `timeout: ${step.timeoutSec}s` : "";
    case "start_supervisor":
      return step.queue ? `queue: ${step.queue}` : "";
    case "verify_transcript":
      return step.expectPhrase ? `phrase: "${step.expectPhrase}"` : "any growth";
    case "send_dtmf_sequence":
      return `digits: ${step.digits}${step.label ? ` (${step.label})` : ""}`;
    case "wait_for_ivr_prompt":
      return step.timeoutSec ? `timeout: ${step.timeoutSec}s` : "";
    case "play_agent_audio":
      return step.text ? `"${step.text.slice(0, 40)}${step.text.length > 40 ? "..." : ""}"` : "";
    case "play_caller_audio":
      return step.text ? `"${step.text.slice(0, 40)}${step.text.length > 40 ? "..." : ""}"` : "";
    case "wait_for_transcript":
      return step.contains ? `contains: "${step.contains}"` : "any text";
    case "hold_call":
      return "put on hold";
    case "resume_call":
      return "take off hold";
    case "end_call":
      return "agent hangs up";
    case "wait":
      return step.seconds ? `${step.seconds}s` : "";
    case "complete_acw":
      return step.disposition ? `disposition: ${step.disposition}` : "";
    case "listen_for_prompt":
      return step.promptText ? `"${step.promptText}"` : "";
    case "leave_voicemail":
      return step.voicemailText ? `"${step.voicemailText.slice(0, 40)}${step.voicemailText.length > 40 ? "..." : ""}"` : "";
    case "request_callback":
      return step.callbackPhone ? `phone: ${step.callbackPhone}` : "";
    case "wait_for_disconnect":
      return step.timeoutSec ? `timeout: ${step.timeoutSec}s` : "";
    case "decline_call":
      return step.declineReason || "";
    default:
      return "";
  }
}

function optionCard(value, title, desc, selected) {
  return `
    <div class="option-card ${selected ? "selected" : ""}" data-value="${value}">
      <div class="oc-check">${selected ? "&#x2713;" : ""}</div>
      <div class="oc-title">${title}</div>
      <div class="oc-desc">${desc}</div>
    </div>
  `;
}

function val(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : "";
}

function isChecked(id) {
  const el = document.getElementById(id);
  return el ? el.checked : false;
}

function getSelectedOption(name) {
  const selected = document.querySelector(`[data-name="${name}"] .option-card.selected`);
  return selected ? selected.dataset.value : null;
}

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function esc(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

function toast(message, type = "info") {
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ── Run Panel ──────────────────────────────────────────────────────────────

const runState = {
  active: false,
  eventSource: null,
  timerInterval: null,
  startTime: null,
  scenarioStatuses: {},
};

function openRunPanel(autoStart) {
  if (!state.currentSuiteFile) {
    toast("Select a suite first", "error");
    return;
  }

  const panel = document.getElementById("run-panel");
  const landing = document.getElementById("landing");
  const wizard = document.getElementById("wizard");
  const preview = document.getElementById("preview-panel");

  landing.classList.add("hidden");
  wizard.classList.add("hidden");
  preview.classList.add("hidden");
  panel.classList.remove("hidden");

  // Build scenario cards from current suite
  renderRunScenarioCards();
  resetRunUI();

  if (autoStart) startRun(false);
}

function closeRunPanel() {
  if (runState.active) {
    if (!confirm("A run is in progress. Close anyway?")) return;
    stopRun();
  }
  document.getElementById("run-panel").classList.add("hidden");
  showLanding();
}

function renderRunScenarioCards() {
  const container = document.getElementById("run-scenarios");
  const scenarios = state.currentSuite?.scenarios || [];
  runState.scenarioStatuses = {};
  container.innerHTML = scenarios
    .map((s) => {
      runState.scenarioStatuses[s.id] = "pending";
      const enabledLabel = s.enabled === false ? " (disabled)" : "";
      return `
        <div class="run-sc-card" id="run-sc-${slugify(s.id)}" data-id="${esc(s.id)}">
          <div class="run-sc-id">${esc(s.id)}${enabledLabel}</div>
          <div class="run-sc-status">Pending</div>
        </div>
      `;
    })
    .join("");
}

function resetRunUI() {
  document.getElementById("run-status-dot").className = "run-status-dot";
  document.getElementById("run-timer").textContent = "00:00";
  document.getElementById("run-terminal-body").innerHTML =
    '<div class="run-terminal-placeholder">Click "Run" or "Dry Run" to start execution</div>';
  document.getElementById("run-summary").classList.add("hidden");
  document.getElementById("btn-run-stop").classList.add("hidden");
  if (runState.timerInterval) {
    clearInterval(runState.timerInterval);
    runState.timerInterval = null;
  }
}

async function startRun(dryRun) {
  if (runState.active) {
    toast("A run is already in progress", "error");
    return;
  }

  // Reset UI
  renderRunScenarioCards();
  document.getElementById("run-terminal-body").innerHTML = "";
  document.getElementById("run-summary").classList.add("hidden");
  document.getElementById("btn-run-stop").classList.remove("hidden");

  const dot = document.getElementById("run-status-dot");
  dot.className = "run-status-dot running";

  const title = document.getElementById("run-title");
  title.textContent = dryRun ? "Dry Run" : "Suite Execution";

  // Start timer
  runState.startTime = Date.now();
  runState.timerInterval = setInterval(updateRunTimer, 1000);
  updateRunTimer();

  // Kick off the run
  try {
    const res = await api("/run", {
      method: "POST",
      body: JSON.stringify({
        suiteFile: state.currentSuiteFile,
        dryRun,
      }),
    });

    if (res.error) {
      appendRunLine("error", res.error);
      endRun("failed");
      return;
    }

    runState.active = true;
    appendRunLine("header", `Run started: ${res.runId}  (${dryRun ? "dry run" : "live execution"})`);

    // Connect SSE stream
    const es = new EventSource("/api/run/stream");
    runState.eventSource = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleRunEvent(data);
      } catch (_) {}
    };

    es.onerror = () => {
      es.close();
      runState.eventSource = null;
      if (runState.active) {
        endRun("failed");
      }
    };
  } catch (err) {
    appendRunLine("error", `Failed to start run: ${err.message}`);
    endRun("failed");
  }
}

async function stopRun() {
  try {
    await api("/run/stop", { method: "POST" });
  } catch (_) {}
  if (runState.eventSource) {
    runState.eventSource.close();
    runState.eventSource = null;
  }
  endRun("failed");
  appendRunLine("error", "Run stopped by user");
}

function handleRunEvent(data) {
  switch (data.type) {
    case "log": {
      // Detect scenario transitions from output
      const text = data.text;
      const scenarioLine = parseScenarioLine(text);
      if (scenarioLine) {
        updateScenarioCard(scenarioLine.id, scenarioLine.status);
        const cls = scenarioLine.status === "passed" ? "pass"
          : scenarioLine.status === "failed" ? "fail"
          : scenarioLine.status === "running" ? "scenario"
          : "log";
        appendRunLine(cls, text);
      } else if (text.includes("--- Declarative Bridge Mapping ---") || text.includes("E2E suite:")) {
        appendRunLine("header", text);
      } else {
        appendRunLine("log", text);
      }
      break;
    }
    case "scenario":
      appendRunLine("scenario", data.text);
      break;
    case "error":
      appendRunLine("error", data.text);
      break;
    case "done":
      endRun(data.status || (data.code === 0 ? "passed" : "failed"));
      break;
  }
}

function parseScenarioLine(text) {
  // Match patterns from run-instance-e2e-suite.mjs output
  const runMatch = text.match(/Running scenario (\d+)\/\d+:\s+(\S+)/);
  if (runMatch) return { id: runMatch[2], status: "running" };

  const passMatch = text.match(/PASS\s+(\S+)/);
  if (passMatch) return { id: passMatch[1], status: "passed" };

  const failMatch = text.match(/FAIL\s+(\S+)/);
  if (failMatch) return { id: failMatch[1], status: "failed" };

  const skipMatch = text.match(/SKIP\s+(\S+)/);
  if (skipMatch) return { id: skipMatch[1], status: "skipped" };

  return null;
}

function updateScenarioCard(scenarioId, status) {
  runState.scenarioStatuses[scenarioId] = status;
  // Try to find card by ID slug
  const slug = slugify(scenarioId);
  const card = document.getElementById(`run-sc-${slug}`);
  if (!card) return;

  card.className = `run-sc-card ${status}`;
  const statusEl = card.querySelector(".run-sc-status");
  const labels = {
    pending: "Pending",
    running: "Running...",
    passed: "Passed",
    failed: "Failed",
    skipped: "Skipped",
  };
  if (statusEl) statusEl.textContent = labels[status] || status;
}

function appendRunLine(type, text) {
  const body = document.getElementById("run-terminal-body");
  // Remove placeholder
  const ph = body.querySelector(".run-terminal-placeholder");
  if (ph) ph.remove();

  const line = document.createElement("div");

  if (type === "done-status") {
    line.className = `run-line run-line-done ${text.includes("passed") ? "passed" : "failed"}`;
    line.textContent = text;
  } else {
    line.className = `run-line run-line-${type}`;
    line.textContent = text;
  }

  body.appendChild(line);

  // Auto-scroll to bottom
  body.scrollTop = body.scrollHeight;
}

function endRun(status) {
  runState.active = false;

  if (runState.eventSource) {
    runState.eventSource.close();
    runState.eventSource = null;
  }
  if (runState.timerInterval) {
    clearInterval(runState.timerInterval);
    runState.timerInterval = null;
  }

  const dot = document.getElementById("run-status-dot");
  dot.className = `run-status-dot ${status}`;

  document.getElementById("btn-run-stop").classList.add("hidden");

  // Show summary
  const statuses = Object.values(runState.scenarioStatuses);
  const passed = statuses.filter((s) => s === "passed").length;
  const failed = statuses.filter((s) => s === "failed").length;
  const skipped = statuses.filter((s) => s === "skipped" || s === "pending").length;
  const total = statuses.length;

  const summaryEl = document.getElementById("run-summary");
  summaryEl.classList.remove("hidden");
  document.getElementById("run-summary-stats").innerHTML = `
    <span class="run-stat-total">${total} scenarios</span>
    <span class="run-stat-pass">${passed} passed</span>
    <span class="run-stat-fail">${failed} failed</span>
    ${skipped > 0 ? `<span class="run-stat-skip">${skipped} skipped</span>` : ""}
  `;

  // Final line in terminal
  const elapsed = runState.startTime ? formatRunTime(Date.now() - runState.startTime) : "0s";
  appendRunLine(
    "done-status",
    status === "passed"
      ? `Suite passed (${passed}/${total} scenarios) in ${elapsed}`
      : `Suite finished with failures (${passed} passed, ${failed} failed) in ${elapsed}`
  );
}

function updateRunTimer() {
  if (!runState.startTime) return;
  const elapsed = Date.now() - runState.startTime;
  document.getElementById("run-timer").textContent = formatRunTime(elapsed);
}

function formatRunTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function clearRunTerminal() {
  document.getElementById("run-terminal-body").innerHTML = "";
}
