import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright";

async function main() {
  const loginUrl = must("SF_LOGIN_URL");
  const username = must("SF_USERNAME");
  const password = must("SF_PASSWORD");
  const serviceConsoleUrl = (process.env.SF_SERVICE_CONSOLE_URL || "").trim();
  const appUrl = (process.env.SF_APP_URL || "").trim();
  const appName = (process.env.SF_APP_NAME || "Service Console").trim();
  const instanceUrl = (process.env.SF_INSTANCE_URL || "").trim();
  const storageStatePath = process.env.SF_STORAGE_STATE || ".auth/sf-agent.json";
  const cookiesPath = process.env.SF_COOKIES_PATH || ".auth/sf-cookies.json";
  const emailCode = process.env.SF_EMAIL_CODE ?? "";
  const totpSecret = (process.env.SF_TOTP_SECRET || "").trim();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    page.getByRole("button", { name: /log in/i }).click()
  ]);
  await page.waitForTimeout(1500);

  // Check for login error before proceeding
  const loginError = await page.locator("#error").textContent().catch(() => "");
  if (loginError) {
    console.error("[sf-login] Login failed:", loginError.trim());
    await page.screenshot({ path: "test-results/sf-login-error.png", fullPage: true });
  }

  await completeIdentityVerificationIfPresent(page, emailCode, totpSecret);

  const finishLoginLink = page.getByRole("link", { name: /finish logging in/i }).first();
  if ((await finishLoginLink.count()) > 0) {
    await Promise.all([page.waitForLoadState("domcontentloaded"), finishLoginLink.click()]);
    await page.waitForTimeout(1500);
    await completeIdentityVerificationIfPresent(page, emailCode, totpSecret);
  }

  const startTarget = resolveSalesforceStartTarget({
    serviceConsoleUrl,
    appUrl,
    baseUrl: instanceUrl || page.url()
  });
  if (!startTarget) {
    throw new Error("Unable to resolve Salesforce start URL. Set SF_APP_URL, SF_SERVICE_CONSOLE_URL, or SF_INSTANCE_URL.");
  }
  await page.goto(startTarget, { waitUntil: "domcontentloaded" });

  const finishLoginRequired = await page
    .getByRole("link", { name: /finish logging in/i })
    .first()
    .isVisible()
    .catch(() => false);
  if (finishLoginRequired) {
    const finishLink = page.getByRole("link", { name: /finish logging in/i }).first();
    await Promise.all([page.waitForLoadState("domcontentloaded"), finishLink.click()]);
    await page.waitForTimeout(1000);
    await completeIdentityVerificationIfPresent(page, emailCode, totpSecret);
    await page.goto(startTarget, { waitUntil: "domcontentloaded" });
  }

  await ensureSalesforceApp(page, appName);

  const stillOnLogin = await page.getByLabel("Username").isVisible().catch(() => false);
  const stillOnVerification = page.url().includes("/_ui/identity/verification/");
  const stillRequiresFinishFlow = await page
    .getByRole("link", { name: /finish logging in/i })
    .first()
    .isVisible()
    .catch(() => false);
  const authenticated = !stillOnLogin && !stillOnVerification && !stillRequiresFinishFlow;

  fs.mkdirSync(path.join(process.cwd(), ".auth"), { recursive: true });
  await page.context().storageState({ path: storageStatePath });
  const cookies = await page.context().cookies();
  fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2), "utf8");
  await page.screenshot({ path: "test-results/post-auth.png", fullPage: true });

  console.log(
    JSON.stringify(
      {
        authenticated,
        finalUrl: page.url(),
        storageStatePath,
        cookiesPath
      },
      null,
      2
    )
  );

  await browser.close();
  if (!authenticated) {
    process.exit(3);
  }
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
  if (await isInSalesforceApp(page, appName)) {
    return;
  }
  const appLauncher = page
    .getByRole("button", { name: /app launcher/i })
    .or(page.getByText(/app launcher/i))
    .first();
  if ((await appLauncher.count()) > 0) {
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
    const appRegex = new RegExp(escapeRegex(appName), "i");
    const appResult = page
      .getByRole("link", { name: appRegex })
      .or(page.getByRole("button", { name: appRegex }))
      .first();
    if ((await appResult.count()) > 0) {
      await Promise.all([page.waitForLoadState("domcontentloaded"), appResult.click({ force: true })]);
      await page.waitForTimeout(1200);
    }
  }
}

