import { expect, Locator, Page, test, type BrowserContext } from "@playwright/test";
import fs from "node:fs";
import { dialInboundCall, hangupCall } from "../src/twilioInbound";
import { dialFromConnectCcp } from "../src/connectCcpDialer";
import type { ConnectCcpSession } from "../src/connectCcpDialer";
import {
  escapeRegex,
  resolveSalesforceStartTarget,
  gotoWithLightningRedirectTolerance,
  assertLoginSucceeded,
  assertAuthenticatedConsolePage,
  closeAppLauncherIfOpen,
  ensureSalesforceApp,
  ensureAnySalesforceApp,
} from "../src/sfNavigation";
import {
  leftRailButton,
  openOmniWorkPanel,
  exitOmniSettingsViewIfOpen,
  ensureOmniPhoneTabOpen,
  ensureOmniPhoneTabSelectedIfVisible,
  ensurePhoneUtilityOpen,
  assertOmniStatus,
  forceOmniStatusSelection,
  ensureOmniStatus,
  dismissPresenceAppSwitchBanner,
  dismissSalesforceSetupDialogs,
  isOmniOffline,
} from "../src/sfOmniChannel";
import {
  voiceCallTabs,
  countVoiceCallTabs,
  getMaxVoiceCallNumber,
  getInboxCount,
  hasIncomingUiIndicator,
  hasConnectedCallUiIndicator,
  waitForConnectedCallIndicator,
  type IncomingSignalType,
} from "../src/sfCallDetection";
import {
  clickAcceptControl,
  acceptCallIfPresented,
  forceAcceptFromOmniInbox,
  clickLikelyOmniWorkItem,
  minimizeConnectionStatusDialogIfOpen,
} from "../src/sfCallAccept";
import {
  focusLatestVoiceCallTab,
  focusVoiceCallRecordSurface,
  readVoiceCallRecordSnapshot,
  getActiveVoiceCallId,
  waitForFieldValueByLabel,
  readFieldValueByLabel,
} from "../src/sfScreenPop";
import {
  startSupervisorQueueObserver,
  startSupervisorAgentObserver,
  ensureOmniSupervisorSurfaceOpen,
  openSupervisorSurfaceFromAppLauncher,
  ensureSupervisorServiceRepsSurfaceOpen,
  ensureSupervisorQueuesBacklogSurfaceOpen,
  ensureSupervisorInProgressWorkSurfaceOpen,
  waitForSupervisorQueueWaiting,
  waitForSupervisorAgentOffer,
  readSupervisorQueueWaitingCount,
  readSupervisorInProgressWorkSnapshot,
  readSupervisorQueueSnapshot,
  readSupervisorAgentOfferSnapshot,
  readQueueWaitingFromTable,
  readInProgressWorkFromTable,
  clickLikelyQueueBacklogControl,
  clickLikelyServiceRepsControl,
  clickLikelyInProgressWorkControl,
  discoverQueueBacklogSurface,
  extractQueueWaitingCount,
  extractInProgressCount,
  normalizeSignatureText,
  renderSupervisorMonitorOverlay,
  type SupervisorQueueObservation,
  type SupervisorQueueObserverSession,
  type SupervisorAgentOfferObservation,
  type SupervisorAgentObserverSession,
} from "../src/sfSupervisorObserver";
import {
  verifyRealtimeTranscript,
  waitForTranscriptWidget,
  readTranscriptWidget,
  normalizeTranscriptText,
  type TranscriptWidgetSnapshot,
} from "../src/sfTranscript";
import {
  formatAssertionDetails,
  pushVisualAssertion,
  renderAssertionOverlay,
  renderAssertionSummary,
  type VisualAssertionEntry,
} from "../src/sfOverlays";

