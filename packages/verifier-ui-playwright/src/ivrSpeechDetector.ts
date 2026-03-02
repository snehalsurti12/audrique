/**
 * IVR Speech Detector — Browser Audio Interception + Silence Detection
 *
 * Intercepts the remote audio track from the CCP WebRTC connection to detect
 * when IVR prompts start and stop speaking.  This allows DTMF digits to be
 * sent precisely when the IVR is waiting for input, rather than relying on
 * hardcoded timing delays.
 *
 * Architecture:
 *   1. `page.addInitScript()` injects a script that patches RTCPeerConnection
 *      to capture the remote audio track (IVR audio).
 *   2. An AnalyserNode monitors audio energy in real-time (50 ms poll).
 *   3. A MediaRecorder saves the audio for post-hoc Whisper transcription.
 *   4. `window.__ivrAudio` exposes state to Playwright for polling.
 */

import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

// ── Public interfaces ──────────────────────────────────────────────────────

export interface IvrStep {
  /** DTMF digit(s) to send after this prompt finishes. */
  dtmf: string;
  /** Optional keyword expected in the IVR prompt (verified post-hoc). */
  expect?: string;
  /** Human-readable label for the audit trail. */
  label?: string;
}

export interface IvrStepResult {
  dtmf: string;
  label?: string;
  speechDetectedMs: number;
  silenceDetectedMs: number;
  promptDurationMs: number;
  dtmfSentMs: number;
  expect?: string;
  /** Whether the expect keyword was matched (transcription or post-hoc). */
  expectMatch?: boolean;
  /** Transcript of the prompt that triggered this DTMF (if transcription active). */
  transcript?: string;
  /** Number of informational prompts skipped before this input prompt. */
  promptsSkipped?: number;
  /** Whisper transcription latency in ms. */
  transcriptionLatencyMs?: number;
}

export interface IvrNavigationResult {
  mode: "speech";
  steps: IvrStepResult[];
  totalDurationMs: number;
  audioRecordingPath?: string;
}

export interface IvrSpeechDetectorOpts {
  /** dB threshold below which audio is considered silence. Default -45. */
  silenceThresholdDb?: number;
  /** Minimum silence duration (ms) to consider a prompt finished. Default 800. */
  silenceMinMs?: number;
  /** Minimum speech duration (ms) to confirm a prompt started. Default 300. */
  speechMinMs?: number;
  /** Max seconds to wait for each IVR prompt. Default 30. */
  maxPromptWaitSec?: number;
  /** Inter-digit delay after sending DTMF (ms). Default 200. */
  postDtmfDelayMs?: number;
}

// ── Browser-side injection script ──────────────────────────────────────────

/**
 * This script runs inside the CCP browser page (injected via addInitScript).
 * It patches RTCPeerConnection to capture the remote audio track, then sets
 * up an AnalyserNode + MediaRecorder.  State is exposed on window.__ivrAudio.
 */
