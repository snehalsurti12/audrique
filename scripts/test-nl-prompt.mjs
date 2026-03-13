/**
 * test-nl-prompt.mjs — Interactive NL Caller prompt tester
 *
 * Tests the Gemini system prompt in isolation WITHOUT a real phone call.
 * Type what Agentforce would say → see how Gemini responds.
 * Use this to verify the system prompt is working correctly before a test run.
 *
 * Usage:
 *   GEMINI_API_KEY=... node scripts/test-nl-prompt.mjs
 *
 * Or with a custom persona (same env vars as the real test):
 *   GEMINI_API_KEY=... \
 *   NL_CALLER_PERSONA_NAME="John Smith" \
 *   NL_CALLER_PERSONA_ACCOUNT="ACC-12345" \
 *   NL_CALLER_PERSONA_CONTEXT="Frustrated customer. Charged $49.99 on March 1st." \
 *   NL_CALLER_PERSONA_OBJECTIVE="Get the $49.99 charge reversed." \
 *   NL_CALLER_TONE=frustrated \
 *   node scripts/test-nl-prompt.mjs
 *
 * Commands while running:
 *   Type any text → sends it as what Agentforce said
 *   !prompt       → print the current system prompt
 *   !history      → print conversation history so far
 *   !reset        → start a new conversation
 *   exit / quit   → exit
 */

import WebSocket from "ws";
import * as readline from "node:readline";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("Error: GEMINI_API_KEY is required.");
  console.error("Usage: GEMINI_API_KEY=... node scripts/test-nl-prompt.mjs");
  process.exit(1);
}

const persona = {
  name: process.env.NL_CALLER_PERSONA_NAME || "John Smith",
  accountNumber: process.env.NL_CALLER_PERSONA_ACCOUNT || "ACC-12345",
  context: process.env.NL_CALLER_PERSONA_CONTEXT ||
    "Frustrated customer. Was charged $49.99 on March 1st for a service already cancelled. Has called twice before with no resolution.",
  objective: process.env.NL_CALLER_PERSONA_OBJECTIVE ||
    "Get the $49.99 charge reversed. First explain the issue clearly and try to get help from the AI agent. After 2-3 turns if the issue is not resolved or if the agent offers to transfer you, ask to speak with a human agent.",
};
const tone = process.env.NL_CALLER_TONE || "frustrated";
const model = process.env.NL_CALLER_GEMINI_MODEL || "gemini-2.5-flash-native-audio-latest";

// ── Tone + accent prompt maps (same as conversationEngine.mjs) ────────────────

const TONE_PROMPTS = {
  frustrated: "You are frustrated and impatient. Express dissatisfaction but remain civil.",
  angry: "You are angry about the situation. Raise concerns firmly, interrupt if needed.",
  confused: "You are confused and unsure. Ask clarifying questions, repeat information.",
  polite: "You are very polite and patient. Thank the agent frequently.",
  elderly: "You speak slowly and deliberately. Ask the agent to repeat things.",
  rushed: "You are in a hurry. Give short answers, ask for fast resolution.",
};