test.describe("Salesforce Service Cloud Voice Inbound E2E", () => {
  test("dials Connect number and verifies incoming call + VoiceCall screen pop", async ({ page }) => {
    const requiredAssertions = [
      "Call connected",
      "VoiceCall record created",
      "Call type = Inbound",
      "Owner = correct agent"
    ];
    const assertionLog: VisualAssertionEntry[] = [];
    const timeline: E2eTimeline = {
      testStartMs: Date.now(),
      callTriggerMode: (process.env.CALL_TRIGGER_MODE ?? "twilio").toLowerCase()
    };
    const skipLogin = process.env.SF_SKIP_LOGIN === "true";
    const callTriggerMode = (process.env.CALL_TRIGGER_MODE ?? "twilio").toLowerCase();
    const callExpectation = (process.env.CALL_EXPECTATION ?? "agent_offer").toLowerCase();
    const serviceConsoleUrl = process.env.SF_SERVICE_CONSOLE_URL?.trim() || "";
    const appName = process.env.SF_APP_NAME?.trim() || "Service Console";
    const ringTimeoutSec = Number(process.env.VOICE_RING_TIMEOUT_SEC ?? 75);
    const preflightDetailHoldSec = Number(process.env.PREFLIGHT_DETAIL_HOLD_SEC ?? 2);
    const postAcceptHoldSec = Number(process.env.VOICE_POST_ACCEPT_HOLD_SEC ?? 6);
    const transcriptEnabled = process.env.VERIFY_REALTIME_TRANSCRIPT === "true";
    const verifySupervisorQueue = isTruthyEnv(process.env.VERIFY_SUPERVISOR_QUEUE_WAITING);
    const supervisorQueueName = process.env.SUPERVISOR_QUEUE_NAME?.trim() || "";
    const supervisorAppName = process.env.SUPERVISOR_APP_NAME?.trim() || "Supervisor Console";
    const supervisorSurfaceName =
      process.env.SUPERVISOR_SURFACE_NAME?.trim() || supervisorAppName;
    const supervisorTimeoutSec = Number(process.env.SUPERVISOR_QUEUE_WAIT_TIMEOUT_SEC ?? 90);
    const verifySupervisorAgentOffer =
      verifySupervisorQueue && !/^(false|0|no|off)$/i.test((process.env.VERIFY_SUPERVISOR_AGENT_OFFER ?? "true").trim());
    const supervisorAgentName =
      process.env.SUPERVISOR_AGENT_NAME?.trim() ||
      process.env.VOICECALL_EXPECTED_OWNER?.trim() ||
      "";
    const supervisorAgentOfferTimeoutSec = Number(
      process.env.SUPERVISOR_AGENT_OFFER_TIMEOUT_SEC ?? Math.max(60, supervisorTimeoutSec)
    );
    const transcriptWaitSec = Number(process.env.TRANSCRIPT_WAIT_SEC ?? 60);
    const timeoutPaddingSec =
      (transcriptEnabled ? transcriptWaitSec + 120 : 90) + preflightDetailHoldSec * 3 + postAcceptHoldSec;
    test.setTimeout((ringTimeoutSec + timeoutPaddingSec) * 1000);
    if (callTriggerMode !== "twilio" && callTriggerMode !== "manual" && callTriggerMode !== "connect_ccp") {
      throw new Error(`Unsupported CALL_TRIGGER_MODE: ${callTriggerMode}`);
    }
    if (callExpectation !== "agent_offer" && callExpectation !== "business_hours_blocked") {
      throw new Error(`Unsupported CALL_EXPECTATION: ${callExpectation}`);
    }
    if (verifySupervisorQueue) {
      requiredAssertions.push("Supervisor queue waiting observed");
    }
    if (verifySupervisorAgentOffer) {
      requiredAssertions.push("Supervisor agent offer observed");
    }

    let serviceConsoleBaseUrl = process.env.SF_INSTANCE_URL ?? "";
    if (!skipLogin) {
      const loginUrl = requiredEnv("SF_LOGIN_URL");
      const username = requiredEnv("SF_USERNAME");
      const password = requiredEnv("SF_PASSWORD");

      await page.goto(loginUrl);
      await page.getByLabel("Username").fill(username);
      await page.getByLabel("Password").fill(password);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.getByRole("button", { name: /log in/i }).click()
      ]);
      await page.waitForTimeout(2000);
      await assertLoginSucceeded(page);
      serviceConsoleBaseUrl = page.url();
    }

    const serviceConsoleTarget = resolveSalesforceStartTarget({
      serviceConsoleUrl,
      appUrl: process.env.SF_APP_URL?.trim() || "",
      baseUrl: serviceConsoleBaseUrl || process.env.SF_INSTANCE_URL?.trim() || ""
    });
    if (!serviceConsoleTarget && skipLogin) {
      throw new Error(
        "SF_SERVICE_CONSOLE_URL is not set and SF_INSTANCE_URL is missing. Set SF_INSTANCE_URL for app-launcher startup in SF_SKIP_LOGIN mode."
      );
    }
    if (serviceConsoleTarget) {
      await gotoWithLightningRedirectTolerance(page, serviceConsoleTarget);
    }
    await assertAuthenticatedConsolePage(page);
    await ensureSalesforceApp(page, appName);
    await dismissSalesforceSetupDialogs(page);
    await ensurePhoneUtilityOpen(page);
    const uiReadiness = await collectUiReadiness(page, appName);
    test.info().annotations.push({
      type: "ui.readiness",
      description: JSON.stringify(uiReadiness)
    });
    const targetOmniStatus = process.env.OMNI_TARGET_STATUS?.trim() || "Available";
    const preflight = await assertAgentPreflightReady(page, targetOmniStatus);
    test.info().annotations.push({
      type: "agent.preflight",
      description: JSON.stringify(preflight)
    });
    await pushVisualAssertion(page, assertionLog, {
      label: "Preflight: Omni-Channel ready",
      passed: true,
      details: preflight.omniStatus
    });
    await holdForVideo(page, preflightDetailHoldSec * 1000);
    await pushVisualAssertion(page, assertionLog, {
      label: "Preflight: Provider status synced",
      passed: preflight.providerState === "routable",
      details: `Provider state=${preflight.providerState}`
    });
    await holdForVideo(page, preflightDetailHoldSec * 1000);
    timeline.preflightReadyMs = Date.now();

    let baselineVoiceTabs = await countVoiceCallTabs(page);
    let baselineMaxVoiceCallNumber = await getMaxVoiceCallNumber(page);
    let baselineInboxCount = await getInboxCount(page);
    let twilioCallSid: string | undefined;
    let connectCcpSession: ConnectCcpSession | undefined;
    let supervisorSession: SupervisorQueueObserverSession | undefined;
    let supervisorAgentSession: SupervisorAgentObserverSession | undefined;
    try {
      if (verifySupervisorQueue) {
        supervisorSession = await startSupervisorQueueObserver({
          agentPage: page,
          targetUrl: serviceConsoleTarget || page.url(),
          appName,
          supervisorAppName,
          supervisorSurfaceName,
          queueName: supervisorQueueName,
          timeoutMs: Math.max(15_000, supervisorTimeoutSec * 1000),
          videoDir: process.env.SUPERVISOR_VIDEO_DIR?.trim() || "test-results/sf-supervisor-video"
        });
        timeline.supervisorObserverStartedMs = Date.now();
        await pushVisualAssertion(page, assertionLog, {
          label: "Supervisor observer started",
          passed: true,
          details: supervisorQueueName ? `queue=${supervisorQueueName}` : "queue=auto-detect"
        });
        if (verifySupervisorAgentOffer) {
          supervisorAgentSession = await startSupervisorAgentObserver({
            agentPage: page,
            targetUrl: serviceConsoleTarget || page.url(),
            appName,
            supervisorAppName,
            supervisorSurfaceName,
            agentName: supervisorAgentName,
            timeoutMs: Math.max(20_000, supervisorAgentOfferTimeoutSec * 1000),
            videoDir:
              process.env.SUPERVISOR_AGENT_VIDEO_DIR?.trim() || "test-results/sf-supervisor-agent-video"
          });
          timeline.supervisorAgentObserverStartedMs = Date.now();
          await pushVisualAssertion(page, assertionLog, {
            label: "Supervisor agent observer started",
            passed: true,
            details: supervisorAgentName ? `agent=${supervisorAgentName}` : "agent=auto-detect"
          });
        }
      }

      // After supervisor tabs open in the same context, bring the agent page
      // back to the foreground so the CTI adapter delivers call notifications.
      // Reloading would kill the provider session, so instead we rely on delta
      // signal detection (new VoiceCall tab / inbox increment) which fires even
      // when the CTI toast is suppressed by multi-tab disruption.
      // Only reload if Omni has already gone Offline (session truly broken).
      if (verifySupervisorQueue) {
        await page.bringToFront();
        await page.waitForTimeout(2000);

        if (await isOmniOffline(page)) {
          await page.reload({ waitUntil: "domcontentloaded" });
          await page.waitForTimeout(5000);
          // Omni must go Online FIRST — provider becomes routable only after.
          await ensurePhoneUtilityOpen(page);
          await ensureOmniStatus(page, targetOmniStatus);
          // Wait for provider to catch up (capped at 60s to stay within test timeout).
          const providerRecoveryMs = Math.min(
            60_000,
            Math.max(30_000, Number(process.env.PROVIDER_LOGIN_TIMEOUT_SEC ?? 60) * 1000)
          );
          const providerDeadline = Date.now() + providerRecoveryMs;
          await openConnectionStatusPanel(page).catch(() => undefined);
          while (Date.now() < providerDeadline) {
            const snapshot = await collectProviderStatusSnapshot(page);
            if (parseProviderState(snapshot) === "routable") {
              break;
            }
            await clickProviderSyncIfPresent(page);
            await page.waitForTimeout(2000);
          }
          await minimizeConnectionStatusDialogIfOpen(page);
        }

        await ensurePhoneUtilityOpen(page);
        await ensureOmniStatus(page, targetOmniStatus);

        // Re-capture baselines so delta signal detection is accurate.
        baselineVoiceTabs = await countVoiceCallTabs(page);
        baselineMaxVoiceCallNumber = await getMaxVoiceCallNumber(page);
        baselineInboxCount = await getInboxCount(page);
      }

      if (callTriggerMode === "twilio") {
        timeline.callTriggerStartMs = Date.now();
        const twilioCall = await dialInboundCall({
          accountSid: requiredEnv("TWILIO_ACCOUNT_SID"),
          authToken: requiredEnv("TWILIO_AUTH_TOKEN"),
          from: requiredEnv("TWILIO_FROM_NUMBER"),
          to: requiredEnv("CONNECT_ENTRYPOINT_NUMBER")
        });
        twilioCallSid = twilioCall.callSid;
        test.info().annotations.push({
          type: "twilio.callSid",
          description: twilioCall.callSid
        });
      } else if (callTriggerMode === "connect_ccp") {
        timeline.callTriggerStartMs = Date.now();
        const browser = page.context().browser();
        if (!browser) {
          throw new Error("Playwright browser instance is unavailable for Connect CCP dial mode.");
        }
        connectCcpSession = await dialFromConnectCcp({
          videoDir: process.env.CONNECT_CCP_VIDEO_DIR?.trim() || "test-results/connect-ccp-video",
          browser,
          ccpUrl: requiredEnv("CONNECT_CCP_URL"),
          storageStatePath: process.env.CONNECT_STORAGE_STATE || ".auth/connect-ccp.json",
          to: requiredEnv("CONNECT_ENTRYPOINT_NUMBER"),
          dialTimeoutMs: Number(process.env.CONNECT_DIAL_TIMEOUT_SEC ?? 20_000),
          dtmfDigits: process.env.CONNECT_CCP_IVR_DIGITS?.trim() || "",
          dtmfMinCallElapsedSec: Number(process.env.CONNECT_CCP_DTMF_MIN_CALL_ELAPSED_SEC ?? 4),
          dtmfInitialDelayMs: Number(process.env.CONNECT_CCP_IVR_INITIAL_DELAY_MS ?? 0),
          dtmfInterDigitDelayMs: Number(process.env.CONNECT_CCP_IVR_INTER_DIGIT_DELAY_MS ?? 420),
          dtmfPostDelayMs: Number(process.env.CONNECT_CCP_IVR_POST_DELAY_MS ?? 1200)
        });
        timeline.callTriggerStartMs = timeline.callTriggerStartMs ?? Date.now();
        timeline.ccpDialConfirmedMs = connectCcpSession.dialStartedAtMs ?? Date.now();
        test.info().annotations.push({
          type: "connect.ccp.dialed",
          description: requiredEnv("CONNECT_ENTRYPOINT_NUMBER")
        });
      } else {
        timeline.callTriggerStartMs = Date.now();
        test.info().annotations.push({
          type: "manual.call.required",
          description:
            "Place a real inbound call to your Amazon Connect entry number while this test waits for incoming signal."
        });
        // Small pause to let operator start the manual call.
        await page.waitForTimeout(3000);
      }

      const queueObservationPromise =
        verifySupervisorQueue && supervisorSession ? supervisorSession.observation : null;
      const agentOfferObservationPromise =
        verifySupervisorAgentOffer && supervisorAgentSession ? supervisorAgentSession.observation : null;
      let supervisorDirectObservation: SupervisorQueueObservation | null = null;
      // Delta signals (new VoiceCall tab / inbox increment) are safe even with
      // supervisor tabs because supervisors open Command Center — not VoiceCall
      // pages.  Baselines are re-captured after reload so deltas are accurate.
      const allowDeltaSignalsInSupervisor = !/^(false|0|no|off)$/i.test(
        (process.env.ALLOW_DELTA_SIGNALS_IN_SUPERVISOR ?? "true").trim()
      );
      const requireSupervisorBeforeAccept =
        verifySupervisorQueue &&
        !/^(false|0|no|off)$/i.test((process.env.SUPERVISOR_CHECK_BEFORE_ACCEPT ?? "true").trim());
      const requirePreAcceptObservation =
        requireSupervisorBeforeAccept &&
        /^(true|1|yes|on)$/i.test(
          (process.env.SUPERVISOR_REQUIRE_PRE_ACCEPT_OBSERVATION ?? "true").trim()
        );
      const supervisorBeforeAcceptWaitMs = Math.max(
        0,
        Number(process.env.SUPERVISOR_BEFORE_ACCEPT_WAIT_MS ?? 3000)
      );
      let supervisorQueueSeen = false;
      if (queueObservationPromise) {
        queueObservationPromise
          .then(() => {
            supervisorQueueSeen = true;
          })
          .catch(() => undefined);
      }
      let supervisorAgentOfferSeen = false;
      if (agentOfferObservationPromise) {
        agentOfferObservationPromise
          .then(() => {
            supervisorAgentOfferSeen = true;
          })
          .catch(() => undefined);
      }

      const incomingDetected = await waitForIncomingSignal(page, {
        baselineVoiceTabs,
        baselineMaxVoiceCallNumber,
        baselineInboxCount,
        targetStatus: process.env.OMNI_TARGET_STATUS?.trim() || "Available",
        timeoutMs: verifySupervisorQueue
          ? Math.max(ringTimeoutSec * 1000, Number(process.env.OFFER_AFTER_QUEUE_TIMEOUT_SEC ?? 90) * 1000)
          : ringTimeoutSec * 1000,
        autoAccept: !requireSupervisorBeforeAccept,
        allowDeltaSignals: !verifySupervisorQueue || allowDeltaSignalsInSupervisor,
        shouldForceAccept: requireSupervisorBeforeAccept
          ? () => false
          : () => supervisorAgentOfferSeen
      });
      if (callExpectation === "business_hours_blocked") {
        expect(
          incomingDetected.detected,
          "Business-hours-blocked scenario should not present inbound to agent"
        ).toBeFalsy();
        return;
      }

      if (!incomingDetected.detected) {
        const observerFinalizeWaitMs = Math.max(
          1000,
          Number(process.env.OBSERVER_FINALIZE_WAIT_SEC ?? 5) * 1000
        );
        if (queueObservationPromise) {
          await settleOptionalObserverAssertion(page, assertionLog, {
            label: "Supervisor queue waiting observed",
            observation: queueObservationPromise,
            waitMs: observerFinalizeWaitMs,
            onSuccess: (observed) => {
              timeline.supervisorQueueObservedMs = observed.observedAtMs;
              const queueLabel = observed.queueName || supervisorQueueName || "detected";
              return `queue=${queueLabel}, metric=${observed.metric}, count=${observed.observedCount}, source=${observed.source}`;
            }
          });
        }
        if (agentOfferObservationPromise) {
          await settleOptionalObserverAssertion(page, assertionLog, {
            label: "Supervisor agent offer observed",
            observation: agentOfferObservationPromise,
            waitMs: observerFinalizeWaitMs,
            onSuccess: (observed) => {
              timeline.supervisorAgentOfferObservedMs = observed.observedAtMs;
              return observed.details;
            }
          });
        }
        const postWait = await collectUiReadiness(page, appName);
        throw new Error(
          `Expected inbound-call signal in Salesforce UI. In manual mode, place the call during wait window. Readiness=${JSON.stringify(
            postWait
          )}`
        );
      }
      timeline.incomingDetectedMs = Date.now();

      if (requireSupervisorBeforeAccept && supervisorSession && !incomingDetected.acceptedByClick) {
        // Race the already-running background observer promise against a timeout
        // instead of starting a second concurrent polling loop on the same page.
        const preAcceptObserved = queueObservationPromise
          ? await Promise.race([
              queueObservationPromise.then((obs) => obs as SupervisorQueueObservation),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), supervisorBeforeAcceptWaitMs))
            ]).catch(() => null)
          : await observeQueueBacklogTotalWaitingDuringRinging(
              supervisorSession.page,
              {
                queueName: supervisorSession.queueName || supervisorQueueName,
                baselineWaitingCount: supervisorSession.baselineWaitingCount,
                timeoutMs: supervisorBeforeAcceptWaitMs
              }
            );
        if (preAcceptObserved) {
          supervisorDirectObservation = preAcceptObserved;
          timeline.supervisorQueueObservedMs = preAcceptObserved.observedAtMs;
          const queueLabel = preAcceptObserved.queueName || supervisorQueueName || "detected";
          await pushVisualAssertion(page, assertionLog, {
            label: "Supervisor pre-accept check",
            passed: true,
            details: `queue=${queueLabel}, metric=${preAcceptObserved.metric}, count=${preAcceptObserved.observedCount}, source=${preAcceptObserved.source}`
          });
        } else {
          await pushVisualAssertion(page, assertionLog, {
            label: "Supervisor pre-accept check",
            passed: false,
            details: `Not observed within ${Math.round(supervisorBeforeAcceptWaitMs)}ms; proceeding to accept to avoid timeout`
          });
          if (requirePreAcceptObservation) {
            throw new Error(
              `Supervisor pre-accept observation was required but not seen within ${Math.round(
                supervisorBeforeAcceptWaitMs
              )}ms.`
            );
          }
        }
      }

      const acceptedByClick = incomingDetected.acceptedByClick || (await acceptCallIfPresented(page));
      if (acceptedByClick) {
        timeline.acceptClickedMs = Date.now();
      }
      test.info().annotations.push({
        type: "voice.accept.clicked",
        description: String(acceptedByClick)
      });
      test.info().annotations.push({
        type: "voice.incoming.signal",
        description: incomingDetected.signal
      });

      const requireAcceptClick = process.env.REQUIRE_ACCEPT_CLICK === "true";
      if (requireAcceptClick && !acceptedByClick) {
        throw new Error(
          "Inbound signal detected, but automation did not click Accept/Answer. Call likely remained ringing."
        );
      }

      if (queueObservationPromise) {
        const allowInProgressInAssertion = !/^(false|0|no|off)$/i.test(
          (process.env.SUPERVISOR_ALLOW_IN_PROGRESS_FALLBACK ?? "false").trim()
        );
        await assertAndMark(page, assertionLog, "Supervisor queue waiting observed", async () => {
          const observed =
            supervisorDirectObservation ??
            (requireSupervisorBeforeAccept
              ? null
              : await waitForObservationWithin(queueObservationPromise, Math.max(1000, supervisorBeforeAcceptWaitMs)));
          if (!observed) {
            throw new Error(
              "Supervisor queue waiting assertion requires a real Queue Backlog Total Waiting increase during ringing, but none was observed."
            );
          }
          const validMetrics: string[] = ["queue_waiting"];
          if (allowInProgressInAssertion) validMetrics.push("in_progress_work");
          if (!validMetrics.includes(observed.metric)) {
            throw new Error(
              `Supervisor queue waiting assertion expected ${validMetrics.join(" or ")} metric, got "${observed.metric}".`
            );
          }
          // Validate source: queue_waiting must come from table Total Waiting;
          // in_progress_work comes from the in_progress_table.
          const sourceValid =
            observed.metric === "in_progress_work"
              ? /in_progress/i.test(observed.source)
              : /^table:/i.test(observed.source) && /total\s*waiting/i.test(observed.source);
          if (!sourceValid) {
            throw new Error(
              `Supervisor queue waiting assertion expected valid source for ${observed.metric}, got "${observed.source}".`
            );
          }
          timeline.supervisorQueueObservedMs = observed.observedAtMs;
          const queueLabel = observed.queueName || supervisorQueueName || "detected";
          return `queue=${queueLabel}, metric=${observed.metric}, count=${observed.observedCount}, source=${observed.source}`;
        });
      }
      if (agentOfferObservationPromise) {
        await assertAndMark(page, assertionLog, "Supervisor agent offer observed", async () => {
          const observed = await agentOfferObservationPromise;
          timeline.supervisorAgentOfferObservedMs = observed.observedAtMs;
          return observed.details;
        });
      }
      await holdForVideo(page, Math.max(0, Number(process.env.SUPERVISOR_POST_QUEUE_HOLD_SEC ?? 2) * 1000));

      const screenPopDetected = await waitForVoiceCallScreenPop(page, {
        baselineVoiceTabs,
        baselineMaxVoiceCallNumber,
        targetStatus: process.env.OMNI_TARGET_STATUS?.trim() || "Available",
        timeoutMs: 45_000
      });
      expect(screenPopDetected, "Expected VoiceCall tab/screen pop after inbound call").toBeTruthy();
      timeline.screenPopDetectedMs = Date.now();
      const focusedVoiceCallTab = await focusLatestVoiceCallTab(page, 12_000);
      test.info().annotations.push({
        type: "voice.tab.focused",
        description: String(focusedVoiceCallTab)
      });
      if (!focusedVoiceCallTab) {
        throw new Error(
          "Inbound call was detected, but automation could not focus an active Voice Call tab from object-linking/workspace tabs."
        );
      }
      await holdForVideo(page, postAcceptHoldSec * 1000);

      await assertAndMark(page, assertionLog, "Call connected", async () => {
        const connected = await waitForConnectedCallIndicator(page, 20_000);
        expect(connected, "Expected call to be connected after accept").toBeTruthy();
        return "Connected call controls visible.";
      });

      const voiceCallSnapshot = await assertAndMark(page, assertionLog, "VoiceCall record created", async () => {
        const snapshot = await readVoiceCallRecordSnapshot(page, 15_000);
        expect(snapshot.id, "Expected active VC-* identifier").toMatch(/^VC-\d+/i);
        return snapshot;
      });

      await assertAndMark(page, assertionLog, "Call type = Inbound", async () => {
        const callType = voiceCallSnapshot.callType || (await waitForFieldValueByLabel(page, /call type/i, 12_000));
        expect(/inbound/i.test(callType), `Expected Call Type to be Inbound, got "${callType}"`).toBeTruthy();
        return `Call Type="${callType}"`;
      });

      await assertAndMark(page, assertionLog, "Owner = correct agent", async () => {
        const owner =
          voiceCallSnapshot.owner || (await waitForFieldValueByLabel(page, /owner name|owner/i, 12_000));
        const expectedOwner = process.env.VOICECALL_EXPECTED_OWNER?.trim() || "";
        if (expectedOwner) {
          expect(
            owner.toLowerCase().includes(expectedOwner.toLowerCase()),
            `Expected owner to include "${expectedOwner}", got "${owner}"`
          ).toBeTruthy();
          return `Owner="${owner}" (expected="${expectedOwner}")`;
        }
        expect(owner.length > 0, "Expected owner field to be populated").toBeTruthy();
        return `Owner="${owner}" (expected owner not configured)`;
      });

      if (process.env.VERIFY_REALTIME_TRANSCRIPT === "true") {
        const transcriptResult = await verifyRealtimeTranscript(page, {
          timeoutMs: Number(process.env.TRANSCRIPT_WAIT_SEC ?? 60) * 1000,
          expectedPhrase: process.env.TRANSCRIPT_EXPECT_PHRASE?.trim() || "",
          minGrowthChars: Number(process.env.TRANSCRIPT_MIN_GROWTH_CHARS ?? 12),
          requireRightSide: process.env.TRANSCRIPT_REQUIRE_RIGHT_SIDE !== "false"
        });
        test.info().annotations.push({
          type: "voice.transcript.verified",
          description: JSON.stringify(transcriptResult)
        });
      }
    } finally {
      if (callTriggerMode === "twilio" && twilioCallSid && process.env.TWILIO_AUTO_HANGUP !== "false") {
        await hangupCall({
          accountSid: requiredEnv("TWILIO_ACCOUNT_SID"),
          authToken: requiredEnv("TWILIO_AUTH_TOKEN"),
          callSid: twilioCallSid
        }).catch(() => undefined);
      }

      if (connectCcpSession) {
        await connectCcpSession.end().catch(() => undefined);
        if (connectCcpSession.videoPath && fs.existsSync(connectCcpSession.videoPath)) {
          await test.info().attach("connect-ccp-dial-video", {
            path: connectCcpSession.videoPath,
            contentType: "video/webm"
          });
        }
      }
      if (supervisorSession) {
        await supervisorSession.end().catch(() => undefined);
        if (supervisorSession.videoPath && fs.existsSync(supervisorSession.videoPath)) {
          await test.info().attach("salesforce-supervisor-video", {
            path: supervisorSession.videoPath,
            contentType: "video/webm"
          });
        }
        const observerSummaryPath = test.info().outputPath("supervisor-observation.json");
        const observerSummary: Record<string, unknown> = {
          queueName: supervisorSession.queueName,
          baselineWaitingCount: supervisorSession.baselineWaitingCount,
          baselineInProgressCount: supervisorSession.baselineInProgressCount,
          baselineInProgressSignature: supervisorSession.baselineInProgressSignature
        };
        const settled = await supervisorSession.observation
          .then((value) => ({ status: "fulfilled", value }))
          .catch((error) => ({
            status: "rejected",
            reason: error instanceof Error ? error.message : String(error)
          }));
        observerSummary.observation = settled;
        fs.writeFileSync(observerSummaryPath, JSON.stringify(observerSummary, null, 2), "utf8");
        await test.info().attach("supervisor-observation", {
          path: observerSummaryPath,
          contentType: "application/json"
        });
      }
      if (supervisorAgentSession) {
        await supervisorAgentSession.end().catch(() => undefined);
        if (supervisorAgentSession.videoPath && fs.existsSync(supervisorAgentSession.videoPath)) {
          await test.info().attach("salesforce-supervisor-agent-video", {
            path: supervisorAgentSession.videoPath,
            contentType: "video/webm"
          });
        }
        const observerSummaryPath = test.info().outputPath("supervisor-agent-observation.json");
        const observerSummary: Record<string, unknown> = {
          agentName: supervisorAgentSession.agentName,
          baselineSignature: supervisorAgentSession.baselineSignature
        };
        const settled = await supervisorAgentSession.observation
          .then((value) => ({ status: "fulfilled", value }))
          .catch((error) => ({
            status: "rejected",
            reason: error instanceof Error ? error.message : String(error)
          }));
        observerSummary.observation = settled;
        fs.writeFileSync(observerSummaryPath, JSON.stringify(observerSummary, null, 2), "utf8");
        await test.info().attach("supervisor-agent-observation", {
          path: observerSummaryPath,
          contentType: "application/json"
        });
      }
      await renderAssertionSummary(page, assertionLog, requiredAssertions, 2_000).catch(() => undefined);
      timeline.testEndMs = Date.now();
      const timelinePath = test.info().outputPath("e2e-timeline.json");
      fs.writeFileSync(timelinePath, JSON.stringify(timeline, null, 2), "utf8");
      await test
        .info()
        .attach("e2e-timeline", {
          path: timelinePath,
          contentType: "application/json"
        })
        .catch(() => undefined);
    }
  });
});

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function isTruthyEnv(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}