function getIvrAudioInjectionScript(silenceThresholdDb: number): string {
  return `
(function () {
  if (window.__ivrAudio) return;

  const SILENCE_THRESHOLD_DB = ${silenceThresholdDb};
  const POLL_INTERVAL_MS = 50;
  const NOISE_FLOOR_CALIBRATION_MS = 500;

  // State exposed to Playwright via page.evaluate()
  window.__ivrAudio = {
    rmsLevel: 0,
    rmsDb: -100,
    isSpeaking: false,
    silenceDurationMs: 0,
    speechDurationMs: 0,
    promptCount: 0,
    isRecording: false,
    ready: false,
    error: null,
    // Internal state (not polled directly)
    _noiseFloorDb: -100,
    _calibrated: false,
    _calibrationSamples: [],
    _lastSpeechTransitionMs: 0,
    _lastSilenceTransitionMs: 0,
    _recordedChunks: [],
    _mediaRecorder: null,
    _startTimeMs: Date.now(),
  };

  const state = window.__ivrAudio;

  function calcRms(dataArray) {
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const sample = (dataArray[i] - 128) / 128;
      sum += sample * sample;
    }
    return Math.sqrt(sum / dataArray.length);
  }

  function rmsToDb(rms) {
    if (rms <= 0) return -100;
    return 20 * Math.log10(rms);
  }

  function startMonitoring(remoteStream) {
    try {
      const audioCtx = new AudioContext();
      // Resume AudioContext — in headless Chromium it starts suspended
      console.log('[IVR-Audio] AudioContext state:', audioCtx.state, 'sampleRate:', audioCtx.sampleRate);
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().then(() => {
          console.log('[IVR-Audio] AudioContext resumed. State:', audioCtx.state);
        }).catch((err) => {
          console.warn('[IVR-Audio] AudioContext resume failed:', err);
        });
      }
      console.log('[IVR-Audio] Remote stream tracks:', remoteStream.getAudioTracks().map(t => t.label + ' enabled=' + t.enabled + ' muted=' + t.muted).join(', '));
      const source = audioCtx.createMediaStreamSource(remoteStream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.3;
      source.connect(analyser);
      // Don't connect to destination — we don't want to play the audio twice

      const dataArray = new Uint8Array(analyser.fftSize);
      const calibrationStart = Date.now();

      // Start MediaRecorder for post-hoc transcription
      try {
        const recorder = new MediaRecorder(remoteStream, {
          mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
            ? "audio/webm;codecs=opus"
            : "audio/webm",
        });
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            state._recordedChunks.push(e.data);
          }
        };
        recorder.start(1000); // Collect in 1s chunks
        state._mediaRecorder = recorder;
        state.isRecording = true;
      } catch (recErr) {
        console.warn("[IVR-Audio] MediaRecorder failed:", recErr);
      }

      state.ready = true;
      state._startTimeMs = Date.now();

      // Polling loop — runs every POLL_INTERVAL_MS
      const poll = () => {
        analyser.getByteTimeDomainData(dataArray);
        const rms = calcRms(dataArray);
        const db = rmsToDb(rms);

        state.rmsLevel = rms;
        state.rmsDb = db;

        const now = Date.now();

        // Calibrate noise floor from initial samples
        if (!state._calibrated) {
          state._calibrationSamples.push(db);
          if (now - calibrationStart >= NOISE_FLOOR_CALIBRATION_MS) {
            const sorted = state._calibrationSamples.slice().sort((a, b) => a - b);
            // Use median of bottom 50% as noise floor
            const lower = sorted.slice(0, Math.max(1, Math.floor(sorted.length / 2)));
            state._noiseFloorDb = lower.reduce((a, b) => a + b, 0) / lower.length;
            state._calibrated = true;
          }
        }

        // Determine speech/silence using adaptive threshold
        const threshold = state._calibrated
          ? Math.max(SILENCE_THRESHOLD_DB, state._noiseFloorDb + 10)
          : SILENCE_THRESHOLD_DB;

        const wasSpeaking = state.isSpeaking;
        const nowSpeaking = db > threshold;

        if (nowSpeaking && !wasSpeaking) {
          // Silence → Speech transition
          state.isSpeaking = true;
          state._lastSpeechTransitionMs = now;
          state.silenceDurationMs = 0;
        } else if (!nowSpeaking && wasSpeaking) {
          // Speech → Silence transition
          state.isSpeaking = false;
          state._lastSilenceTransitionMs = now;
          state.speechDurationMs = now - state._lastSpeechTransitionMs;
          state.promptCount++;
        }

        if (state.isSpeaking) {
          state.speechDurationMs = now - state._lastSpeechTransitionMs;
          state.silenceDurationMs = 0;
        } else if (state._lastSilenceTransitionMs > 0) {
          state.silenceDurationMs = now - state._lastSilenceTransitionMs;
        } else {
          // Haven't heard any speech yet
          state.silenceDurationMs = now - state._startTimeMs;
        }

        setTimeout(poll, POLL_INTERVAL_MS);
      };
      poll();
    } catch (err) {
      state.error = String(err);
      console.error("[IVR-Audio] Monitoring setup failed:", err);
    }
  }

  // Patch RTCPeerConnection to intercept remote audio tracks
  const OrigRTC = window.RTCPeerConnection;
  if (!OrigRTC) {
    state.error = "RTCPeerConnection not available in this browser";
    return;
  }

  const origAddEventListener = OrigRTC.prototype.addEventListener;
  let intercepted = false;

  function tryIntercept(track) {
    if (intercepted || !track || track.kind !== "audio") return;
    intercepted = true;
    console.log("[IVR-Audio] Intercepted remote audio track:", track.label, "readyState:", track.readyState);
    const remoteStream = new MediaStream([track]);
    startMonitoring(remoteStream);
  }

  // Strategy 1: Patch addEventListener("track", ...)
  OrigRTC.prototype.addEventListener = function (type, listener, options) {
    if (type === "track" && !intercepted) {
      const wrappedListener = function (event) {
        tryIntercept(event.track);
        if (typeof listener === "function") {
          listener.call(this, event);
        } else if (listener && typeof listener.handleEvent === "function") {
          listener.handleEvent(event);
        }
      };
      return origAddEventListener.call(this, type, wrappedListener, options);
    }
    return origAddEventListener.call(this, type, listener, options);
  };

  // Strategy 2: Patch ontrack setter
  const origOnTrackDescriptor = Object.getOwnPropertyDescriptor(OrigRTC.prototype, "ontrack");
  if (origOnTrackDescriptor && origOnTrackDescriptor.set) {
    const origSet = origOnTrackDescriptor.set;
    Object.defineProperty(OrigRTC.prototype, "ontrack", {
      set: function (handler) {
        const wrappedHandler = function (event) {
          tryIntercept(event.track);
          if (typeof handler === "function") {
            handler.call(this, event);
          }
        };
        origSet.call(this, wrappedHandler);
      },
      get: origOnTrackDescriptor.get,
      configurable: true,
    });
  }

  // Strategy 3: Patch constructor + poll getReceivers() as fallback.
  // CCP may use addTransceiver/getReceivers instead of track events.
  const peerConnections = [];
  window.RTCPeerConnection = function () {
    const pc = new OrigRTC(...arguments);
    peerConnections.push(pc);
    console.log("[IVR-Audio] RTCPeerConnection created. Total:", peerConnections.length);
    return pc;
  };
  window.RTCPeerConnection.prototype = OrigRTC.prototype;
  // Preserve static methods and properties
  Object.keys(OrigRTC).forEach(function (key) {
    try { window.RTCPeerConnection[key] = OrigRTC[key]; } catch (e) {}
  });

  // Poll all peer connections for remote audio receivers
  const receiverPollInterval = setInterval(function () {
    if (intercepted) {
      clearInterval(receiverPollInterval);
      return;
    }
    for (let i = 0; i < peerConnections.length; i++) {
      var pc = peerConnections[i];
      try {
        if (pc.connectionState === "closed") continue;
        var receivers = pc.getReceivers();
        for (var j = 0; j < receivers.length; j++) {
          var track = receivers[j].track;
          if (track && track.kind === "audio" && track.readyState === "live") {
            console.log("[IVR-Audio] Found audio track via getReceivers() on PC", i);
            tryIntercept(track);
            return;
          }
        }
      } catch (e) {}
    }
  }, 200);

  // Stop polling after 30s to avoid leaking
  setTimeout(function () { clearInterval(receiverPollInterval); }, 30000);
})();
`;
}

