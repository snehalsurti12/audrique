import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function main() {
  const text =
    process.env.FAKE_SPEECH_TEXT?.trim() ||
    "Hello. This is an automated transcript verification call. Please capture this sentence in real time.";
  const voice = process.env.FAKE_SPEECH_VOICE?.trim() || "Samantha";
  const outPath = path.resolve(
    process.cwd(),
    process.env.FAKE_SPEECH_OUT?.trim() || "test-assets/transcript-sample.wav"
  );
  const aiffPath = outPath.replace(/\.wav$/i, ".aiff");

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  execFileSync("say", ["-v", voice, "-o", aiffPath, text], { stdio: "inherit" });
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", aiffPath, outPath], {
    stdio: "inherit"
  });
  fs.rmSync(aiffPath, { force: true });

  console.log(
    JSON.stringify(
      {
        generated: true,
        outPath,
        voice,
        text
      },
      null,
      2
    )
  );
}

main();