async function assertTelephonyProviderLoggedIn(page: Page): Promise<void> {
  const opened = await openConnectionStatusPanel(page);
  if (!opened) {
    throw new Error(
      "Connection Status control is not visible in utility bar or side panel. Cannot verify telephony provider sync state."
    );
  }

  const panelHoldMs = Number(process.env.PREFLIGHT_PANEL_HOLD_MS ?? 800);
  await holdForVideo(page, panelHoldMs);
  await page.waitForTimeout(1000);
  await clickProviderSyncIfPresent(page);
  await clickConnectionRunTestIfPresent(page);

  const waitMs = Number(process.env.PROVIDER_SYNC_WAIT_SEC ?? 20) * 1000;
  const deadline = Date.now() + waitMs;
  let lastState: ProviderState = "unknown";
  let lastSnapshot = "";
  while (Date.now() < deadline) {
    const snapshot = await collectProviderStatusSnapshot(page);
    lastSnapshot = snapshot;
    lastState = parseProviderState(snapshot);
    if (/missedcallagent/i.test(snapshot)) {
      await clickProviderSyncIfPresent(page);
      await clickConnectionRunTestIfPresent(page);
    }
    if (lastState === "routable") {
      await holdForVideo(page, panelHoldMs);
      await minimizeConnectionStatusDialogIfOpen(page);
      return;
    }
    if (lastState === "unknown") {
      const openedAgain = await openConnectionStatusPanel(page);
      if (openedAgain) {
        const refreshed = await collectProviderStatusSnapshot(page);
        lastState = parseProviderState(refreshed);
        if (lastState === "routable") {
          await holdForVideo(page, panelHoldMs);
          await minimizeConnectionStatusDialogIfOpen(page);
          return;
        }
      }
    }
    await page.waitForTimeout(1000);
  }

  await minimizeConnectionStatusDialogIfOpen(page);

  // Recovery: if provider is not logged in or unknown, try active recovery before giving up.
  if (lastState === "not_logged_in" || lastState === "unknown") {
    const recovered = await attemptProviderLoginRecovery(page, panelHoldMs);
    if (recovered) {
      await minimizeConnectionStatusDialogIfOpen(page);
      return;
    }
  }

  if (lastState === "not_logged_in") {
    throw new Error(
      "Telephony provider is not logged in. Open Salesforce Phone/Connection Status and sign in to Amazon Connect (CCP) before running inbound tests."
    );
  }

  const snapshotPreview = lastSnapshot.replace(/\s+/g, " ").trim().slice(0, 1200);
  throw new Error(
    `Telephony provider did not reach routable state within ${waitMs / 1000}s. LastState=${lastState}. Snapshot="${snapshotPreview}"`
  );
}

