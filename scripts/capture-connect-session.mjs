import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

async function main() {
  let ccpUrl = (process.env.CONNECT_CCP_URL || "").trim();
  const configuredStartUrl = (process.env.CONNECT_START_URL || ccpUrl || "https://console.aws.amazon.com/connect/home").trim();
  const autoNavigateFromConsole = process.env.CONNECT_AUTO_NAVIGATE_FROM_CONSOLE === "true";
  const autoAwsLogin = process.env.CONNECT_AUTO_AWS_LOGIN !== "false";
  const consoleRegion = (process.env.CONNECT_CONSOLE_REGION || process.env.AWS_REGION || "").trim();
  const allowEmergencyLaunch = /^(true|1|yes|on)$/i.test(
    (process.env.CONNECT_ALLOW_EMERGENCY_LAUNCH ?? "false").trim()
  );
  const startUrl = resolvePreferredStartUrl(configuredStartUrl, consoleRegion);
  const awsAccountId = process.env.AWS_ACCOUNT_ID?.trim() || "";
  const awsUsername = process.env.AWS_USERNAME?.trim() || "";
  const awsPassword = process.env.AWS_PASSWORD?.trim() || "";
  const awsMfaCode = process.env.AWS_MFA_CODE?.trim() || "";
  const storagePath = process.env.CONNECT_STORAGE_STATE || ".auth/connect-ccp.json";
  const timeoutMs = Number(process.env.CONNECT_LOGIN_TIMEOUT_SEC || "420") * 1000;

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: fs.existsSync(storagePath) ? storagePath : undefined,
    permissions: ["microphone"]
  });
  let page = await context.newPage();
  await page.goto(startUrl, { waitUntil: "domcontentloaded" });

  console.log("Complete AWS Console/Amazon Connect login in the opened browser window.");
  console.log("Navigation flow: AWS sign-in -> Connect console -> CCP (/ccp-v2).");
  if (!ccpUrl) {
    console.log("CONNECT_CCP_URL is not set; attempting to discover CCP URL from console navigation.");
  }
  if (autoAwsLogin && awsUsername && awsPassword) {
    console.log("Auto AWS sign-in is enabled (username/password detected).");
  }
  if (!autoNavigateFromConsole) {
    console.log("Manual mode: after AWS sign-in, open Connect instance and then open CCP in this same window.");
  }
  console.log("Waiting for CCP session to become active...");

  const deadline = Date.now() + timeoutMs;
  let consecutiveHealthyChecks = 0;
  let hintedForExpiredSession = false;
  let hintedForSignin = false;
  let hintedForConsole = false;
  let hintedForManualConsoleSteps = false;
  let lastProgressLogAt = 0;
  let lastCcpAttemptAt = 0;
  let lastStartAttemptAt = 0;
  let lastConsoleWarmupAt = 0;
  let lastConsoleLaunchAttemptAt = 0;
  let lastAutoSigninAttemptAt = 0;
  let hintedForMfa = false;
  let lastDialogDismissLogAt = 0;
  let lastFeedbackRecoveryLogAt = 0;
  let lastRegionRedirectAt = 0;
  let lastBadRequestRecoveryLogAt = 0;
  while (Date.now() < deadline) {
    const activePage = getActivePage(context, page);
    if (!activePage) {
      page = await context.newPage();
      await page.goto(startUrl, { waitUntil: "domcontentloaded" });
      await sleep(1000);
      continue;
    }
    page = activePage;

    let state;
    try {
      state = await readCcpState(activePage);
    } catch {
      consecutiveHealthyChecks = 0;
      await sleep(1000);
      continue;
    }

    const dismissedDialog = await dismissInterruptingDialog(activePage).catch(() => false);
    if (dismissedDialog && Date.now() - lastDialogDismissLogAt > 10_000) {
      console.log("Dismissed blocking dialog/pop-up.");
      lastDialogDismissLogAt = Date.now();
    }

    if (!ccpUrl) {
      ccpUrl = deriveCcpUrlFromUrl(state.url) || ccpUrl;
    }

    if (state.isFeedbackPage) {
      const recovered = await recoverFromFeedbackPage(activePage, { startUrl, ccpUrl }).catch(() => false);
      if (recovered && Date.now() - lastFeedbackRecoveryLogAt > 10_000) {
        console.log("Recovered from feedback page and returned to Connect flow.");
        lastFeedbackRecoveryLogAt = Date.now();
      }
      await sleep(1500);
      continue;
    }

    if (state.isBadRequestPage) {
      const recovered = await recoverFromBadRequestPage(activePage, { startUrl }).catch(() => false);
      if (recovered && Date.now() - lastBadRequestRecoveryLogAt > 10_000) {
        console.log("Recovered from 400/Bad Request page and resumed login flow.");
        lastBadRequestRecoveryLogAt = Date.now();
      }
      await sleep(1500);
      continue;
    }

    if (state.isHealthy) {
      consecutiveHealthyChecks += 1;
      if (consecutiveHealthyChecks >= 3) {
        break;
      }
    } else {
      consecutiveHealthyChecks = 0;
    }

    if (Date.now() - lastProgressLogAt > 12_000) {
      console.log(`Current page: ${state.url}`);
      lastProgressLogAt = Date.now();
    }

    if (state.isAwsSignin) {
      if (autoAwsLogin && awsUsername && awsPassword && Date.now() - lastAutoSigninAttemptAt > 8000) {
        const autoSignIn = await tryAutoAwsSignIn(activePage, {
          accountId: awsAccountId,
          username: awsUsername,
          password: awsPassword,
          mfaCode: awsMfaCode
        });
        if (autoSignIn.submitted) {
          console.log(`Attempted AWS sign-in automatically (${autoSignIn.action || "submit"}).`);
        }
        if (autoSignIn.awaitingMfa && !awsMfaCode && !hintedForMfa) {
          console.log("AWS MFA prompt detected. Set AWS_MFA_CODE to automate this step, or complete MFA manually.");
          hintedForMfa = true;
        }
        lastAutoSigninAttemptAt = Date.now();
      }
      if (!hintedForSignin) {
        console.log("Waiting for AWS sign-in to complete in this automation window...");
        hintedForSignin = true;
      }
      await sleep(2000);
      continue;
    }

    if (state.isConsolePage) {
      if (
        consoleRegion &&
        state.consoleRegion &&
        state.consoleRegion !== consoleRegion &&
        Date.now() - lastRegionRedirectAt > 30_000
      ) {
        console.log(`Switching AWS console region from ${state.consoleRegion} to ${consoleRegion}.`);
        await activePage
          .goto(`https://${consoleRegion}.console.aws.amazon.com/connect/v2/app/instances?region=${consoleRegion}`, {
            waitUntil: "domcontentloaded",
            timeout: 45_000
          })
          .catch(() => undefined);
        lastRegionRedirectAt = Date.now();
        await sleep(1000);
        continue;
      }

      if (Date.now() - lastConsoleLaunchAttemptAt > 10_000) {
        const launchedConnect = await tryLaunchConnectFromConsole(activePage, {
          consoleRegion,
          allowEmergencyLaunch
        });
        if (launchedConnect.launched) {
          console.log(`Launched Amazon Connect from console (${launchedConnect.method}).`);
        }
        lastConsoleLaunchAttemptAt = Date.now();
      }

      if (!hintedForConsole) {
        if (autoNavigateFromConsole) {
          console.log("AWS sign-in detected. Moving from console page to CCP...");
        } else {
          console.log("AWS sign-in detected. Ready for manual console navigation to CCP.");
        }
        hintedForConsole = true;
      }

      if (!autoNavigateFromConsole) {
        if (!hintedForManualConsoleSteps) {
          console.log("Console steps:");
          console.log("1) Open Amazon Connect in console.");
          console.log("2) Open your Connect instance access URL.");
          if (ccpUrl) {
            console.log(`3) Open CCP: ${ccpUrl}`);
          } else {
            console.log("3) Open CCP from Connect top-right launcher (URL will be auto-detected).");
          }
          console.log("4) Keep the CCP tab open until capture completes.");
          hintedForManualConsoleSteps = true;
        }
        await sleep(2000);
        continue;
      }

      // Warm-up console once to ensure federation/session material is established.
      if (Date.now() - lastConsoleWarmupAt > 30_000) {
        try {
          await activePage.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
        } catch {
          // continue with current page if warm-up navigation fails
        }
        lastConsoleWarmupAt = Date.now();
      }

      if (Date.now() - lastCcpAttemptAt > 8000) {
        const linkClicked = ccpUrl ? await tryClickConsoleCcpLink(activePage) : false;
        if (!linkClicked && ccpUrl) {
          try {
            await activePage.goto(ccpUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
          } catch {
            // continue waiting for manual action
          }
        }
        lastCcpAttemptAt = Date.now();
      }
      await sleep(2000);
      continue;
    }

    if (
      state.isConnectDomain &&
      !state.isHealthy &&
      !state.isSessionExpired &&
      Date.now() - lastCcpAttemptAt > 10_000
    ) {
      if (ccpUrl) {
        try {
          await activePage.goto(ccpUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
        } catch {
          // keep waiting
        }
      }
      lastCcpAttemptAt = Date.now();
      await sleep(1200);
      continue;
    }

    if (state.isSessionExpired) {
      if (!hintedForExpiredSession) {
        console.log("Session shows expired. Complete federation/console login and return to CCP.");
        if (startUrl !== ccpUrl) {
          console.log(`If needed, complete login from: ${startUrl}`);
        }
        if (autoNavigateFromConsole && ccpUrl) {
          console.log(`If needed, open this URL in the same window: ${ccpUrl}`);
        }
        hintedForExpiredSession = true;
      }
      consecutiveHealthyChecks = 0;
      if (autoNavigateFromConsole && startUrl !== ccpUrl && Date.now() - lastStartAttemptAt > 30_000) {
        try {
          await activePage.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
        } catch {
          // keep waiting for manual auth progress
        }
        lastStartAttemptAt = Date.now();
      }
      await sleep(2000);
      continue;
    }

    if (autoNavigateFromConsole && ccpUrl && !state.isHealthy && Date.now() - lastCcpAttemptAt > 15_000) {
      try {
        await activePage.goto(ccpUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      } catch {
        // ignore and continue waiting
      }
      lastCcpAttemptAt = Date.now();
    }

    await sleep(2000);
  }

  if (consecutiveHealthyChecks < 3) {
    const activePage = getActivePage(context, page);
    if (activePage) {
      await activePage.screenshot({ path: "test-results/connect-session-timeout.png", fullPage: true });
    }
    await browser.close();
    throw new Error("Timed out waiting for Amazon Connect CCP login to complete.");
  }

  fs.mkdirSync(path.dirname(storagePath), { recursive: true });
  await context.storageState({ path: storagePath });
  const cookies = await context.cookies();
  fs.writeFileSync(".auth/connect-cookies.json", JSON.stringify(cookies, null, 2), "utf8");
  const activePage = getActivePage(context, page);
  if (!ccpUrl && activePage) {
    ccpUrl = deriveCcpUrlFromUrl(activePage.url()) || ccpUrl;
  }
  if (activePage) {
    await activePage.screenshot({ path: "test-results/connect-session-captured.png", fullPage: true });
  }
  await browser.close();

  console.log(
    JSON.stringify(
      {
        captured: true,
        storagePath,
        cookiesPath: ".auth/connect-cookies.json",
        ccpUrl: ccpUrl || null
      },
      null,
      2
    )
  );
}

function getActivePage(context, fallbackPage) {
  const openPages = context.pages().filter((tab) => !tab.isClosed());
  if (openPages.length === 0) {
    return null;
  }

  const ccpPage = openPages.find((tab) => /\/ccp-v2(?:\/|$|\?)/i.test(tab.url()));
  if (ccpPage) {
    return ccpPage;
  }

  const connectDomainPage = openPages.find((tab) => /\.my\.connect\.aws$/i.test(safeHost(tab.url())));
  if (connectDomainPage) {
    return connectDomainPage;
  }

  const fallbackOpen = !fallbackPage.isClosed() ? fallbackPage : null;
  if (fallbackOpen) {
    return fallbackOpen;
  }

  return openPages[openPages.length - 1] ?? null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCcpState(page) {
  const url = page.url();
  const host = safeHost(url);
  const path = safePath(url).toLowerCase();
  const search = safeSearch(url).toLowerCase();
  const title = (await page.title().catch(() => "")).toLowerCase();
  const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
  const isSessionExpired =
    bodyText.includes("session expired") || bodyText.includes("please log in again to continue");
  const inCcp = /\/ccp-v2(?:\/|$|\?)/i.test(url);
  const onLogin = /\/login(?:\/|$|\?)/i.test(url);
  const isAwsSignin = host === "signin.aws.amazon.com" || host.endsWith(".signin.aws.amazon.com");
  const isConsolePage = host.endsWith(".console.aws.amazon.com") || host === "console.aws.amazon.com";
  const consoleRegion = extractConsoleRegion(url, host);
  const isFeedbackPage =
    /feedback|survey/.test(path) ||
    /feedback|survey/.test(search) ||
    bodyText.includes("give feedback") ||
    bodyText.includes("how was your experience") ||
    bodyText.includes("tell us about your experience");
  const isBadRequestPage =
    title.includes("400") ||
    bodyText.includes("400 bad request") ||
    bodyText.includes("bad request") ||
    bodyText.includes("request could not be satisfied") ||
    bodyText.includes("invalid request");
  const isConnectDomain = host.endsWith(".my.connect.aws");

  return {
    url,
    host,
    path,
    consoleRegion,
    isAwsSignin,
    isConsolePage,
    isFeedbackPage,
    isBadRequestPage,
    isConnectDomain,
    isSessionExpired,
    isHealthy: inCcp && !onLogin && !isSessionExpired
  };
}

function safeHost(rawUrl) {
  try {
    return new URL(rawUrl).host;
  } catch {
    return "";
  }
}

function safePath(rawUrl) {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return "";
  }
}

function safeSearch(rawUrl) {
  try {
    return new URL(rawUrl).search;
  } catch {
    return "";
  }
}

async function tryAutoAwsSignIn(page, input) {
  const state = { submitted: false, awaitingMfa: false, action: "" };
  const body = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
  const effectiveUsername = input.username || extractAwsUserFromUrl(page.url());

  await selectIamUserModeIfPresent(page);

  // Handle MFA challenge if present.
  const mfaField = page
    .locator(
      "input[name*='mfa' i], input[id*='mfa' i], input[name*='otp' i], input[id*='otp' i], input[type='tel']"
    )
    .first();
  if ((await mfaField.count()) > 0 && (await mfaField.isVisible().catch(() => false))) {
    state.awaitingMfa = true;
    if (input.mfaCode) {
      await mfaField.fill(input.mfaCode).catch(() => undefined);
      const submit = await resolveAwsSubmitButton(page);
      if (submit) {
        await submit.click({ force: true }).catch(() => undefined);
        state.submitted = true;
        state.action = "mfa_submit";
      }
    }
    return state;
  }

  // New AWS two-step sign-in flow (resolver input + Next).
  const resolverInput = page.locator("#resolving_input, input[name='resolvingInput']").first();
  const nextButton = page.locator("#next_button").first();
  if (
    (await resolverInput.count()) > 0 &&
    (await resolverInput.isVisible().catch(() => false)) &&
    (await nextButton.count()) > 0 &&
    (await nextButton.isVisible().catch(() => false))
  ) {
    const resolverValue = await resolveAwsResolverValue(page, input);
    if (resolverValue) {
      await resolverInput.fill("").catch(() => undefined);
      await resolverInput.fill(resolverValue).catch(() => undefined);
      await nextButton.click({ force: true }).catch(() => undefined);
      state.submitted = true;
      state.action = "resolver_next";
      return state;
    }
  }

  // Username can appear as IAM username or generic email/username field.
  const effectiveAccountId = input.accountId || extractAwsAccountIdFromUrl(page.url()) || "";
  const accountField = await firstVisibleLocator(page, [
    "input#account",
    "input[name='account']",
    "input[name='accountId']"
  ]);
  if (accountField && effectiveAccountId) {
    await accountField.fill("").catch(() => undefined);
    await accountField.fill(effectiveAccountId).catch(() => undefined);
  }

  const usernameField = await firstVisibleLocator(page, [
    "input#username",
    "input#signin-username",
    "input[name='username']",
    "input[name='userName']",
    "input[type='email']",
    "input[name='email']"
  ]);
  if (usernameField) {
    await usernameField.fill("").catch(() => undefined);
    await usernameField.fill(effectiveUsername).catch(() => undefined);
  }

  const passwordField = await firstVisibleLocator(page, [
    "input#password",
    "input[name='password']",
    "input[type='password']"
  ]);
  if (passwordField) {
    await passwordField.fill("").catch(() => undefined);
    await passwordField.fill(input.password).catch(() => undefined);
  }

  const hasCredentialsFields = Boolean(usernameField || passwordField);
  const likelySigninView =
    hasCredentialsFields || /sign in|aws account|iam user|console sign-in|login/i.test(body);
  if (!likelySigninView) {
    return state;
  }

  const submit = await resolveAwsSubmitButton(page);
  if (submit) {
    const beforeUrl = page.url();
    await submit.click({ force: true }).catch(() => undefined);
    state.submitted = true;
    state.action = "credentials_submit";
    await page.waitForTimeout(500);
    if (page.url() === beforeUrl && passwordField) {
      await passwordField.press("Enter").catch(() => undefined);
      state.action = "credentials_enter";
    }
  } else if (passwordField) {
    await passwordField.press("Enter").catch(() => undefined);
    state.submitted = true;
    state.action = "credentials_enter";
  }
  return state;
}

async function resolveAwsResolverValue(page, input) {
  if (input.accountId) {
    return input.accountId;
  }
  const fromUrl = extractAwsAccountIdFromUrl(page.url());
  if (fromUrl) {
    return fromUrl;
  }
  if (input.username && !input.username.includes("@")) {
    return input.username;
  }
  const userFromUrl = extractAwsUserFromUrl(page.url());
  if (userFromUrl) {
    return userFromUrl;
  }
  return input.username;
}

function extractAwsAccountIdFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const clientId = url.searchParams.get("client_id") || "";
    const decoded = decodeURIComponent(clientId);
    const match = decoded.match(/arn:aws:iam::(\d{12}):/i);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

function extractAwsUserFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const clientId = decodeURIComponent(url.searchParams.get("client_id") || "");
    const iamMatch = clientId.match(/arn:aws:iam::\d{12}:user\/([^/?#]+)/i);
    if (iamMatch) {
      return iamMatch[1];
    }
    const consoleMatch = clientId.match(/arn:aws:signin:::+console\/([^/?#]+)/i);
    return consoleMatch ? consoleMatch[1] : "";
  } catch {
    return "";
  }
}

function extractConsoleRegion(rawUrl, host) {
  try {
    const url = new URL(rawUrl);
    const fromQuery = (url.searchParams.get("region") || "").trim();
    if (fromQuery) {
      return fromQuery;
    }
    const hostMatch = host.match(/^([a-z0-9-]+)\.console\.aws\.amazon\.com$/i);
    return hostMatch ? hostMatch[1] : "";
  } catch {
    return "";
  }
}

async function selectIamUserModeIfPresent(page) {
  const iamRadio = page.locator("#iam_user_radio_button").first();
  if ((await iamRadio.count()) === 0) {
    return;
  }
  const visible = await iamRadio.isVisible().catch(() => false);
  if (!visible) {
    return;
  }
  const checked = await iamRadio.isChecked().catch(() => false);
  if (!checked) {
    await iamRadio.check({ force: true }).catch(() => undefined);
    await page.waitForTimeout(250);
  }
}

async function resolveAwsSubmitButton(page) {
  // Prefer known AWS sign-in submit controls first.
  const prioritizedSelectors = [
    "#signin_button",
    "input#signInSubmit-input",
    "button#signInSubmit",
    "button[name='signInSubmitButton']"
  ];
  for (const selector of prioritizedSelectors) {
    const candidate = page.locator(selector).first();
    if ((await candidate.count()) === 0) {
      continue;
    }
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }
    const disabled = await candidate.isDisabled().catch(() => false);
    if (disabled) {
      continue;
    }
    return candidate;
  }

  const generic = page
    .getByRole("button", { name: /sign in|continue|next|submit|log in/i })
    .or(page.locator("input[type='submit'], button[type='submit']").first())
    .first();
  if ((await generic.count()) === 0) {
    return null;
  }
  const visible = await generic.isVisible().catch(() => false);
  if (!visible) {
    return null;
  }
  const disabled = await generic.isDisabled().catch(() => false);
  if (disabled) {
    return null;
  }
  return generic;
}

async function firstVisibleLocator(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) {
      continue;
    }
    const visible = await locator.isVisible().catch(() => false);
    if (visible) {
      return locator;
    }
  }
  return null;
}

async function tryClickConsoleCcpLink(page) {
  const strictCandidates = [
    page.locator("a[href*='.my.connect.aws/ccp-v2']").first(),
    page.locator("a[href*='connect.aws/ccp-v2']").first(),
    page.locator("a[href*='connect.aws/ccp']").first()
  ];
  for (const link of strictCandidates) {
    if ((await link.count().catch(() => 0)) === 0) {
      continue;
    }
    if (!(await link.isVisible().catch(() => false))) {
      continue;
    }
    try {
      await link.click({ force: true, timeout: 5000 });
      return true;
    } catch {
      // Try next candidate.
    }
  }
  return false;
}

async function tryLaunchConnectFromConsole(page, input) {
  const path = safePath(page.url()).toLowerCase();
  const onInstancesList = path.includes("/connect/v2/app/instances");
  const isConsolePage = safeHost(page.url()).endsWith(".console.aws.amazon.com");
  if (isConsolePage && !onInstancesList && input.consoleRegion) {
    const target = `https://${input.consoleRegion}.console.aws.amazon.com/connect/v2/app/instances?region=${input.consoleRegion}`;
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
    await page.waitForTimeout(500);
  }

  const refreshedPath = safePath(page.url()).toLowerCase();
  const nowOnInstancesList = refreshedPath.includes("/connect/v2/app/instances");
  const instanceFirstColumnLink = page
    .locator("table tbody tr:first-child td:first-child a, table tbody tr:first-child a:first-of-type")
    .first();
  if (nowOnInstancesList) {
    if (
      (await instanceFirstColumnLink.count().catch(() => 0)) > 0 &&
      (await instanceFirstColumnLink.isVisible().catch(() => false))
    ) {
      await instanceFirstColumnLink.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(700);
      return { launched: true, method: "first-column-instance-link" };
    }
    return { launched: false, method: "instances-list-no-first-column-link" };
  }

  if (!input.allowEmergencyLaunch) {
    return { launched: false, method: "emergency-disabled" };
  }

  const emergency = page
    .getByRole("link", { name: /emergency login|emergency access/i })
    .or(page.getByRole("button", { name: /emergency login|emergency access/i }))
    .first();
  if ((await emergency.count().catch(() => 0)) > 0 && (await emergency.isVisible().catch(() => false))) {
    await emergency.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(500);
    return { launched: true, method: "emergency-login" };
  }

  return { launched: false, method: "no-launch-control" };
}

async function dismissInterruptingDialog(page) {
  const dialog = page.locator("[role='dialog'], [aria-modal='true'], .modal, .awsui-modal-container").first();
  if ((await dialog.count().catch(() => 0)) > 0 && (await dialog.isVisible().catch(() => false))) {
    const dismiss = dialog
      .getByRole("button", { name: /close|dismiss|no thanks|not now|skip|cancel|done|ok/i })
      .or(dialog.locator("button[aria-label*='close' i], button[title*='close' i]").first())
      .first();
    if ((await dismiss.count().catch(() => 0)) > 0 && (await dismiss.isVisible().catch(() => false))) {
      await dismiss.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(300);
      return true;
    }
  }

  const pageDismiss = page
    .getByRole("button", { name: /close|dismiss|no thanks|not now|skip|cancel/i })
    .first();
  if ((await pageDismiss.count().catch(() => 0)) > 0 && (await pageDismiss.isVisible().catch(() => false))) {
    await pageDismiss.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(300);
    return true;
  }

  return false;
}

async function recoverFromFeedbackPage(page, input) {
  const submittedFeedback = await trySubmitFeedbackForm(page).catch(() => false);
  if (submittedFeedback) {
    await page.waitForTimeout(500);
    return true;
  }

  const dismissed = await dismissInterruptingDialog(page).catch(() => false);
  if (dismissed) {
    return true;
  }
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(250);

  const url = page.url().toLowerCase();
  if (url.includes("feedback") || url.includes("survey")) {
    if (input.ccpUrl) {
      await page.goto(input.ccpUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
      return true;
    }
    await page.goto(input.startUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
    return true;
  }

  if (input.startUrl !== input.ccpUrl) {
    await page.goto(input.startUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
    return true;
  }
  return false;
}

async function recoverFromBadRequestPage(page, input) {
  await page.context().clearCookies().catch(() => undefined);
  await page.goto(withCacheBuster(input.startUrl), {
    waitUntil: "domcontentloaded",
    timeout: 45_000
  }).catch(() => undefined);
  return true;
}

function resolvePreferredStartUrl(startUrl, consoleRegion) {
  const fallback = startUrl;
  if (!consoleRegion) {
    return fallback;
  }
  try {
    const url = new URL(startUrl);
    const host = url.host.toLowerCase();
    const path = url.pathname.toLowerCase();
    const isConnectConsole =
      (host === "console.aws.amazon.com" || host.endsWith(".console.aws.amazon.com")) &&
      path.startsWith("/connect");
    const isAwsSignin = host === "signin.aws.amazon.com" || host.endsWith(".signin.aws.amazon.com");
    if (!isConnectConsole && !isAwsSignin) {
      return fallback;
    }
    return `https://${consoleRegion}.console.aws.amazon.com/connect/v2/app/instances?region=${consoleRegion}`;
  } catch {
    return fallback;
  }
}

function withCacheBuster(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.searchParams.set("vta_ts", String(Date.now()));
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function deriveCcpUrlFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!url.host.endsWith(".my.connect.aws")) {
      return "";
    }
    return `https://${url.host}/ccp-v2/`;
  } catch {
    return "";
  }
}

async function trySubmitFeedbackForm(page) {
  let changedAny = false;

  const selects = page.locator("select");
  const selectCount = await selects.count().catch(() => 0);
  for (let i = 0; i < selectCount; i += 1) {
    const select = selects.nth(i);
    const visible = await select.isVisible().catch(() => false);
    const disabled = await select.isDisabled().catch(() => true);
    if (!visible || disabled) {
      continue;
    }

    const options = await select
      .locator("option")
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          value: node.getAttribute("value") ?? "",
          disabled: Boolean((node).disabled)
        }))
      )
      .catch(() => []);
    const candidates = options.filter((option) => option.value && !option.disabled);
    if (candidates.length === 0) {
      continue;
    }

    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    await select.selectOption(pick.value).catch(() => undefined);
    changedAny = true;
  }

  const submit = page
    .getByRole("button", { name: /submit|send|done|finish|save/i })
    .or(page.locator("input[type='submit'], button[type='submit']").first())
    .first();
  if ((await submit.count().catch(() => 0)) > 0 && (await submit.isVisible().catch(() => false))) {
    const disabled = await submit.isDisabled().catch(() => false);
    if (!disabled) {
      await submit.click({ force: true }).catch(() => undefined);
      return true;
    }
  }

  return changedAny;
}

function must(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

void main();
