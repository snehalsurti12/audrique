/**
 * transcriptWriter.mjs — Conversation transcript capture + assertion evaluation
 *
 * Saves turn-by-turn conversation transcript as JSON artifact.
 * Evaluates conversation-level assertions (greeting, issue identified, resolution, etc.).
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Evaluate conversation assertions against the transcript.
 *
 * @param {Array<object>} transcript — [{ speaker, text, timestamp, turn }]
 * @param {Array<object>} assertions — [{ type, within_turns, keywords, ... }]
 * @param {object} [opts] — { objective }
 * @returns {Array<object>} results — [{ type, passed, detail }]
 */
export function evaluateAssertions(transcript, assertions, opts = {}) {
  if (!assertions || assertions.length === 0) return [];

  const results = [];

  for (const assertion of assertions) {
    switch (assertion.type) {
      case "agent_greeted_customer": {
        const withinTurns = assertion.within_turns || 2;
        const earlyTurns = transcript.filter(
          (t) => t.speaker === "agentforce" && t.turn <= withinTurns
        );
        const hasGreeting = earlyTurns.some((t) => {
          const lower = t.text.toLowerCase();
          return /\b(hi|hello|welcome|good\s+(morning|afternoon|evening)|how can i help|how may i assist)\b/.test(lower);
        });
        results.push({
          type: assertion.type,
          passed: hasGreeting,
          detail: hasGreeting
            ? `Agent greeted within ${withinTurns} turns`
            : `No greeting detected in first ${withinTurns} turns`,
        });
        break;
      }

      case "agent_identified_issue": {
        const keywords = assertion.keywords || [];
        const agentTurns = transcript.filter((t) => t.speaker === "agentforce");
        const allAgentText = agentTurns.map((t) => t.text.toLowerCase()).join(" ");
        const found = keywords.filter((kw) => allAgentText.includes(kw.toLowerCase()));
        const passed = found.length > 0;
        results.push({
          type: assertion.type,
          passed,
          detail: passed
            ? `Agent mentioned: ${found.join(", ")}`
            : `None of [${keywords.join(", ")}] found in agent responses`,
        });
        break;
      }

      case "resolution_reached": {
        const withinTurns = assertion.within_turns || 15;
        const allText = transcript
          .filter((t) => t.turn <= withinTurns)
          .map((t) => t.text.toLowerCase())
          .join(" ");
        const resolutionPatterns = /\b(resolved|completed|processed|refund|confirmation|done|all set|anything else|is there anything)\b/;
        const passed = resolutionPatterns.test(allText);
        results.push({
          type: assertion.type,
          passed,
          detail: passed
            ? `Resolution language detected within ${withinTurns} turns`
            : `No resolution indicators found within ${withinTurns} turns`,
        });
        break;
      }

      case "caller_objective_met": {
        // Check if the conversation indicates the objective was addressed
        const objective = opts.objective || "";
        const allAgentText = transcript
          .filter((t) => t.speaker === "agentforce")
          .map((t) => t.text.toLowerCase())
          .join(" ");
        // Extract keywords from objective
        const objWords = objective.toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 3 && !/^(the|and|for|get|with|that|this|from|have)$/.test(w));
        const matchedWords = objWords.filter((w) => allAgentText.includes(w));
        const passed = matchedWords.length >= Math.ceil(objWords.length * 0.3);
        results.push({
          type: assertion.type,
          passed,
          detail: passed
            ? `Objective keywords found: ${matchedWords.join(", ")}`
            : `Only ${matchedWords.length}/${objWords.length} objective keywords found`,
        });
        break;
      }

      case "max_turns_not_exceeded": {
        const maxTurns = assertion.max_turns || 15;
        const totalTurns = transcript.filter((t) => t.speaker === "caller").length;
        const passed = totalTurns <= maxTurns;
        results.push({
          type: assertion.type,
          passed,
          detail: passed
            ? `${totalTurns} caller turns (max ${maxTurns})`
            : `${totalTurns} caller turns exceeded max ${maxTurns}`,
        });
        break;
      }

      case "conversation_ended_naturally": {
        const lastFewTurns = transcript.slice(-4);
        const endPatterns = /\b(goodbye|bye|thank you|thanks|have a (good|great|nice) day)\b/i;
        const passed = lastFewTurns.some((t) => endPatterns.test(t.text));
        results.push({
          type: assertion.type,
          passed,
          detail: passed
            ? "Conversation ended with natural closing"
            : "No natural closing detected in final turns",
        });
        break;
      }

      case "escalation_detected": {
        // Check agentforce turns for escalation language
        const escalationPhrases = [
          "transfer", "transferring", "connect you with", "connect you to",
          "specialist", "human agent", "live agent", "representative",
          "hold while", "please hold", "one moment", "escalat",
        ];
        const agentforceTurns = transcript.filter((t) => t.speaker === "agentforce");
        const callerTurns = transcript.filter((t) => t.speaker === "caller");
        const agentText = agentforceTurns.map((t) => t.text.toLowerCase()).join(" ");
        const callerText = callerTurns.map((t) => t.text.toLowerCase()).join(" ");
        // Escalation detected if Agentforce used escalation language OR caller acknowledged transfer
        const agentEscalated = escalationPhrases.some((p) => agentText.includes(p));
        const callerAcknowledgedTransfer = /transfer|live agent|human agent|escalat|hold|speak with/.test(callerText);
        const passed = agentEscalated || callerAcknowledgedTransfer;
        results.push({
          type: assertion.type,
          passed,
          detail: passed
            ? agentEscalated
              ? "Agentforce used escalation language"
              : "Caller acknowledged transfer/escalation"
            : "No escalation detected in conversation",
        });
        break;
      }

      default:
        results.push({
          type: assertion.type,
          passed: false,
          detail: `Unknown assertion type: ${assertion.type}`,
        });
    }
  }

  return results;
}

/**
 * Write conversation transcript and assertion results to disk.
 *
 * @param {object} opts
 * @param {string} opts.outputDir — directory for artifacts
 * @param {Array<object>} opts.transcript — conversation turns
 * @param {Array<object>} [opts.assertionResults] — evaluated assertions
 * @param {object} [opts.metadata] — { durationSec, turnCount, mode, persona, ... }
 * @returns {string} path to written transcript file
 */
export function writeTranscript(opts) {
  const {
    outputDir,
    transcript,
    assertionResults = [],
    metadata = {},
  } = opts;

  fs.mkdirSync(outputDir, { recursive: true });

  const output = {
    timestamp: new Date().toISOString(),
    mode: metadata.mode || "unknown",
    persona: metadata.persona || null,
    durationSec: metadata.durationSec || 0,
    totalTurns: transcript.length,
    callerTurns: transcript.filter((t) => t.speaker === "caller").length,
    agentTurns: transcript.filter((t) => t.speaker === "agentforce").length,
    turns: transcript.map((t) => ({
      speaker: t.speaker,
      text: t.text,
      timestamp: t.timestamp,
    })),
    assertions: assertionResults.map((r) => ({
      type: r.type,
      passed: r.passed,
      detail: r.detail,
    })),
    allAssertionsPassed: assertionResults.length === 0 || assertionResults.every((r) => r.passed),
  };

  const filePath = path.join(outputDir, "conversation-transcript.json");
  fs.writeFileSync(filePath, JSON.stringify(output, null, 2));

  return filePath;
}