async function attemptProviderLoginRecovery(page: Page, panelHoldMs: number): Promise<boolean> {
  // Step 1: Try clicking any "Sign In" / "Log In" button in the Connection Status panel.
  const signInCandidates = [
    page.getByRole("button", { name: /sign in|log in|connect|sign into/i }).first(),
    page.getByRole("link", { name: /sign in|log in|sign into/i }).first(),
    page.locator("button,a").filter({ hasText: /sign in|log in/i }).first()
  ];
  for (const candidate of signInCandidates) {
    if ((await candidate.count()) > 0 && (await candidate.isVisible().catch(() => false))) {
      await candidate.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(3000);
      const snapshot = await collectProviderStatusSnapshot(page);
      if (parseProviderState(snapshot) === "routable") {
        return true;
      }
    }
  }

  // Step 2: Reload the page to trigger CTI adapter re-initialization.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);

  // Re-open the Connection Status panel and wait for provider to connect.
  const loginTimeoutMs = Math.max(
    30_000,
    Number(process.env.PROVIDER_LOGIN_TIMEOUT_SEC ?? 60) * 1000
  );
  const loginDeadline = Date.now() + loginTimeoutMs;
  await ensurePhoneUtilityOpen(page).catch(() => undefined);
  await openConnectionStatusPanel(page).catch(() => undefined);
  await clickProviderSyncIfPresent(page);
  await clickConnectionRunTestIfPresent(page);

  while (Date.now() < loginDeadline) {
    const snapshot = await collectProviderStatusSnapshot(page);
    const state = parseProviderState(snapshot);
    if (state === "routable") {
      await holdForVideo(page, panelHoldMs);
      return true;
    }
    // Re-click sign-in if it appeared after reload.
    for (const candidate of signInCandidates) {
      if ((await candidate.count()) > 0 && (await candidate.isVisible().catch(() => false))) {
        await candidate.click({ force: true }).catch(() => undefined);
        await page.waitForTimeout(2000);
        break;
      }
    }
    await page.waitForTimeout(2000);
  }
  return false;
}