// ── Playwright-side functions ──────────────────────────────────────────────

/**
 * Inject the IVR audio interceptor into the CCP page.
 * Must be called BEFORE `page.goto()` so the script runs before CCP initializes WebRTC.
 */
export async function injectIvrAudioInterceptor(
  page: Page,
  opts?: { silenceThresholdDb?: number }
): Promise<void> {
  const thresholdDb = opts?.silenceThresholdDb ?? -45;
  await page.addInitScript({ content: getIvrAudioInjectionScript(thresholdDb) });
}

/**
 * Poll the browser for current IVR audio state.
 */
async function getAudioState(page: Page): Promise<{
  ready: boolean;
  isSpeaking: boolean;
  silenceDurationMs: number;
  speechDurationMs: number;
  promptCount: number;
  rmsDb: number;
  error: string | null;
}> {
  return page.evaluate(() => {
    const s = (window as any).__ivrAudio;
    if (!s) {
      return {
        ready: false,
        isSpeaking: false,
        silenceDurationMs: 0,
        speechDurationMs: 0,
        promptCount: 0,
        rmsDb: -100,
        error: "IVR audio interceptor not injected",
      };
    }
    return {
      ready: s.ready,
      isSpeaking: s.isSpeaking,
      silenceDurationMs: s.silenceDurationMs,
      speechDurationMs: s.speechDurationMs,
      promptCount: s.promptCount,
      rmsDb: s.rmsDb,
      error: s.error,
    };
  });
}