async function isInSalesforceApp(page, appName) {
  const appRegex = new RegExp(escapeRegex(appName), "i");
  const heading = page.getByRole("heading", { name: appRegex }).first();
  if ((await heading.count()) > 0) {
    return true;
  }
  const text = await page.locator("body").innerText().catch(() => "");
  return appRegex.test(text);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function completeIdentityVerificationIfPresent(page, emailCode, totpSecret) {
  if (!page.url().includes("/_ui/identity/verification/")) {
    return;
  }

  // Try TOTP (authenticator app) first if secret is available
  if (totpSecret) {
    const usedTotp = await tryTotpVerification(page, totpSecret);
    if (usedTotp) return;
    // If TOTP UI wasn't found, fall through to email code path
  }

  if (!emailCode) {
    throw new Error("Identity verification page detected but neither SF_TOTP_SECRET nor SF_EMAIL_CODE is available.");
  }

  const selectors = [
    "input[name*='code']",
    "input[id*='code']",
    "input[type='text']",
    "input[type='tel']"
  ];

  let inputFound = false;
  for (const selector of selectors) {
    const field = page.locator(selector).first();
    if ((await field.count()) > 0) {
      await field.fill(emailCode);
      inputFound = true;
      break;
    }
  }

  if (!inputFound) {
    await page.screenshot({ path: "test-results/verification-input-not-found.png", fullPage: true });
    throw new Error("Could not find verification code input.");
  }

  const submitButton = page.getByRole("button", { name: /verify|continue|submit|next/i }).first();
  if ((await submitButton.count()) > 0) {
    await Promise.all([page.waitForLoadState("domcontentloaded"), submitButton.click()]);
  } else {
    const submitInput = page.locator("input[type='submit'][value*='Verify'], #save").first();
    if ((await submitInput.count()) > 0) {
      await Promise.all([page.waitForLoadState("domcontentloaded"), submitInput.click()]);
    } else {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1000);
    }
  }

  await page.waitForTimeout(1200);
  if (page.url().includes("/_ui/identity/verification/")) {
    const verificationErrors = (
      await page
        .locator(".message.errorM3, .oneError, [id*='error'], .error")
        .allTextContents()
        .catch(() => [])
    )
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" | ");
    const suffix = verificationErrors ? ` Error=${verificationErrors}` : "";
    throw new Error(`Verification code was not accepted.${suffix}`);
  }
}

async function tryTotpVerification(page, totpSecret) {
  // Salesforce shows verification method options — look for "Authenticator App" or TOTP option
  const totpOption = page.locator([
    "a:has-text('One-Time Password Generator')",
    "a:has-text('Authenticator App')",
    "a:has-text('TOTP')",
    "input[value*='totp']",
    "input[value*='authenticator']",
    "[data-method='totp']",
    "[data-method='otp']"
  ].join(", ")).first();

  if ((await totpOption.count()) > 0) {
    console.log("TOTP: Selecting authenticator app verification method...");
    await totpOption.click();
    await page.waitForTimeout(1500);
  }

  // Check if we're on a TOTP code entry page (may already be there or after clicking option)
  const codeInput = page.locator([
    "input[name*='code']",
    "input[id*='code']",
    "input[id*='otp']",
    "input[type='text']",
    "input[type='tel']"
  ].join(", ")).first();

  if ((await codeInput.count()) === 0) {
    console.log("TOTP: No code input found on verification page.");
    await page.screenshot({ path: "test-results/totp-no-input.png", fullPage: true });
    return false;
  }

  const code = generateTotpCode(totpSecret);
  console.log(`TOTP: Generated code ${code}, submitting...`);
  await codeInput.fill(code);

  const submitButton = page.getByRole("button", { name: /verify|continue|submit|next/i }).first();
  if ((await submitButton.count()) > 0) {
    await Promise.all([page.waitForLoadState("domcontentloaded"), submitButton.click()]);
  } else {
    const submitInput = page.locator("input[type='submit'][value*='Verify'], #save").first();
    if ((await submitInput.count()) > 0) {
      await Promise.all([page.waitForLoadState("domcontentloaded"), submitInput.click()]);
    } else {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1000);
    }
  }

  await page.waitForTimeout(1200);

  if (page.url().includes("/_ui/identity/verification/")) {
    const errors = (
      await page
        .locator(".message.errorM3, .oneError, [id*='error'], .error")
        .allTextContents()
        .catch(() => [])
    )
      .map((l) => l.trim())
      .filter(Boolean)
      .join(" | ");
    console.log(`TOTP: Verification failed. ${errors || "Still on verification page."}`);
    await page.screenshot({ path: "test-results/totp-failed.png", fullPage: true });
    return false;
  }

  console.log("TOTP: Verification succeeded.");
  return true;
}

function generateTotpCode(secret) {
  // RFC 6238 TOTP: HMAC-SHA1 over counter derived from current time
  const period = 30;
  const digits = 6;
  const counter = Math.floor(Date.now() / 1000 / period);

  // Decode base32 secret
  const key = base32Decode(secret);

  // Counter as 8-byte big-endian buffer
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuf.writeUInt32BE(counter & 0xffffffff, 4);

  // HMAC-SHA1
  const hmac = crypto.createHmac("sha1", key);
  hmac.update(counterBuf);
  const hash = hmac.digest();

  // Dynamic truncation
  const offset = hash[hash.length - 1] & 0x0f;
  const binary =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);

  const otp = binary % 10 ** digits;
  return otp.toString().padStart(digits, "0");
}

function base32Decode(encoded) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = encoded.replace(/[\s=]/g, "").toUpperCase();
  let bits = "";
  for (const ch of cleaned) {
    const val = alphabet.indexOf(ch);
    if (val === -1) throw new Error(`Invalid base32 character: ${ch}`);
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}


function must(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

void main();