async function holdForVideo(page: Page, ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  await page.waitForTimeout(ms);
}

async function assertAgentPreflightReady(
  page: Page,
  targetOmniStatus: string
): Promise<{ omniStatus: string; providerState: ProviderState }> {
  await ensurePhoneUtilityOpen(page);
  await ensureOmniStatus(page, targetOmniStatus);
  let omniStatus = "";
  try {
    omniStatus = await assertOmniStatus(page, targetOmniStatus);
  } catch {
    await forceOmniStatusSelection(page, targetOmniStatus);
    await ensureOmniStatus(page, targetOmniStatus);
    omniStatus = await assertOmniStatus(page, targetOmniStatus);
  }
  const providerState = await assertTelephonyProviderLoggedInAndReturnState(page);
  // Provider sync checks can leave the utility focus on Connection Status.
  // Force switch back to Omni and re-validate status before call execution.
  await openOmniWorkPanel(page);
  await ensureOmniStatus(page, targetOmniStatus);
  await ensureOmniPhoneTabOpen(page);
  omniStatus = await assertOmniStatus(page, targetOmniStatus);
  return { omniStatus, providerState };
}

async function assertTelephonyProviderLoggedInAndReturnState(page: Page): Promise<ProviderState> {
  await assertTelephonyProviderLoggedIn(page);
  return "routable";
}