/**
 * Wait for the audio interceptor to become ready (remote audio track captured).
 */
export async function waitForAudioReady(page: Page, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await getAudioState(page);
    if (state.ready) {
      console.log(`[IVR-Speech] Audio interceptor ready. Initial rmsDb=${state.rmsDb.toFixed(1)}`);
      return true;
    }
    if (state.error) {
      console.warn(`[IVR-Speech] Audio interceptor error: ${state.error}`);
      return false;
    }
    await page.waitForTimeout(200);
  }
  console.warn("[IVR-Speech] Audio interceptor did not become ready within timeout.");
  return false;
}

/**
 * Wait for an IVR prompt to finish: detect speech starting, then silence after speech.
 *
 * Returns when silence has lasted >= silenceMinMs after speech of >= speechMinMs.
 * If maxWaitSec is exceeded, returns with timedOut=true.
 */
export async function waitForPromptEnd(
  page: Page,
  opts?: {
    silenceMinMs?: number;
    speechMinMs?: number;
    maxWaitSec?: number;
    /** Previous promptCount — used to detect prompts that completed before we started listening. */
    previousPromptCount?: number;
  }
): Promise<{ durationMs: number; timedOut: boolean; speechDurationMs: number; promptCount: number }> {
  const silenceMinMs = opts?.silenceMinMs ?? 800;
  const speechMinMs = opts?.speechMinMs ?? 300;
  const maxWaitMs = (opts?.maxWaitSec ?? 30) * 1000;
  const previousPromptCount = opts?.previousPromptCount ?? -1;
  const start = Date.now();

  let heardSpeech = false;
  let logCounter = 0;

  // Check if a prompt already completed before we started listening
  const initial = await getAudioState(page);
  if (
    initial.ready &&
    !initial.isSpeaking &&
    previousPromptCount >= 0 &&
    initial.promptCount > previousPromptCount &&
    initial.silenceDurationMs >= silenceMinMs
  ) {
    console.log(
      `[IVR-Speech] Prompt already completed (promptCount=${initial.promptCount} > prev=${previousPromptCount}, ` +
      `silenceMs=${initial.silenceDurationMs}). Returning immediately.`
    );
    return {
      durationMs: 0,
      timedOut: false,
      speechDurationMs: initial.speechDurationMs,
      promptCount: initial.promptCount,
    };
  }

  while (Date.now() - start < maxWaitMs) {
    const state = await getAudioState(page);

    if (!state.ready) {
      await page.waitForTimeout(100);
      continue;
    }

    // Log audio levels periodically (every ~2s) for debugging
    logCounter++;
    if (logCounter % 20 === 1) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(
        `[IVR-Speech] t=${elapsed}s rmsDb=${state.rmsDb.toFixed(1)} speaking=${state.isSpeaking} ` +
        `speechMs=${state.speechDurationMs} silenceMs=${state.silenceDurationMs} prompts=${state.promptCount}`
      );
    }

    // Phase 1: Wait for speech to start
    if (!heardSpeech) {
      if (state.isSpeaking && state.speechDurationMs >= speechMinMs) {
        heardSpeech = true;
        console.log(`[IVR-Speech] Speech detected at ${((Date.now() - start) / 1000).toFixed(1)}s (rmsDb=${state.rmsDb.toFixed(1)})`);
      }
      // Also check if a new prompt completed while we were waiting for Phase 1
      if (
        !state.isSpeaking &&
        previousPromptCount >= 0 &&
        state.promptCount > previousPromptCount &&
        state.silenceDurationMs >= silenceMinMs
      ) {
        console.log(
          `[IVR-Speech] New prompt completed during wait (promptCount=${state.promptCount} > prev=${previousPromptCount}).`
        );
        return {
          durationMs: Date.now() - start,
          timedOut: false,
          speechDurationMs: state.speechDurationMs,
          promptCount: state.promptCount,
        };
      }
      await page.waitForTimeout(100);
      continue;
    }

    // Phase 2: Speech was heard, wait for silence
    if (!state.isSpeaking && state.silenceDurationMs >= silenceMinMs) {
      return {
        durationMs: Date.now() - start,
        timedOut: false,
        speechDurationMs: state.speechDurationMs,
        promptCount: state.promptCount,
      };
    }

    await page.waitForTimeout(100);
  }

  const finalState = await getAudioState(page);
  return {
    durationMs: Date.now() - start,
    timedOut: true,
    speechDurationMs: 0,
    promptCount: finalState.promptCount,
  };
}

