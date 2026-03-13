/**
 * conversationEngine.mjs — NL Caller conversation orchestration
 *
 * Two modes:
 *  1. Gemini Live (primary) — single WebSocket handles STT+LLM+TTS
 *  2. Scripted (fallback) — keyword detection + pre-defined responses via local STT/TTS
 *
 * State machine:
 *   idle → waiting_for_greeting → listening → processing → speaking → listening → ...
 */

import WebSocket from "ws";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  twilioToGeminiBase64,
  geminiBase64ToTwilio,
  twilioToGeminiInput,
  ttsOutputToTwilio,
  mulawToPcm,
  geminiOutputToTwilio,
  resamplePcm,
} from "./audioCodec.mjs";

/**
 * Write a PCM 16-bit mono 8kHz buffer as a WAV file.
 */
function writePcmWav(filePath, pcmBuffer, sampleRate = 8000) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;
  const headerSize = 44;

  const header = Buffer.alloc(headerSize);
  header.write("RIFF", 0);
  header.writeUInt32LE(dataSize + headerSize - 8, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20);  // PCM format
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  writeFileSync(filePath, Buffer.concat([header, pcmBuffer]));
}

/**
 * Create a conversation engine instance.
 *
 * @param {object} opts
 * @param {string} opts.mode — "gemini" | "scripted" | "local"
 * @param {object} opts.persona — { name, accountNumber, context, objective }
 * @param {object} [opts.gemini] — { apiKey, model }
 * @param {object} [opts.scripted] — { conversation: [{ waitFor, detectKeywords, say, maxWaitSec }] }
 * @param {number} [opts.maxTurns=15] — max conversation turns
 * @param {number} [opts.turnTimeoutSec=30] — max seconds to wait per turn
 * @param {string} [opts.tone] — caller emotional tone (frustrated, angry, confused, polite, elderly, rushed)
 * @param {string} [opts.voice] — Gemini prebuilt voice name (Aoede, Charon, Fenrir, Kore, Puck)
 * @param {string} [opts.accent] — accent instruction (british, indian, australian, southern_us, new_york)
 * @param {object} [opts.logger] — logger instance
 * @returns {object} engine instance
 */