type ProviderState = "routable" | "not_logged_in" | "unknown";

async function clickProviderSyncIfPresent(page: Page): Promise<void> {
  const syncButton = page.getByRole("button", { name: /^sync$/i }).first();
  if ((await syncButton.count()) === 0) {
    return;
  }
  const disabled = await syncButton.isDisabled().catch(() => true);
  if (disabled) {
    return;
  }
  await syncButton.click({ force: true });
  await page.waitForTimeout(1000);
}

async function clickConnectionRunTestIfPresent(page: Page): Promise<void> {
  const candidates = [
    page.getByRole("button", { name: /^run test$/i }).first(),
    page.getByRole("button", { name: /check connection requirements/i }).first(),
    page.getByRole("button", { name: /^check connection$/i }).first(),
    page.locator("button").filter({ hasText: /run test|check connection requirements|check connection/i }).first()
  ];
  for (const candidate of candidates) {
    if ((await candidate.count()) === 0) {
      continue;
    }
    if (!(await candidate.isVisible().catch(() => false))) {
      continue;
    }
    if (await candidate.isDisabled().catch(() => true)) {
      continue;
    }
    await candidate.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(1200);
    return;
  }
}

function parseProviderState(text: string): ProviderState {
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  if (/notloggedin|not logged in to your telephony provider/.test(normalized)) {
    return "not_logged_in";
  }
  if (/routable/.test(normalized)) {
    return "routable";
  }
  if (/connection status\s*\(\s*available\s*\)/.test(normalized)) {
    return "routable";
  }
  if (/provider status/.test(normalized) && /available/.test(normalized)) {
    return "routable";
  }
  if (/status is in sync with amazon connect/.test(normalized)) {
    return "routable";
  }
  if (/(provider|telephony|connection)\s*status.{0,25}\bavailable\b/.test(normalized)) {
    return "routable";
  }
  if (/\bavailable\b.{0,25}\broutable\b/.test(normalized)) {
    return "routable";
  }
  return "unknown";
}

async function collectUiReadiness(
  page: Page,
  expectedAppName: string
): Promise<{
  app: string;
  omniButton: boolean;
  phoneButton: boolean;
  connectionStatusButton: boolean;
  voiceTabCount: number;
  maxVoiceCallNumber: number;
}> {
  const body = await page.locator("body").innerText().catch(() => "");
  const appRegex = new RegExp(escapeRegex(expectedAppName), "i");
  const app = appRegex.test(body) ? expectedAppName : "Unknown";
  const omniButton = await detectOmniControlPresence(page);
  const phoneButton = (await page.getByRole("button", { name: /^phone$/i }).count()) > 0;
  const connectionStatusButton = await detectConnectionStatusControlPresence(page);
  const voiceTabCount = await countVoiceCallTabs(page);
  const maxVoiceCallNumber = await getMaxVoiceCallNumber(page);
  return {
    app,
    omniButton,
    phoneButton,
    connectionStatusButton,
    voiceTabCount,
    maxVoiceCallNumber
  };
}