/**
 * Navigate a multi-level IVR using speech-silence detection.
 *
 * For each step:
 *   1. Wait for IVR prompt to play (speech detected)
 *   2. Wait for prompt to finish (silence detected)
 *   3. Send DTMF digit(s)
 *   4. Brief pause, then repeat for next level
 *
 * @param sendDtmf — callback to send DTMF via CCP keypad (provided by caller)
 */
export async function navigateIvrWithSpeechDetection(
  page: Page,
  steps: IvrStep[],
  sendDtmf: (page: Page, digits: string) => Promise<void>,
  opts?: IvrSpeechDetectorOpts
): Promise<IvrNavigationResult> {
  const silenceMinMs = opts?.silenceMinMs ?? 800;
  const speechMinMs = opts?.speechMinMs ?? 300;
  const maxPromptWaitSec = opts?.maxPromptWaitSec ?? 30;
  const postDtmfDelayMs = opts?.postDtmfDelayMs ?? 200;

  const startMs = Date.now();
  const stepResults: IvrStepResult[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepStartMs = Date.now();

    // Wait for prompt to finish
    const promptResult = await waitForPromptEnd(page, {
      silenceMinMs,
      speechMinMs,
      maxWaitSec: maxPromptWaitSec,
    });

    const silenceDetectedMs = Date.now() - startMs;
    const speechDetectedMs = silenceDetectedMs - promptResult.durationMs;

    if (promptResult.timedOut) {
      console.warn(
        `[IVR-Speech] Step ${i + 1}/${steps.length}: Timed out waiting for prompt end ` +
          `(${maxPromptWaitSec}s). Sending DTMF "${step.dtmf}" anyway as fallback.`
      );
    }

    // Send DTMF
    await sendDtmf(page, step.dtmf);
    const dtmfSentMs = Date.now() - startMs;

    stepResults.push({
      dtmf: step.dtmf,
      label: step.label,
      expect: step.expect,
      speechDetectedMs: Math.max(0, speechDetectedMs),
      silenceDetectedMs,
      promptDurationMs: promptResult.speechDurationMs,
      dtmfSentMs,
    });

    console.log(
      `[IVR-Speech] Step ${i + 1}/${steps.length}: ` +
        `prompt=${promptResult.speechDurationMs}ms, ` +
        `DTMF="${step.dtmf}" sent at ${dtmfSentMs}ms` +
        (promptResult.timedOut ? " (TIMEOUT FALLBACK)" : "") +
        (step.label ? ` [${step.label}]` : "")
    );

    // Post-DTMF delay before next level
    if (i < steps.length - 1) {
      await page.waitForTimeout(postDtmfDelayMs);
    }
  }

  return {
    mode: "speech",
    steps: stepResults,
    totalDurationMs: Date.now() - startMs,
  };
}

/**
 * Extract accumulated audio from the browser WITHOUT stopping the MediaRecorder.
 *
 * Reads `_recordedChunks` from a marker index to the end, converts to a single
 * Blob, and returns as a Buffer. Updates the marker so the next extraction only
 * gets new chunks.
 */
