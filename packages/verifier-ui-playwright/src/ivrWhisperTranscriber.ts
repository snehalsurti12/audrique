/**
 * IVR Whisper Transcriber — Local whisper.cpp wrapper for real-time IVR transcription.
 *
 * Uses whisper.cpp (compiled C++ binary) with the small multilingual model to transcribe
 * IVR audio prompts in real-time. This enables keyword-driven DTMF navigation instead of
 * blindly sending DTMF after any speech→silence transition.
 *
 * Fallback: if whisper-cpp binary or model is not found, callers fall back to
 * speech-silence-only mode (existing behavior).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Binary + model resolution ────────────────────────────────────────────────

const WHISPER_BINARY_NAMES = ["whisper-cpp", "whisper-cli", "main"];
const MODEL_SEARCH_PATHS = [
  "/opt/whisper-models",
  "/app/.models",
  "./.models",
  path.join(os.homedir(), ".cache", "whisper"),
];

/** Resolve whisper-cpp binary path (system PATH first, then common locations). */
export function resolveWhisperBinary(): string | null {
  // Check WHISPER_CPP_PATH env override
  const envPath = process.env.WHISPER_CPP_PATH?.trim();
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  // Try each binary name via `which`
  for (const name of WHISPER_BINARY_NAMES) {
    try {
      const result = execFileSync("which", [name], {
        encoding: "utf-8",
        timeout: 3000,
      }).trim();
      if (result && fs.existsSync(result)) {
        return result;
      }
    } catch {
      // not found, continue
    }
  }

  return null;
}

/** Resolve model path (env override, then standard locations). */
export function resolveWhisperModel(modelName = "ggml-small.bin"): string | null {
  // Check WHISPER_MODEL_PATH env override
  const envPath = process.env.WHISPER_MODEL_PATH?.trim();
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  for (const dir of MODEL_SEARCH_PATHS) {
    const candidate = path.join(dir, modelName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/** Check if whisper transcription is available (binary + model exist). */
export function isWhisperAvailable(): boolean {
  return resolveWhisperBinary() !== null && resolveWhisperModel() !== null;
}

// ── Audio conversion ─────────────────────────────────────────────────────────

/** Convert WebM buffer to WAV file (16kHz mono) via FFmpeg. Returns WAV path. */
export function convertWebmToWav(webmBuffer: Buffer, tmpDir: string): string {
  fs.mkdirSync(tmpDir, { recursive: true });
  const webmPath = path.join(tmpDir, `ivr-chunk-${Date.now()}.webm`);
  const wavPath = webmPath.replace(/\.webm$/, ".wav");

  fs.writeFileSync(webmPath, webmBuffer);

  try {
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-i", webmPath,
        "-ar", "16000",
        "-ac", "1",
        "-c:a", "pcm_s16le",
        wavPath,
      ],
      { timeout: 10_000, stdio: "pipe" }
    );
  } finally {
    // Clean up WebM temp file
    try { fs.unlinkSync(webmPath); } catch { /* ignore */ }
  }

  return wavPath;
}

// ── Transcription ────────────────────────────────────────────────────────────

export interface TranscriptionResult {
  text: string;
  durationMs: number;
}

/**
 * Transcribe audio buffer using whisper.cpp.
 *
 * 1. Saves WebM to temp file
 * 2. Converts to WAV 16kHz mono via FFmpeg
 * 3. Runs whisper-cpp with specified language
 * 4. Parses output text
 * 5. Cleans up temp files
 */
export function transcribeAudioChunk(
  webmBuffer: Buffer,
  opts?: { language?: string; modelPath?: string }
): TranscriptionResult {
  const whisperBin = resolveWhisperBinary();
  const modelPath = opts?.modelPath ?? resolveWhisperModel();

  if (!whisperBin || !modelPath) {
    throw new Error(
      `Whisper transcription not available. binary=${whisperBin ?? "NOT_FOUND"} model=${modelPath ?? "NOT_FOUND"}`
    );
  }

  const tmpDir = path.join(os.tmpdir(), "ivr-whisper");
  const startMs = Date.now();

  // Convert WebM → WAV
  const wavPath = convertWebmToWav(webmBuffer, tmpDir);

  try {
    const language = opts?.language?.trim() || "auto";

    // Build whisper-cpp args
    const args = [
      "--model", modelPath,
      "--file", wavPath,
      "--output-txt",
      "--no-timestamps",
      "--threads", String(Math.min(4, os.cpus().length)),
    ];

    // Add language flag (whisper.cpp uses --language)
    if (language !== "auto") {
      args.push("--language", language);
    }

    execFileSync(whisperBin, args, {
      timeout: 30_000,
      stdio: "pipe",
      encoding: "utf-8",
    });

    // whisper-cpp with --output-txt writes to <input>.txt
    const txtPath = wavPath + ".txt";
    let text = "";
    if (fs.existsSync(txtPath)) {
      text = fs.readFileSync(txtPath, "utf-8").trim();
      try { fs.unlinkSync(txtPath); } catch { /* ignore */ }
    }

    return {
      text,
      durationMs: Date.now() - startMs,
    };
  } finally {
    // Clean up WAV temp file
    try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
  }
}

// ── Keyword matching ─────────────────────────────────────────────────────────

export interface KeywordMatchResult {
  matched: boolean;
  keyword: string;
  transcript: string;
}

/**
 * Check if transcript matches any expected keyword pattern.
 *
 * Supports pipe-separated patterns for multilingual matching:
 *   "press 1|presione 1|appuyez sur 1"
 *
 * Matching is case-insensitive and ignores extra whitespace.
 */
export function matchExpectedKeyword(
  transcript: string,
  expectPattern: string
): KeywordMatchResult {
  const normalizedTranscript = transcript.toLowerCase().replace(/\s+/g, " ").trim();
  const keywords = expectPattern.split("|").map((k) => k.trim().toLowerCase());

  for (const keyword of keywords) {
    if (!keyword) continue;
    if (normalizedTranscript.includes(keyword)) {
      return { matched: true, keyword, transcript: normalizedTranscript };
    }
  }

  return { matched: false, keyword: "", transcript: normalizedTranscript };
}