async function waitForIncomingSignal(
  page: Page,
  args: {
    baselineVoiceTabs: number;
    baselineMaxVoiceCallNumber: number;
    baselineInboxCount: number;
    targetStatus: string;
    timeoutMs: number;
    autoAccept: boolean;
    allowDeltaSignals: boolean;
    shouldForceAccept?: () => boolean;
  }
): Promise<{ detected: boolean; acceptedByClick: boolean; signal: IncomingSignalType }> {
  const deadline = Date.now() + args.timeoutMs;
  const startedAtMs = Date.now();
  const criticalWindowMs = Math.max(10_000, Number(process.env.INCOMING_CRITICAL_WINDOW_SEC ?? 25) * 1000);
  const fastPollMs = Math.max(120, Number(process.env.INCOMING_FAST_POLL_MS ?? 250));
  const normalPollMs = Math.max(400, Number(process.env.INCOMING_NORMAL_POLL_MS ?? 1000));
  const omniStrongRefocusMs = Math.max(1000, Number(process.env.OMNI_STRONG_REFOCUS_MS ?? 3000));
  let lastStrongRefocusMs = 0;

  await ensureOmniPhoneTabOpen(page).catch(() => undefined);

  while (Date.now() < deadline) {
    // Keep Omni on phone view; avoid expensive toggles on every loop.
    const now = Date.now();
    if (now - lastStrongRefocusMs >= omniStrongRefocusMs) {
      await ensureOmniPhoneTabOpen(page).catch(() => undefined);
      lastStrongRefocusMs = now;
    } else {
      await exitOmniSettingsViewIfOpen(page).catch(() => undefined);
      await ensureOmniPhoneTabSelectedIfVisible(page).catch(() => undefined);
      await minimizeConnectionStatusDialogIfOpen(page).catch(() => undefined);
    }

    // In non-supervisor mode, accept quickly to avoid 20s SLA timeout.
    if (args.autoAccept && (await clickAcceptControl(page))) {
      return { detected: true, acceptedByClick: true, signal: "accept_clicked" };
    }

    if (args.shouldForceAccept?.()) {
      const forcedAccepted = await forceAcceptFromOmniInbox(page);
      if (forcedAccepted) {
        return { detected: true, acceptedByClick: true, signal: "accept_clicked" };
      }
    }

    const inCriticalWindow = Date.now() - startedAtMs <= criticalWindowMs;
    // Omni recovery can steal focus. Avoid it during the tight ringing window.
    if (!inCriticalWindow && (await isOmniOffline(page))) {
      await tryRecoverAgentReadiness(page, args.targetStatus);
    }

    if (await hasIncomingUiIndicator(page)) {
      return { detected: true, acceptedByClick: false, signal: "incoming_indicator" };
    }

    if (args.allowDeltaSignals) {
      const currentTabs = await countVoiceCallTabs(page);
      if (currentTabs > args.baselineVoiceTabs) {
        return { detected: true, acceptedByClick: false, signal: "voice_tab_delta" };
      }
      const currentMaxVoiceCallNumber = await getMaxVoiceCallNumber(page);
      if (currentMaxVoiceCallNumber > args.baselineMaxVoiceCallNumber) {
        return { detected: true, acceptedByClick: false, signal: "voice_number_delta" };
      }
      const currentInboxCount = await getInboxCount(page);
      if (currentInboxCount > args.baselineInboxCount) {
        return { detected: true, acceptedByClick: false, signal: "inbox_delta" };
      }
    }

    await page.waitForTimeout(inCriticalWindow ? fastPollMs : normalPollMs);
  }
  return { detected: false, acceptedByClick: false, signal: "timeout" };
}

async function waitForVoiceCallScreenPop(
  page: Page,
  args: {
    baselineVoiceTabs: number;
    baselineMaxVoiceCallNumber: number;
    targetStatus: string;
    timeoutMs: number;
  }
): Promise<boolean> {
  const deadline = Date.now() + args.timeoutMs;
  while (Date.now() < deadline) {
    if (await isOmniOffline(page)) {
      await tryRecoverAgentReadiness(page, args.targetStatus);
    }

    // Keep trying to accept if offer is still pending.
    await clickAcceptControl(page);

    const currentTabs = await countVoiceCallTabs(page);
    if (currentTabs > args.baselineVoiceTabs) {
      return true;
    }
    const currentMaxVoiceCallNumber = await getMaxVoiceCallNumber(page);
    if (currentMaxVoiceCallNumber > args.baselineMaxVoiceCallNumber) {
      return true;
    }

    if (await hasConnectedCallUiIndicator(page)) {
      if ((await countVoiceCallTabs(page)) > 0) {
        return true;
      }
      return true;
    }

    await page.waitForTimeout(1000);
  }
  return false;
}
async function tryRecoverAgentReadiness(page: Page, targetStatus: string): Promise<void> {
  try {
    await ensureOmniStatus(page, targetStatus);
    await assertTelephonyProviderLoggedIn(page);
    await ensurePhoneUtilityOpen(page);
  } catch {
    // Best-effort recovery during wait loop; continue polling for call signal.
  }
}
async function detectOmniControlPresence(page: Page): Promise<boolean> {
  const candidates = [
    page.getByRole("button", { name: /change your omni-channel status|omni-channel|omni/i }).first(),
    leftRailButton(page, /omni|change your omni-channel status/i),
    page.locator("[title*='Omni' i], [aria-label*='Omni' i]").first(),
    page.locator("div[role='button'],button,a").filter({ hasText: /omni-channel|omni/i }).first()
  ];
  for (const candidate of candidates) {
    if ((await candidate.count()) > 0 && (await candidate.isVisible().catch(() => false))) {
      return true;
    }
  }
  return false;
}

async function detectConnectionStatusControlPresence(page: Page): Promise<boolean> {
  const panel = await findConnectionStatusPanel(page);
  if (panel) {
    return true;
  }
  const control = await findConnectionStatusControl(page);
  return Boolean(control);
}

async function openConnectionStatusPanel(page: Page): Promise<boolean> {
  if (await findConnectionStatusPanel(page)) {
    return true;
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt > 0) {
      await ensurePhoneUtilityOpen(page).catch(() => undefined);
      await page.waitForTimeout(250);
    }

    const control = await findConnectionStatusControl(page);
    if (!control) {
      continue;
    }
    await control.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(350);

    if (await findConnectionStatusPanel(page)) {
      return true;
    }

    const postClickState = parseProviderState(await collectProviderStatusSnapshot(page));
    if (postClickState !== "unknown") {
      return true;
    }
  }
  return false;
}