export async function extractAccumulatedAudio(page: Page): Promise<Buffer | null> {
  const base64Audio = await page.evaluate(async () => {
    const s = (window as any).__ivrAudio;
    if (!s || !s._recordedChunks || s._recordedChunks.length === 0) return null;

    // Check if there are new chunks since last extraction
    const prevIndex = s._lastExtractIndex ?? 0;
    if (prevIndex >= s._recordedChunks.length) return null;

    // Always extract ALL chunks from index 0 to preserve the EBML/WebM header
    // that FFmpeg requires for parsing. Track the index only to detect new data.
    s._lastExtractIndex = s._recordedChunks.length;

    const blob = new Blob(s._recordedChunks, { type: "audio/webm;codecs=opus" });
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  });

  if (!base64Audio) return null;
  return Buffer.from(base64Audio, "base64");
}

/**
 * Navigate a multi-level IVR using transcription-driven keyword matching.
 *
 * For each step:
 *   1. Wait for IVR prompt to end (speech→silence detection)
 *   2. Extract accumulated audio from browser
 *   3. Transcribe with whisper.cpp
 *   4. If step has `expect` keyword: check transcript
 *      - MATCH → send DTMF, advance
 *      - NO MATCH → informational prompt, loop back and wait for next prompt
 *   5. If step has NO `expect`: send DTMF after first prompt (backward compatible)
 *
 * @param transcribe — whisper.cpp transcription callback
 * @param matchKeyword — keyword matching callback
 */
export async function navigateIvrWithTranscription(
  page: Page,
  steps: IvrStep[],
  sendDtmf: (page: Page, digits: string) => Promise<void>,
  transcribe: (buffer: Buffer) => { text: string; durationMs: number },
  matchKeyword: (transcript: string, pattern: string) => { matched: boolean; keyword?: string },
  opts?: IvrSpeechDetectorOpts & { maxPromptRetries?: number }
): Promise<IvrNavigationResult> {
  const silenceMinMs = opts?.silenceMinMs ?? 800;
  const speechMinMs = opts?.speechMinMs ?? 300;
  const maxPromptWaitSec = opts?.maxPromptWaitSec ?? 30;
  const postDtmfDelayMs = opts?.postDtmfDelayMs ?? 200;
  const maxRetries = opts?.maxPromptRetries ?? 5;

  const startMs = Date.now();
  const stepResults: IvrStepResult[] = [];

  // Get initial promptCount for detecting already-completed prompts.
  // Subtract 1 so that if a prompt already completed before we started,
  // waitForPromptEnd immediately recognizes it (promptCount > previousPromptCount).
  const initialState = await getAudioState(page);
  let lastPromptCount = Math.max(-1, initialState.promptCount - 1);
  if (initialState.promptCount > 0) {
    console.log(
      `[IVR-Transcribe] ${initialState.promptCount} prompt(s) already completed before transcription started ` +
      `(silenceMs=${initialState.silenceDurationMs}). Will detect the latest prompt.`
    );
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const hasExpect = !!(step.expect?.trim());
    let promptsSkipped = 0;
    let matched = false;
    let transcript = "";
    let transcriptionLatencyMs = 0;

    for (let retry = 0; retry <= maxRetries; retry++) {
      // Wait for the next prompt to finish
      const promptResult = await waitForPromptEnd(page, {
        silenceMinMs,
        speechMinMs,
        maxWaitSec: maxPromptWaitSec,
        previousPromptCount: lastPromptCount,
      });

      lastPromptCount = promptResult.promptCount;

      if (promptResult.timedOut) {
        console.warn(
          `[IVR-Transcribe] Step ${i + 1}/${steps.length}: Timed out waiting for prompt end ` +
          `(${maxPromptWaitSec}s). Sending DTMF "${step.dtmf}" as fallback.`
        );
        break; // Send DTMF as fallback
      }

      // If no expect keyword, send DTMF after first prompt
      if (!hasExpect) {
        console.log(
          `[IVR-Transcribe] Step ${i + 1}/${steps.length}: No expect keyword, sending DTMF "${step.dtmf}" after prompt.`
        );
        break;
      }

      // Extract audio and transcribe
      const audioBuffer = await extractAccumulatedAudio(page);
      if (!audioBuffer || audioBuffer.length === 0) {
        console.warn(
          `[IVR-Transcribe] Step ${i + 1}/${steps.length}: No audio captured for transcription. Sending DTMF as fallback.`
        );
        break;
      }

      try {
        const result = transcribe(audioBuffer);
        transcript = result.text;
        transcriptionLatencyMs = result.durationMs;

        console.log(
          `[IVR-Transcribe] Step ${i + 1}/${steps.length}: Transcript (${result.durationMs}ms): "${transcript}"`
        );

        // Check keyword match
        const match = matchKeyword(transcript, step.expect!);
        if (match.matched) {
          matched = true;
          console.log(
            `[IVR-Transcribe] Step ${i + 1}/${steps.length}: Keyword MATCHED "${match.keyword}" — sending DTMF "${step.dtmf}".`
          );
          break;
        }

        // No match — this was an informational prompt, wait for the next one
        promptsSkipped++;
        console.log(
          `[IVR-Transcribe] Step ${i + 1}/${steps.length}: Keyword NOT matched (expect="${step.expect}"). ` +
          `Skipping informational prompt ${promptsSkipped}/${maxRetries}.`
        );
      } catch (err) {
        console.warn(
          `[IVR-Transcribe] Step ${i + 1}/${steps.length}: Transcription error: ${err}. Sending DTMF as fallback.`
        );
        break;
      }
    }

    // Send DTMF
    await sendDtmf(page, step.dtmf);
    const dtmfSentMs = Date.now() - startMs;

    stepResults.push({
      dtmf: step.dtmf,
      label: step.label,
      expect: step.expect,
      expectMatch: hasExpect ? matched : undefined,
      transcript: transcript || undefined,
      promptsSkipped: promptsSkipped > 0 ? promptsSkipped : undefined,
      transcriptionLatencyMs: transcriptionLatencyMs > 0 ? transcriptionLatencyMs : undefined,
      speechDetectedMs: 0,
      silenceDetectedMs: 0,
      promptDurationMs: 0,
      dtmfSentMs,
    });

    console.log(
      `[IVR-Transcribe] Step ${i + 1}/${steps.length}: DTMF="${step.dtmf}" sent at ${dtmfSentMs}ms` +
      (step.label ? ` [${step.label}]` : "") +
      (hasExpect ? ` (match=${matched}, skipped=${promptsSkipped})` : "")
    );

    // Post-DTMF delay before next level
    if (i < steps.length - 1) {
      await page.waitForTimeout(postDtmfDelayMs);
    }
  }

  return {
    mode: "speech",
    steps: stepResults,
    totalDurationMs: Date.now() - startMs,
  };
}