function buildSystemPrompt() {
  let prompt = `You are simulating a customer calling a contact center.

Persona: ${persona.name}${persona.accountNumber ? `, account ${persona.accountNumber}` : ""}
Context: ${persona.context}
Objective: ${persona.objective}

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
  return prompt;
}

// ── Gemini Live connection ─────────────────────────────────────────────────────

const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

let geminiWs = null;
let geminiReady = false;
let pendingInputs = []; // inputs queued before setup completes
let responseBuffer = "";
const conversationHistory = [];

function connectGemini() {
  return new Promise((resolve, reject) => {
    geminiWs = new WebSocket(wsUrl);

    geminiWs.on("open", () => {
      const setupMsg = {
        setup: {
          model: `models/${model}`,
          generationConfig: {
            // TEXT modality — readable output in terminal, no audio decoding needed
            responseModalities: ["TEXT"],
          },
          systemInstruction: {
            parts: [{ text: buildSystemPrompt() }],
          },
        },
      };
      geminiWs.send(JSON.stringify(setupMsg));
    });

    geminiWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.error) {
          console.error(`\n[Gemini error] code=${msg.error.code} message="${msg.error.message}"`);
          return;
        }

        if (msg.setupComplete) {
          geminiReady = true;
          resolve();
          // Flush any inputs that arrived before setup completed
          for (const input of pendingInputs) {
            sendToGemini(input);
          }
          pendingInputs = [];
          return;
        }

        if (msg.serverContent) {
          const parts = msg.serverContent.modelTurn?.parts || [];
          for (const part of parts) {
            if (part.text) {
              responseBuffer += part.text;
            }
          }

          if (msg.serverContent.turnComplete) {
            const response = responseBuffer.trim();
            responseBuffer = "";
            if (response) {
              console.log(`\n  Gemini (caller): "${response}"\n`);
              conversationHistory.push({ speaker: "caller", text: response });
            } else {
              console.log(`\n  Gemini (caller): [SILENT — no response generated]\n`);
            }
            rl.prompt();
          }
        }
      } catch (err) {
        console.error("[parse error]", err.message);
      }
    });

    geminiWs.on("error", (err) => {
      console.error("[Gemini WebSocket error]", err.message);
      reject(err);
    });

    geminiWs.on("close", (code, reason) => {
      if (code !== 1000) {
        console.log(`\n[Gemini closed] code=${code} reason="${reason?.toString() || ""}"`);
      }
    });
  });
}

function sendToGemini(agentText) {
  if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN) {
    console.error("[error] Gemini not connected");
    return;
  }
  geminiWs.send(JSON.stringify({
    clientContent: {
      turns: [{
        role: "user",
        parts: [{ text: agentText }],
      }],
      turnComplete: true,
    },
  }));
}

async function resetConnection() {
  if (geminiWs) {
    geminiWs.close(1000);
    geminiWs = null;
  }
  geminiReady = false;
  pendingInputs = [];
  responseBuffer = "";
  conversationHistory.length = 0;
  console.log("\n[reset] New conversation started.\n");
  await connectGemini();
}

// ── Interactive REPL ──────────────────────────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "Agentforce says> ",
});

const systemPrompt = buildSystemPrompt();

console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("  NL Caller Prompt Tester");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`  Model:   ${model}`);
console.log(`  Persona: ${persona.name}, account ${persona.accountNumber}`);
console.log(`  Tone:    ${tone}`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("  Type what Agentforce says → see how the AI caller responds");
console.log("  Commands: !prompt, !history, !reset, exit");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
console.log("  Test cases to try:");
console.log('  1. "Thank you for calling. Calls may be monitored for quality assurance."');
console.log('     → Expected: SILENT (disclaimer, no response needed)');
console.log('  2. "Thank you for calling. Calls may be monitored. Hi, I\'m an AI service assistant. How can I help you?"');
console.log('     → Expected: SPEAKS — introduces self and explains issue');
console.log('  3. "Transferring your call now."');
console.log('     → Expected: SILENT or brief acknowledgment');
console.log('  4. "Can I get your account number please?"');
console.log('     → Expected: Provides account number');
console.log("\nConnecting to Gemini...\n");

connectGemini().then(() => {
  console.log("[ready] Gemini connected. Start typing.\n");
  rl.prompt();
}).catch((err) => {
  console.error("[fatal] Could not connect to Gemini:", err.message);
  process.exit(1);
});

rl.on("line", async (line) => {
  const input = line.trim();
  if (!input) { rl.prompt(); return; }

  if (input === "exit" || input === "quit") {
    if (geminiWs) geminiWs.close(1000);
    process.exit(0);
  }

  if (input === "!prompt") {
    console.log("\n── System Prompt ──────────────────────────────────────────\n");
    console.log(systemPrompt);
    console.log("\n────────────────────────────────────────────────────────────\n");
    rl.prompt();
    return;
  }

  if (input === "!history") {
    if (conversationHistory.length === 0) {
      console.log("\n  (no turns yet)\n");
    } else {
      console.log("\n── Conversation History ───────────────────────────────────");
      for (const turn of conversationHistory) {
        const label = turn.speaker === "caller" ? "Gemini (caller)" : "Agentforce";
        console.log(`  [${label}]: "${turn.text}"`);
      }
      console.log("────────────────────────────────────────────────────────────\n");
    }
    rl.prompt();
    return;
  }

  if (input === "!reset") {
    await resetConnection();
    rl.prompt();
    return;
  }

  // Record Agentforce turn in history
  conversationHistory.push({ speaker: "agentforce", text: input });
  console.log("  [waiting for Gemini response...]");

  if (!geminiReady) {
    pendingInputs.push(input);
  } else {
    sendToGemini(input);
  }
});

rl.on("close", () => {
  if (geminiWs) geminiWs.close(1000);
  process.exit(0);
});