function connectionStatusControlCandidates(page: Page): Locator[] {
  return [
    page.getByRole("button", { name: /connection status/i }).first(),
    page.getByRole("tab", { name: /connection status/i }).first(),
    page.locator("[title*='Connection Status' i], [aria-label*='Connection Status' i]").first(),
    page
      .locator("a,button,div[role='button'],div[role='tab'],span")
      .filter({ hasText: /^\s*connection status(?:\s*\(.*\))?\s*$/i })
      .first(),
    page.locator("footer a, footer button, footer div[role='button'], footer div[role='tab']").filter({
      hasText: /connection status/i
    }).first()
  ];
}

async function findConnectionStatusControl(page: Page): Promise<Locator | null> {
  return findFirstVisibleLocator(connectionStatusControlCandidates(page));
}

async function findConnectionStatusPanel(page: Page): Promise<Locator | null> {
  const candidates = [
    page.getByRole("dialog", { name: /connection status/i }).first(),
    page.locator("section,article,div").filter({ hasText: /provider status/i }).first(),
    page.locator("section,article,div").filter({ hasText: /current status in your telephony/i }).first(),
    page.locator("section,article,div").filter({ hasText: /connection status/i }).first()
  ];
  return findFirstVisibleLocator(candidates);
}

async function collectProviderStatusSnapshot(page: Page): Promise<string> {
  const chunks: string[] = [];

  const panel = await findConnectionStatusPanel(page);
  if (panel) {
    const panelText = ((await panel.innerText().catch(() => "")) ?? "").trim();
    if (panelText) {
      chunks.push(panelText);
    }
  }

  const control = await findConnectionStatusControl(page);
  if (control) {
    const controlText = ((await control.innerText().catch(() => "")) ?? "").trim();
    if (controlText) {
      chunks.push(controlText);
    }
  }

  const utilityBar = page
    .locator(
      "footer, [class*='utilityBar' i], [class*='utilitybar' i], [role='contentinfo'][aria-label*='Utility Bar' i], [aria-label='Utility Bar']"
    )
    .first();
  if ((await utilityBar.count()) > 0 && (await utilityBar.isVisible().catch(() => false))) {
    const utilityText = ((await utilityBar.innerText().catch(() => "")) ?? "").trim();
    if (utilityText) {
      chunks.push(utilityText);
    }
  }

  if (chunks.length > 0) {
    return chunks.join("\n");
  }
  return await page.locator("body").innerText().catch(() => "");
}

async function findFirstVisibleLocator(candidates: Locator[]): Promise<Locator | null> {
  for (const candidate of candidates) {
    if ((await candidate.count()) === 0) {
      continue;
    }
    if (await candidate.isVisible().catch(() => false)) {
      return candidate;
    }
  }
  return null;
}

async function assertAndMark<T>(
  page: Page,
  assertionLog: VisualAssertionEntry[],
  label: string,
  run: () => Promise<T>
): Promise<T> {
  try {
    const result = await run();
    const details = formatAssertionDetails(result);
    await pushVisualAssertion(page, assertionLog, { label, passed: true, details });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pushVisualAssertion(page, assertionLog, { label, passed: false, details: message });
    throw error;
  }
}

async function settleOptionalObserverAssertion<T>(
  page: Page,
  assertionLog: VisualAssertionEntry[],
  args: {
    label: string;
    observation: Promise<T>;
    waitMs: number;
    onSuccess: (value: T) => string;
  }
): Promise<void> {
  const existing = assertionLog.find((entry) => entry.label === args.label);
  if (existing) {
    return;
  }

  const settled = args.observation
    .then((value) => ({ kind: "resolved", value }) as const)
    .catch((error) => ({ kind: "rejected", error }) as const);
  const raced = await Promise.race<
    | { kind: "resolved"; value: T }
    | { kind: "rejected"; error: unknown }
    | { kind: "timeout" }
  >([settled, page.waitForTimeout(args.waitMs).then(() => ({ kind: "timeout" } as const))]);

  if (raced.kind === "resolved") {
    await pushVisualAssertion(page, assertionLog, {
      label: args.label,
      passed: true,
      details: args.onSuccess(raced.value)
    });
    return;
  }

  if (raced.kind === "rejected") {
    await pushVisualAssertion(page, assertionLog, {
      label: args.label,
      passed: false,
      details: raced.error instanceof Error ? raced.error.message : String(raced.error)
    });
    return;
  }

  await pushVisualAssertion(page, assertionLog, {
    label: args.label,
    passed: false,
    details: `Still pending after ${Math.round(args.waitMs / 1000)}s while finalizing run.`
  });
}

async function waitForObservationWithin<T>(promise: Promise<T>, waitMs: number): Promise<T | null> {
  if (waitMs <= 0) {
    return null;
  }
  try {
    const settled = await Promise.race<{ kind: "resolved"; value: T } | { kind: "timeout" }>([
      promise.then((value) => ({ kind: "resolved", value }) as const),
      new Promise<{ kind: "timeout" }>((resolve) => {
        setTimeout(() => resolve({ kind: "timeout" }), waitMs);
      })
    ]);
    return settled.kind === "resolved" ? settled.value : null;
  } catch {
    return null;
  }
}

async function observeQueueBacklogTotalWaitingDuringRinging(
  page: Page,
  args: { queueName: string; baselineWaitingCount: number; timeoutMs: number }
): Promise<SupervisorQueueObservation | null> {
  const deadline = Date.now() + Math.max(0, args.timeoutMs);
  const pollMs = Math.max(120, Number(process.env.SUPERVISOR_PRE_ACCEPT_POLL_MS ?? 250));
  const requireTotalWaitingHeader = !/^(false|0|no|off)$/i.test(
    (process.env.SUPERVISOR_REQUIRE_TOTAL_WAITING_HEADER ?? "true").trim()
  );
  while (Date.now() < deadline) {
    await ensureSupervisorQueuesBacklogSurfaceOpen(page, args.queueName).catch(() => undefined);
    const snapshot = await readSupervisorQueueSnapshot(page, args.queueName);
    const sourceAllowed =
      snapshot.source.startsWith("table:") &&
      (!requireTotalWaitingHeader || /total\s*waiting/i.test(snapshot.source));
    if (sourceAllowed && snapshot.waitingCount > Math.max(0, args.baselineWaitingCount)) {
      return {
        queueName: snapshot.queueName || args.queueName,
        metric: "queue_waiting",
        observedCount: snapshot.waitingCount,
        waitingCount: snapshot.waitingCount,
        source: snapshot.source,
        observedAtMs: Date.now()
      };
    }
    await page.waitForTimeout(pollMs);
  }
  return null;
}



type E2eTimeline = {
  testStartMs: number;
  callTriggerMode: string;
  preflightReadyMs?: number;
  supervisorObserverStartedMs?: number;
  supervisorAgentObserverStartedMs?: number;
  supervisorQueueObservedMs?: number;
  supervisorAgentOfferObservedMs?: number;
  callTriggerStartMs?: number;
  ccpDialConfirmedMs?: number;
  incomingDetectedMs?: number;
  acceptClickedMs?: number;
  screenPopDetectedMs?: number;
  testEndMs?: number;
};


