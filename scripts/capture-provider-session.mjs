import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

async function main() {
  const serviceConsoleUrl = (process.env.SF_SERVICE_CONSOLE_URL || "").trim();
  const appUrl = (process.env.SF_APP_URL || "").trim();
  const appName = (process.env.SF_APP_NAME || "Service Console").trim();
  const instanceUrl = (process.env.SF_INSTANCE_URL || "").trim();
  const storagePath = process.env.SF_STORAGE_STATE || ".auth/sf-agent.json";
  const timeoutMs = Number(process.env.PROVIDER_LOGIN_TIMEOUT_SEC || "300") * 1000;

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: fs.existsSync(storagePath) ? storagePath : undefined,
    permissions: ["microphone"]
  });
  const page = await context.newPage();
  const startTarget = resolveSalesforceStartTarget({
    serviceConsoleUrl,
    appUrl,
    baseUrl: instanceUrl
  });
  if (!startTarget) {
    await browser.close();
    throw new Error("Unable to resolve Salesforce start URL. Set SF_APP_URL, SF_SERVICE_CONSOLE_URL, or SF_INSTANCE_URL.");
  }
  await page.goto(startTarget, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await ensureSalesforceApp(page, appName);

  // Open utility so user can complete provider sign-in in this same browser context.
  const phoneButton = page.getByRole("button", { name: /^phone$/i }).first();
  if ((await phoneButton.count()) > 0) {
    await phoneButton.click({ force: true });
    await page.waitForTimeout(500);
  }
  const connectionButton = page.getByRole("button", { name: /connection status/i }).first();
  if ((await connectionButton.count()) > 0) {
    await connectionButton.click({ force: true });
    await page.waitForTimeout(500);
  }

  console.log("Complete Amazon Connect/CCP login in this browser window.");
  console.log("Waiting for provider status to stop showing NotLoggedIn...");

  const deadline = Date.now() + timeoutMs;
  let consecutiveHealthyChecks = 0;
  while (Date.now() < deadline) {
    const body = await page.locator("body").innerText().catch(() => "");
    const notLoggedIn = /notloggedin|not logged in to your telephony provider/i.test(body);
    if (!notLoggedIn) {
      consecutiveHealthyChecks += 1;
      if (consecutiveHealthyChecks >= 2) {
        break;
      }
    } else {
      consecutiveHealthyChecks = 0;
    }
    await page.waitForTimeout(2000);
  }

  if (consecutiveHealthyChecks < 2) {
    await browser.close();
    throw new Error("Timed out waiting for provider login to complete.");
  }

  fs.mkdirSync(path.dirname(storagePath), { recursive: true });
  await context.storageState({ path: storagePath });
  const cookies = await context.cookies();
  fs.writeFileSync(".auth/sf-cookies.json", JSON.stringify(cookies, null, 2), "utf8");
  await page.screenshot({ path: "test-results/provider-session-captured.png", fullPage: true });
  await browser.close();

  console.log(JSON.stringify({ captured: true, storagePath }, null, 2));
}

function must(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

function resolveSalesforceStartTarget(input) {
  const direct = input.appUrl.trim();
  if (direct) {
    if (/^https?:\/\//i.test(direct)) {
      return direct;
    }
    if (/^https?:\/\//i.test(input.baseUrl)) {
      return new URL(direct, input.baseUrl).toString();
    }
    return "";
  }

  const consoleUrl = input.serviceConsoleUrl.trim();
  if (consoleUrl) {
    if (/^https?:\/\//i.test(consoleUrl)) {
      return consoleUrl;
    }
    if (/^https?:\/\//i.test(input.baseUrl)) {
      return new URL(consoleUrl, input.baseUrl).toString();
    }
    return "";
  }

  if (/^https?:\/\//i.test(input.baseUrl)) {
    return new URL("/lightning/page/home", input.baseUrl).toString();
  }
  return "";
}

async function ensureSalesforceApp(page, appName) {
  const appRegex = new RegExp(escapeRegex(appName), "i");
  const currentBody = await page.locator("body").innerText().catch(() => "");
  if (appRegex.test(currentBody)) {
    return;
  }

  const appLauncher = page
    .getByRole("button", { name: /app launcher/i })
    .or(page.getByText(/app launcher/i))
    .first();
  if ((await appLauncher.count()) === 0) {
    return;
  }

  await appLauncher.click({ force: true });
  await page.waitForTimeout(600);
  const search = page
    .getByRole("searchbox", { name: /search apps|search apps and items/i })
    .or(page.getByPlaceholder(/search apps|search apps and items/i))
    .first();
  if ((await search.count()) > 0) {
    await search.fill(appName);
    await page.waitForTimeout(600);
  }

  const appResult = page
    .getByRole("link", { name: appRegex })
    .or(page.getByRole("button", { name: appRegex }))
    .first();
  if ((await appResult.count()) > 0) {
    await Promise.all([page.waitForLoadState("domcontentloaded"), appResult.click({ force: true })]);
    await page.waitForTimeout(1200);
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

void main();