export function createConversationEngine(opts) {
  const {
    mode = "gemini",
    persona = {},
    gemini = {},
    scripted = {},
    maxTurns = 15,
    turnTimeoutSec = 30,
    tone = "",
    voice = "Aoede",
    accent = "",
    logger = console,
  } = opts;

  // ── State ─────────────────────────────────────────────────────────

  let state = "idle";
  let turnCount = 0;
  let twilioSender = null;
  let geminiWs = null;
  let transcript = [];
  let currentAgentUtterance = "";
  let callStartedAt = null;
  let callEndedAt = null;
  let resolveCallComplete = null;
  let callCompletePromise = new Promise((r) => { resolveCallComplete = r; });

  // Scripted mode state
  let scriptStep = 0;
  let silenceTimer = null;
  let audioBuffer = Buffer.alloc(0);

  // Gemini setup gate — audio arriving before setupComplete is buffered here so
  // Gemini hears the full call stream from the very beginning, not mid-sentence.
  let geminiReady = false;
  let pendingAudioChunks = []; // base64 PCM chunks waiting for setupComplete

  // Gemini transcription accumulators — buffer word fragments until turnComplete
  let inputTranscriptBuffer = "";
  let outputTranscriptBuffer = "";

  // Turn silence detection — nudge Gemini if no turnComplete fires within turnTimeoutSec
  let lastTurnCompleteMs = 0;
  let turnNudgeTimer = null;

  function scheduleTurnNudge() {
    if (turnNudgeTimer) clearTimeout(turnNudgeTimer);
    const timeoutMs = turnTimeoutSec * 1000;
    turnNudgeTimer = setTimeout(() => {
      if (state !== "listening") return;
      if (!geminiWs || geminiWs.readyState !== 1 /* WebSocket.OPEN */) return;
      logger.log(`[engine] No turn in ${turnTimeoutSec}s — nudging Gemini to respond`);
      // Inject a text turn so Gemini generates a response — it may not have detected
      // a clear turn boundary from the inbound audio stream.
      geminiWs.send(JSON.stringify({
        clientContent: {
          turns: [{
            role: "user",
            parts: [{ text: "[There has been silence. If you have not yet spoken on this call, say hello and briefly explain why you are calling — stay in character. If you have already introduced yourself, say something brief like 'Hello? Are you there?' to prompt the agent.]" }],
          }],
          turnComplete: true,
        },
      }));
      // Reschedule in case the nudge doesn't produce a response either
      scheduleTurnNudge();
    }, timeoutMs);
  }

  // Local audio recording buffers (PCM 8kHz for both sides)
  const recordingBuffers = { inbound: [], outbound: [] };

  // ── Public API ────────────────────────────────────────────────────

  function getState() { return state; }
  function getTranscript() { return transcript; }
  function getTurnCount() { return turnCount; }
  function waitForComplete() { return callCompletePromise; }
  function getRecordingBuffers() { return recordingBuffers; }

  function registerTwilioSender(sender) {
    twilioSender = sender;
  }

  async function onCallStarted({ streamSid, callSid }) {
    callStartedAt = Date.now();
    lastTurnCompleteMs = Date.now();
    // Start in listening — Gemini hears everything from the beginning of the call.
    // The system prompt instructs it to stay silent during automated announcements
    // and respond once a live agent or AI greets it directly. Gemini's LLM intelligence
    // handles the IVR vs. conversation distinction from the audio itself.
    state = "listening";
    logger.log(`[engine] Call started (mode=${mode}) — Gemini connected, listening from call start`);

    if (mode === "gemini") {
      await connectGeminiLive();
      scheduleTurnNudge();
    }
  }

  // Audio flow counters for debugging
  let audioInCount = 0;
  let audioOutCount = 0;
  let lastAudioLogMs = 0;

  async function onAudioIn(base64Mulaw) {
    if (state === "idle" || state === "ended" || state === "escalation_hold") return;

    audioInCount++;
    // Log audio flow every 15 seconds
    const now = Date.now();
    if (now - lastAudioLogMs > 15000) {
      logger.log(`[engine] Audio flow: IN=${audioInCount} packets, OUT=${audioOutCount} packets, state=${state}`);
      lastAudioLogMs = now;
    }

    // Record inbound audio (Agentforce side)
    const mulawBuf = Buffer.from(base64Mulaw, "base64");
    const pcm8k = mulawToPcm(mulawBuf);
    recordingBuffers.inbound.push(pcm8k);

    if (mode === "gemini") {
      // Convert mulaw 8kHz → PCM 16kHz base64 for Gemini
      const pcmBase64 = twilioToGeminiBase64(base64Mulaw);
      if (!geminiReady) {
        // Buffer audio that arrives before Gemini setup is complete.
        // This prevents the first seconds of the call from being silently dropped
        // during the WebSocket connection + setup handshake.
        pendingAudioChunks.push(pcmBase64);
      } else if (geminiWs?.readyState === WebSocket.OPEN) {
        // Gemini is ready — forward directly.
        // System prompt instructs it to stay silent during IVR announcements
        // and respond only when greeted directly by an agent.
        geminiWs.send(JSON.stringify({
          realtimeInput: {
            mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: pcmBase64 }],
          },
        }));
      }
    } else if (mode === "scripted" || mode === "local") {
      // Buffer audio for local STT processing
      const pcm = twilioToGeminiInput(base64Mulaw);
      audioBuffer = Buffer.concat([audioBuffer, pcm]);

      // Reset silence timer — process after 1.5s of silence
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => processBufferedAudio(), 1500);
    }
  }

  function onMarkPlayed(name) {
    logger.log(`[engine] Mark played: ${name}`);
  }

  async function onCallEnded({ reason }) {
    // During escalation_hold, ignore external close events (twilio-stop, ws-close).
    // The 60s hold timer will call onCallEnded({reason:"escalation"}) when ready.
    if (state === "escalation_hold" && reason !== "escalation") {
      logger.log(`[engine] Ignoring onCallEnded(${reason}) during escalation_hold — waiting for hold timer`);
      return;
    }
    if (state === "ended") return;
    callEndedAt = Date.now();
    state = "ended";
    geminiReady = false;
    pendingAudioChunks = [];
    if (turnNudgeTimer) { clearTimeout(turnNudgeTimer); turnNudgeTimer = null; }
    logger.log(`[engine] Call ended (reason=${reason})`);

    // Close Gemini connection
    if (geminiWs) {
      geminiWs.close();
      geminiWs = null;
    }

    // Write local WAV recordings
    const recordings = {};
    try {
      const outputDir = opts.artifactDir || "test-results/nl-caller";
      mkdirSync(outputDir, { recursive: true });

      if (recordingBuffers.inbound.length > 0) {
        const inboundPcm = Buffer.concat(recordingBuffers.inbound);
        const inboundPath = `${outputDir}/recording-agentforce.wav`;
        writePcmWav(inboundPath, inboundPcm);
        recordings.agentforce = inboundPath;
        logger.log(`[engine] Agentforce audio saved: ${inboundPath} (${(inboundPcm.length / 2 / 8000).toFixed(1)}s)`);
      }

      if (recordingBuffers.outbound.length > 0) {
        const outboundPcm = Buffer.concat(recordingBuffers.outbound);
        const outboundPath = `${outputDir}/recording-caller.wav`;
        writePcmWav(outboundPath, outboundPcm);
        recordings.caller = outboundPath;
        logger.log(`[engine] Caller audio saved: ${outboundPath} (${(outboundPcm.length / 2 / 8000).toFixed(1)}s)`);
      }
    } catch (err) {
      logger.error(`[engine] Error saving recordings: ${err.message}`);
    }

    resolveCallComplete({
      transcript,
      turnCount,
      durationSec: Math.round((callEndedAt - callStartedAt) / 1000),
      recordings,
      reason,
    });
  }

  // ── Gemini Live API connection ────────────────────────────────────

  async function connectGeminiLive() {
    const apiKey = gemini.apiKey;
    if (!apiKey) {
      logger.error("[engine] No Gemini API key provided");
      state = "ended";
      return;
    }

    const model = gemini.model || "gemini-2.5-flash-native-audio-latest";
    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;

    logger.log(`[engine] Connecting to Gemini Live API (model=${model})...`);

    geminiWs = new WebSocket(wsUrl);

    geminiWs.on("open", () => {
      logger.log("[engine] Gemini Live WebSocket connected");

      // Send session setup message
      const setupMsg = {
        setup: {
          model: `models/${model}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: voice || "Aoede",
                },
              },
            },
          },
          // VAD tuning: wait for a longer silence window before treating inbound audio
          // as a complete agent turn. Agentforce typically delivers multi-sentence messages
          // (disclaimer + greeting in one block) with brief pauses between sentences (~400-700ms).
          // A 400ms window + HIGH sensitivity incorrectly cuts the turn after the disclaimer,
          // causing Gemini to respond before the greeting is heard. 1200ms + LOW sensitivity
          // lets the full message arrive before Gemini decides to speak.
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
              endOfSpeechSensitivity: gemini.vadSensitivity === "high" ? "END_SENSITIVITY_HIGH" : "END_SENSITIVITY_LOW",
              silenceDurationMs: gemini.vadSilenceDurationMs ?? 1200,
            },
          },
          // Transcribe what Agentforce says (input audio) — required for escalation detection
          inputAudioTranscription: {},
          // Transcribe what Gemini says (output audio) — gives clean speech, not reasoning text
          outputAudioTranscription: {},
          systemInstruction: {
            parts: [{
              text: buildSystemPrompt(),
            }],
          },
        },
      };
      logger.log(`[engine] Sending setup: model=${setupMsg.setup.model} voice=${setupMsg.setup.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName}`);
      geminiWs.send(JSON.stringify(setupMsg));
    });

    geminiWs.on("message", (data) => {
      try {
        const raw = data.toString();
        const msg = JSON.parse(raw);
        // Log error messages from Gemini
        if (msg.error) {
          logger.error(`[engine] Gemini API error: code=${msg.error.code} message="${msg.error.message}" status="${msg.error.status}"`);
          return;
        }
        handleGeminiMessage(msg);
      } catch (err) {
        logger.error("[engine] Error parsing Gemini message:", err.message);
        logger.error("[engine] Raw message:", data.toString().slice(0, 500));
      }
    });

    geminiWs.on("close", (code, reason) => {
      const reasonStr = reason ? reason.toString() : "no reason";
      logger.log(`[engine] Gemini Live WebSocket closed — code=${code} reason="${reasonStr}"`);
    });

    geminiWs.on("error", (err) => {
      logger.error("[engine] Gemini Live WebSocket error:", err.message);
      if (err.stack) logger.error("[engine] Stack:", err.stack);
    });
  }

  function handleGeminiMessage(msg) {
    // Setup complete — Gemini is now ready to receive audio
    if (msg.setupComplete) {
      geminiReady = true;
      const buffered = pendingAudioChunks.length;
      // Discard pre-setup buffered audio — sending it causes Gemini code=1007
      // "Request contains an invalid argument". Gemini starts fresh and receives
      // live call audio from this point via onAudioIn.
      pendingAudioChunks = [];
      logger.log(`[engine] Gemini session setup complete — discarded ${buffered} pre-setup chunks, listening live`);
      return;
    }

    // Server content (audio response or text)
    if (msg.serverContent) {
      const parts = msg.serverContent.modelTurn?.parts || [];

      for (const part of parts) {
        // Audio response — forward to Twilio
        if (part.inlineData?.mimeType?.startsWith("audio/")) {
          const base64Pcm = part.inlineData.data;
          const twilioAudio = geminiBase64ToTwilio(base64Pcm);
          audioOutCount++;

          // Record outbound audio (caller/Gemini side) — convert PCM 24kHz → PCM 8kHz
          const pcm24k = Buffer.from(base64Pcm, "base64");
          const pcm8k = resamplePcm(pcm24k, 24000, 8000);
          recordingBuffers.outbound.push(pcm8k);

          if (twilioSender?.sendAudio) {
            twilioSender.sendAudio(twilioAudio);
          }
        }
        // part.text is Gemini reasoning/thinking — skip entirely when outputAudioTranscription
        // is enabled. We use outputTranscription for clean caller speech instead.
      }

      // Accumulate output transcription fragments (Gemini speaks word-by-word)
      const outputTranscription = msg.serverContent.outputTranscription;
      if (outputTranscription?.text) {
        outputTranscriptBuffer += outputTranscription.text;
      }

      // Accumulate input transcription fragments (Agentforce speaks word-by-word)
      const inputTranscript = msg.serverContent.inputTranscription?.text || msg.serverContent.inputTranscript;
      if (inputTranscript) {
        inputTranscriptBuffer += inputTranscript;
      }

      // Flush buffers on turn complete — write full utterances to transcript
      if (msg.serverContent.turnComplete) {
        lastTurnCompleteMs = Date.now();
        scheduleTurnNudge(); // reset silence timer on each turn
        const callerText = outputTranscriptBuffer.trim();
        const agentText = inputTranscriptBuffer.trim();
        outputTranscriptBuffer = "";
        inputTranscriptBuffer = "";

        if (callerText) {
          logger.log(`[engine] Caller says: "${callerText}"`);
          transcript.push({
            speaker: "caller",
            text: callerText,
            timestamp: Date.now(),
            turn: turnCount,
          });
          turnCount++;
        }

        if (agentText) {
          logger.log(`[engine] Agentforce says: "${agentText}"`);
          transcript.push({
            speaker: "agentforce",
            text: agentText,
            timestamp: Date.now(),
            turn: turnCount,
          });
        }

        logger.log(`[engine] Turn ${turnCount} complete`);

        // Detect escalation phrases in transcript — annotation only.
        // Actual escalation is triggered externally via notifyEscalation() when
        // the Salesforce OmniChannel incoming signal fires. This avoids false
        // positives from IVR announcements and hold messages.
        const escalationPhrases = [
          "transfer", "transferring", "connect you with", "connect you to",
          "specialist", "human agent", "live agent", "representative",
          "hold while i", "please hold", "one moment"
        ];
        const lastAgentforceTurn = [...transcript].reverse().find(t => t.speaker === "agentforce");
        if (lastAgentforceTurn) {
          const lowerText = lastAgentforceTurn.text.toLowerCase();
          const isEscalating = escalationPhrases.some(phrase => lowerText.includes(phrase));
          if (isEscalating) {
            logger.log(`[engine] Escalation phrase detected in transcript (informational): "${lastAgentforceTurn.text}" — waiting for SF OmniChannel event via notifyEscalation()`);
          }
        }

        // Check max turns
        if (turnCount >= maxTurns) {
          logger.log("[engine] Max turns reached — ending conversation");
          onCallEnded({ reason: "max-turns" });
        }
      }
    }
  }

  // ── Scripted mode ─────────────────────────────────────────────────

  async function processBufferedAudio() {
    if (mode !== "scripted" && mode !== "local") return;
    if (audioBuffer.length === 0) return;

    const currentBuf = audioBuffer;
    audioBuffer = Buffer.alloc(0);

    // For scripted mode, use local Whisper STT
    let text = "";
    try {
      const { transcribeBuffer } = await import("./sttLocal.mjs");
      text = await transcribeBuffer(currentBuf, { sampleRate: 16000 });
    } catch (err) {
      logger.error("[engine] Local STT error:", err.message);
      return;
    }

    if (!text.trim()) return;

    logger.log(`[engine] Agentforce says (STT): "${text}"`);
    transcript.push({
      speaker: "agentforce",
      text: text.trim(),
      timestamp: Date.now(),
      turn: turnCount,
    });

    if (mode === "scripted") {
      await handleScriptedResponse(text);
    } else if (mode === "local") {
      await handleLocalLlmResponse(text);
    }
  }

  async function handleScriptedResponse(agentText) {
    const steps = scripted.conversation || [];
    if (scriptStep >= steps.length) {
      logger.log("[engine] Scripted conversation complete");
      onCallEnded({ reason: "script-complete" });
      return;
    }

    const step = steps[scriptStep];

    // Check keyword match
    const keywords = step.detectKeywords || [];
    const lowerText = agentText.toLowerCase();
    const matched = keywords.length === 0 || keywords.some((kw) => lowerText.includes(kw.toLowerCase()));

    if (!matched) {
      logger.log(`[engine] No keyword match for step ${scriptStep}, waiting...`);
      return;
    }

    logger.log(`[engine] Script step ${scriptStep}: saying "${step.say}"`);
    transcript.push({
      speaker: "caller",
      text: step.say,
      timestamp: Date.now(),
      turn: turnCount,
    });
    turnCount++;

    // Convert text to speech and send to Twilio
    await speakText(step.say);
    scriptStep++;
  }

  async function handleLocalLlmResponse(agentText) {
    // Use local LLM (Ollama) to generate response
    try {
      const { generateResponse } = await import("./llmLocal.mjs");
      const response = await generateResponse({
        systemPrompt: buildSystemPrompt(),
        transcript,
        latestMessage: agentText,
      });

      logger.log(`[engine] Caller says (LLM): "${response}"`);
      transcript.push({
        speaker: "caller",
        text: response,
        timestamp: Date.now(),
        turn: turnCount,
      });
      turnCount++;

      await speakText(response);
    } catch (err) {
      logger.error("[engine] Local LLM error:", err.message);
    }
  }

  async function speakText(text) {
    try {
      const { synthesize } = await import("./ttsLocal.mjs");
      const { audio, sampleRate } = await synthesize(text);
      const twilioAudio = ttsOutputToTwilio(audio, sampleRate);

      if (twilioSender?.sendAudio) {
        // Send in chunks to avoid large single frames
        const chunkSize = 640; // ~40ms at 8kHz mulaw
        const mulawBuf = Buffer.from(twilioAudio, "base64");
        for (let i = 0; i < mulawBuf.length; i += chunkSize) {
          const chunk = mulawBuf.subarray(i, i + chunkSize);
          twilioSender.sendAudio(chunk.toString("base64"));
        }
        twilioSender.sendMark(`speak-${turnCount}`);
      }
    } catch (err) {
      logger.error("[engine] TTS error:", err.message);
    }
  }

  // ── Tone + accent prompt maps ────────────────────────────────────

  const TONE_PROMPTS = {
    frustrated: "You are frustrated and impatient. Express dissatisfaction but remain civil.",
    angry: "You are angry about the situation. Raise concerns firmly, interrupt if needed.",
    confused: "You are confused and unsure. Ask clarifying questions, repeat information.",
    polite: "You are very polite and patient. Thank the agent frequently.",
    elderly: "You speak slowly and deliberately. Ask the agent to repeat things.",
    rushed: "You are in a hurry. Give short answers, ask for fast resolution.",
  };

  const ACCENT_PROMPTS = {
    british: "Speak with a British English accent and use British expressions.",
    indian: "Speak with an Indian English accent.",
    australian: "Speak with an Australian English accent.",
    southern_us: "Speak with a Southern American accent.",
    new_york: "Speak with a New York accent.",
  };

  // ── System prompt builder ─────────────────────────────────────────

  function buildSystemPrompt() {
    let prompt = `You are simulating a customer calling a contact center.

Persona: ${persona.name || "Customer"}${persona.accountNumber ? `, account ${persona.accountNumber}` : ""}
Context: ${persona.context || "General inquiry"}
Objective: ${persona.objective || "Get help with an issue"}

You are on a live phone call. Use your judgment — the same way a real person would — to decide when to speak and when to stay silent.

WHEN TO STAY SILENT:
- The other party is delivering information that does not expect a response from you (legal notices, hold messages, system announcements, music, being transferred).
- The other party is still speaking.

WHEN TO SPEAK:
- The other party has finished speaking and is clearly expecting you to respond. Judge this by the intent and tone of what was said — did it open the floor to you? Did it ask you something? Did it greet you in a way that expects a reply?
- This applies regardless of what else was said before it. A message can start with a disclaimer and end with a greeting — respond to the greeting.
- Any request for information (your name, account, reason for calling, verification) — answer it.

IF THERE IS SILENCE:
- Do not speak just because it is quiet. First consider: is the agent processing? Am I on hold? Or is the agent genuinely waiting for me?
- If the agent has already spoken to you and silence follows with no clear reason, it is appropriate to re-engage briefly.

CONVERSATION FLOW:
- When you first get to speak: introduce yourself and explain your issue. Do not jump straight to demanding escalation — have a natural conversation first.
- Only ask to speak with a human after giving the agent a fair chance to help (at least 2-3 exchanges).
- If being transferred: acknowledge and wait.
- If issue is resolved: thank them and say goodbye.

Be natural. Keep responses short (1-3 spoken sentences). Do not reveal you are an AI.`;

    if (tone && TONE_PROMPTS[tone]) {
      prompt += `\n\nEmotional tone: ${TONE_PROMPTS[tone]}`;
    }
    if (accent && ACCENT_PROMPTS[accent]) {
      prompt += `\n\nAccent: ${ACCENT_PROMPTS[accent]}`;
    }
    return prompt;
  }

  /**
   * Called externally when the Agentforce AI agent has answered the call
   * (detected via SF Agentforce supervisor tab: totalActive >= 1).
   * Transitions from waiting_for_ai → listening, enabling audio forwarding to Gemini.
   */
  function startConversation() {
    // Informational signal from the Agentforce supervisor tab (totalActive >= 1).
    // Audio forwarding is always on from call start — Gemini handles IVR vs. conversation
    // distinction using its system prompt. This call is kept for supervisor metrics logging.
    if (state === "ended" || state === "escalation_hold") return;
    logger.log("[engine] Agentforce AI confirmed live (supervisor tab: totalActive >= 1)");
  }

  /**
   * Called externally when the Salesforce OmniChannel incoming signal fires,
   * indicating Agentforce has transferred the call to a human agent queue.
   * Enters escalation_hold directly — no transcript keyword detection needed.
   */
  function notifyEscalation() {
    if (state === "ended" || state === "escalation_hold") {
      logger.log(`[engine] notifyEscalation() called but state=${state} — ignoring`);
      return;
    }
    logger.log("[engine] SF OmniChannel incoming signal received — Agentforce escalated to human agent");
    if (geminiWs) {
      geminiWs.close();
      geminiWs = null;
    }
    state = "escalation_hold";
    if (turnNudgeTimer) { clearTimeout(turnNudgeTimer); turnNudgeTimer = null; }

    // Save recordings immediately — the conversation is over at this point.
    // Don't wait for the 60s hold timer: the buffers are populated now and
    // the process may exit before the hold expires.
    try {
      const outputDir = opts.artifactDir || "test-results/nl-caller";
      mkdirSync(outputDir, { recursive: true });
      if (recordingBuffers.inbound.length > 0) {
        const inboundPcm = Buffer.concat(recordingBuffers.inbound);
        const inboundPath = `${outputDir}/recording-agentforce.wav`;
        writePcmWav(inboundPath, inboundPcm);
        logger.log(`[engine] Agentforce audio saved (escalation): ${inboundPath} (${(inboundPcm.length / 2 / 8000).toFixed(1)}s)`);
      }
      if (recordingBuffers.outbound.length > 0) {
        const outboundPcm = Buffer.concat(recordingBuffers.outbound);
        const outboundPath = `${outputDir}/recording-caller.wav`;
        writePcmWav(outboundPath, outboundPcm);
        logger.log(`[engine] Caller audio saved (escalation): ${outboundPath} (${(outboundPcm.length / 2 / 8000).toFixed(1)}s)`);
      }
    } catch (err) {
      logger.error(`[engine] Error saving escalation recordings: ${err.message}`);
    }

    const holdSec = opts.escalationHoldSec ?? 60;
    logger.log(`[engine] Holding call open for ${holdSec}s while transfer completes...`);
    setTimeout(() => onCallEnded({ reason: "escalation" }), holdSec * 1000);
  }

  // ── Return engine interface ───────────────────────────────────────

  return {
    getState,
    getTranscript,
    getTurnCount,
    waitForComplete,
    getRecordingBuffers,
    registerTwilioSender,
    onCallStarted,
    onAudioIn,
    onMarkPlayed,
    onCallEnded,
    startConversation,
    notifyEscalation,
  };
}