/**
 * Retrieve the recorded IVR audio from the browser as a Buffer.
 * Returns null if no audio was recorded.
 */
export async function getIvrRecording(page: Page): Promise<Buffer | null> {
  const hasRecording = await page.evaluate(() => {
    const s = (window as any).__ivrAudio;
    return s && s._recordedChunks && s._recordedChunks.length > 0;
  });

  if (!hasRecording) return null;

  // Stop MediaRecorder and collect final chunks
  await page.evaluate(() => {
    const s = (window as any).__ivrAudio;
    if (s && s._mediaRecorder && s._mediaRecorder.state !== "inactive") {
      s._mediaRecorder.stop();
    }
  });

  // Brief wait for final ondataavailable
  await page.waitForTimeout(500);

  // Convert Blob chunks to base64 in the browser, then transfer to Node
  const base64Audio = await page.evaluate(async () => {
    const s = (window as any).__ivrAudio;
    if (!s || !s._recordedChunks || s._recordedChunks.length === 0) return null;

    const blob = new Blob(s._recordedChunks, { type: "audio/webm;codecs=opus" });
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  });

  if (!base64Audio) return null;
  return Buffer.from(base64Audio, "base64");
}

/**
 * Save IVR recording to disk and return the file path.
 */
export async function saveIvrRecording(
  page: Page,
  outputDir: string
): Promise<string | undefined> {
  const buffer = await getIvrRecording(page);
  if (!buffer || buffer.length === 0) return undefined;

  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, "ivr-audio.webm");
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

/**
 * Save IVR navigation result as JSON artifact.
 */
export function saveIvrNavigationResult(
  result: IvrNavigationResult,
  outputDir: string
): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, "ivr-navigation.json");
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2));
  return filePath;
}
