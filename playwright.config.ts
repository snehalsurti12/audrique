import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const storageStatePath = process.env.SF_STORAGE_STATE;
const storageState =
  storageStatePath && fs.existsSync(storageStatePath) ? storageStatePath : undefined;
const useFakeMedia = process.env.PW_USE_FAKE_MEDIA !== "false";
const isHeadless = process.env.PW_HEADLESS !== "false";
const videoMode = (process.env.PW_VIDEO_MODE ?? "retain-on-failure") as
  | "off"
  | "on"
  | "retain-on-failure"
  | "on-first-retry";
const fakeAudioFile = process.env.PW_FAKE_AUDIO_FILE?.trim();
const chromiumArgs = [
  ...(useFakeMedia ? ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] : []),
  ...(fakeAudioFile ? [`--use-file-for-fake-audio-capture=${path.resolve(fakeAudioFile)}`] : [])
];

export default defineConfig({
  testDir: "./packages/verifier-ui-playwright/tests",
  timeout: 90_000,
  expect: {
    timeout: 20_000
  },
  use: {
    headless: isHeadless,
    storageState,
    permissions: ["microphone"],
    launchOptions: {
      args: chromiumArgs
    },
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: videoMode
  },
  reporter: [["list"], ["html", { open: "never" }]]
});
