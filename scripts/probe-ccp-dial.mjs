import { chromium } from "playwright";

async function main() {
  const ccpUrl = must("CONNECT_CCP_URL");
  const to = must("CONNECT_ENTRYPOINT_NUMBER");
  const storageState = process.env.CONNECT_STORAGE_STATE || ".auth/connect-ccp.json";
  const screenshotPath = process.env.CCP_PROBE_SCREENSHOT || "test-results/personal-ccp-dial.png";

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState,
    permissions: ["microphone", "camera"]
  });
  const page = await context.newPage();

  await page.goto(ccpUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  await clickFirst(page, [
    page.getByRole("tab", { name: /^phone$/i }).first(),
    page.getByRole("button", { name: /^phone$/i }).first()
  ]);
  await clickFirst(page, [page.getByRole("button", { name: /number pad/i }).first()]);

  await fillPhoneNumber(page, to);
  const callClicked = await clickFirst(page, [
    page.getByRole("button", { name: /^call$|place call|dial/i }).first(),
    page.locator("button").filter({ hasText: /^Call$/i }).first()
  ]);

  const started = await waitForDialSignal(page, Number(process.env.CONNECT_DIAL_TIMEOUT_MS || "25000"));
  await page.screenshot({ path: screenshotPath, fullPage: true });

  console.log(
    JSON.stringify(
      {
        dialAttempted: true,
        callClicked,
        started,
        ccpUrl,
        to,
        screenshotPath
      },
      null,
      2
    )
  );

  await browser.close();
  if (!started) {
    process.exit(2);
  }
}

async function fillPhoneNumber(page, number) {
  const normalized = number.replace(/\s+/g, "");
  const inputs = [
    page.getByRole("textbox", { name: /phone number|enter number|number/i }).first(),
    page.locator("input[aria-label*='Phone' i], input[placeholder*='Phone' i], input[name*='phone' i]").first(),
    page.locator("input[type='tel']").first()
  ];

  for (const input of inputs) {
    if ((await input.count()) === 0) {
      continue;
    }
    if (!(await input.isVisible().catch(() => false))) {
      continue;
    }
    await input.fill(normalized).catch(() => undefined);
    const value = await input.inputValue().catch(() => "");
    if (digits(value).includes(digits(normalized))) {
      return;
    }
  }

  for (const char of digits(normalized)) {
    const key = page.getByRole("button", { name: new RegExp(`^${char}$`) }).first();
    if ((await key.count()) > 0 && (await key.isVisible().catch(() => false))) {
      await key.click({ force: true }).catch(() => undefined);
    }
  }
}

async function waitForDialSignal(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = await page.locator("body").innerText().catch(() => "");
    const body = raw.toLowerCase();
    if (
      /invalid outbound configuration|must associate a phone number with this queue|before you can place an outbound call/i.test(
        raw
      )
    ) {
      throw new Error(
        "Connect CCP outbound dial is blocked: queue/routing profile is missing an associated outbound phone number."
      );
    }
    if (/calling|connecting|in call|call in progress|after call work/.test(body)) {
      return true;
    }
    await page.waitForTimeout(700);
  }
  return false;
}

async function clickFirst(page, locators) {
  for (const locator of locators) {
    if ((await locator.count()) === 0) {
      continue;
    }
    if (!(await locator.isVisible().catch(() => false))) {
      continue;
    }
    await locator.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(250);
    return true;
  }
  return false;
}

function digits(value) {
  return String(value || "").replace(/\D/g, "");
}

function must(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

void main();
