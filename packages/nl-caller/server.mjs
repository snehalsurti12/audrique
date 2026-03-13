/**
 * server.mjs — NL Caller WebSocket server
 *
 * Bridges two bidirectional WebSocket connections:
 *  1. Twilio <Connect><Stream> — sends/receives mulaw 8kHz audio
 *  2. Gemini Live API — sends/receives PCM 16kHz/24kHz audio
 *
 * Also serves TwiML endpoint for Twilio to connect the stream.
 *
 * Architecture:
 *   Twilio call → <Connect><Stream> → this server ↔ Gemini Live API
 *                                    ↕
 *                              conversationEngine
 */

import { WebSocketServer } from "ws";
import http from "node:http";
import { spawn } from "node:child_process";
import {
  twilioToGeminiBase64,
  geminiBase64ToTwilio,
} from "./audioCodec.mjs";

/**
 * Create and start the NL Caller server.
 *
 * @param {object} opts
 * @param {number} opts.port — HTTP/WS port (default: 8765)
 * @param {object} opts.engine — conversationEngine instance
 * @param {object} [opts.logger] — optional logger ({ log, error })
 * @returns {{ server: http.Server, wss: WebSocketServer, close: () => Promise<void> }}
 */
export function createNlCallerServer(opts) {
  const {
    port = 8765,
    engine,
    logger = console,
  } = opts;

  const server = http.createServer(handleHttp);
  const wss = new WebSocketServer({ server });

  // ── HTTP handler (TwiML endpoint) ───────────────────────────────

  function handleHttp(req, res) {
    logger.log(`[nl-caller] HTTP ${req.method} ${req.url} from ${req.headers["user-agent"] || "unknown"}`);

    // POST /twiml — returns TwiML that connects Twilio to our WebSocket
    if ((req.method === "POST" || req.method === "GET") && req.url?.startsWith("/twiml")) {
      const wsUrl = `wss://${req.headers.host}/stream`;
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;
      logger.log(`[nl-caller] TwiML served → Stream URL: ${wsUrl}`);
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end(twiml);
      return;
    }

    // GET /health
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", engine: engine?.getState?.() || "unknown" }));
      return;
    }

    logger.log(`[nl-caller] HTTP 404 — unmatched: ${req.method} ${req.url}`);
    res.writeHead(404);
    res.end("Not found");
  }

  // ── WebSocket handler (Twilio Stream protocol) ──────────────────

  wss.on("connection", (ws, req) => {
    logger.log("[nl-caller] Twilio Stream WebSocket connected");

    let streamSid = null;
    let callSid = null;

    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        switch (msg.event) {
          case "connected":
            logger.log("[nl-caller] Twilio Stream: connected");
            break;

          case "start":
            streamSid = msg.start?.streamSid;
            callSid = msg.start?.callSid;
            logger.log(`[nl-caller] Twilio Stream started — streamSid=${streamSid} callSid=${callSid}`);

            // Notify engine that call has started
            if (engine?.onCallStarted) {
              await engine.onCallStarted({ streamSid, callSid });
            }
            break;

          case "media":
            // Twilio sends mulaw 8kHz base64 audio chunks
            if (msg.media?.payload && engine?.onAudioIn) {
              await engine.onAudioIn(msg.media.payload);
            }
            break;

          case "mark":
            // Twilio confirms our mark was played
            if (engine?.onMarkPlayed) {
              engine.onMarkPlayed(msg.mark?.name);
            }
            break;

          case "stop":
            logger.log("[nl-caller] Twilio Stream stopped");
            if (engine?.onCallEnded) {
              await engine.onCallEnded({ reason: "twilio-stop" });
            }
            break;

          default:
            break;
        }
      } catch (err) {
        logger.error("[nl-caller] Error processing Twilio message:", err.message);
      }
    });

    ws.on("close", () => {
      logger.log("[nl-caller] Twilio WebSocket closed");
      if (engine?.onCallEnded) {
        engine.onCallEnded({ reason: "ws-close" });
      }
    });

    ws.on("error", (err) => {
      logger.error("[nl-caller] Twilio WebSocket error:", err.message);
    });

    // ── Send audio back to Twilio ─────────────────────────────────

    /**
     * Send mulaw base64 audio to Twilio Stream.
     * @param {string} base64Mulaw — mulaw 8kHz audio
     */
    function sendAudioToTwilio(base64Mulaw) {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: base64Mulaw },
      }));
    }

    /**
     * Send a mark event to Twilio (for timing/sync).
     * @param {string} name — mark name
     */
    function sendMark(name) {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({
        event: "mark",
        streamSid,
        mark: { name },
      }));
    }

    /**
     * Clear the Twilio audio queue (interrupt).
     */
    function clearTwilioAudio() {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({
        event: "clear",
        streamSid,
      }));
    }

    // Register send functions with the engine
    if (engine?.registerTwilioSender) {
      engine.registerTwilioSender({
        sendAudio: sendAudioToTwilio,
        sendMark,
        clearAudio: clearTwilioAudio,
      });
    }
  });

  // ── Start server ────────────────────────────────────────────────

  server.listen(port, () => {
    logger.log(`[nl-caller] Server listening on port ${port}`);
    logger.log(`[nl-caller] TwiML endpoint: POST http://localhost:${port}/twiml`);
    logger.log(`[nl-caller] WebSocket: ws://localhost:${port}/stream`);
  });

  let tunnelProcess = null;
  let tunnelUrl = null;
  let localtunnelInstance = null;

  /**
   * Start a tunnel exposing the server to the internet.
   * Tries cloudflared first (Cloudflare-backed, reliable), falls back to localtunnel.
   * @returns {Promise<string>} public HTTPS URL
   */
  async function startTunnel() {
    if (tunnelUrl) return tunnelUrl;

    // Kill any orphaned cloudflared processes from prior runs
    try {
      const { execSync } = await import("node:child_process");
      execSync(`pkill -f "cloudflared tunnel --url http://localhost:${port}" 2>/dev/null`, { stdio: "ignore" });
    } catch { /* no orphans */ }

    // Try cloudflared first — Cloudflare-backed, no port-refusal issues like localtunnel.me
    logger.log("[nl-caller] Starting cloudflared tunnel...");
    try {
      const url = await new Promise((resolve, reject) => {
        const proc = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        tunnelProcess = proc;

        let resolved = false;
        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            proc.kill();
            tunnelProcess = null;
            reject(new Error("cloudflared startup timed out after 20s"));
          }
        }, 20000);

        let pendingUrl = null;
        proc.stderr.on("data", (chunk) => {
          const line = chunk.toString();
          const match = line.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/);
          if (match) {
            pendingUrl = match[1];
            logger.log(`[nl-caller] Cloudflared URL: ${pendingUrl} (waiting for connection...)`);
          }
          if (pendingUrl && !resolved && /Registered tunnel connection/.test(line)) {
            resolved = true;
            clearTimeout(timeout);
            resolve(pendingUrl);
          }
        });

        proc.on("error", (err) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            reject(new Error(`Failed to start cloudflared: ${err.message}`));
          }
        });

        proc.on("exit", (code) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            reject(new Error(`cloudflared exited with code ${code}`));
          }
        });
      });

      tunnelUrl = url;
      logger.log(`[nl-caller] Cloudflared connected: ${tunnelUrl}`);
      return tunnelUrl;
    } catch (err) {
      logger.log(`[nl-caller] Cloudflared failed: ${err.message} — falling back to localtunnel`);
      tunnelProcess = null;
    }

    // Fallback: localtunnel (free service, occasionally refuses connections)
    try {
      const localtunnel = (await import("localtunnel")).default;
      logger.log("[nl-caller] Starting localtunnel...");
      const lt = await localtunnel({ port });
      localtunnelInstance = lt;
      tunnelUrl = lt.url;
      logger.log(`[nl-caller] Localtunnel ready: ${tunnelUrl}`);

      lt.on("close", () => { logger.log("[nl-caller] Localtunnel closed"); });
      lt.on("error", (err) => { logger.error("[nl-caller] Localtunnel error:", err.message); });

      return tunnelUrl;
    } catch (err) {
      throw new Error(`All tunnel providers failed. Last error: ${err.message}`);
    }
  }

  async function close() {
    if (localtunnelInstance) {
      localtunnelInstance.close();
      localtunnelInstance = null;
    }
    if (tunnelProcess) {
      tunnelProcess.kill();
      tunnelProcess = null;
    }
    tunnelUrl = null;
    return new Promise((resolve) => {
      wss.close(() => {
        server.close(resolve);
      });
    });
  }

  return { server, wss, close, startTunnel };
}
