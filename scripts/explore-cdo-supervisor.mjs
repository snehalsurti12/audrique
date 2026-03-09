#!/usr/bin/env node
/**
 * Open CDO org → Command Center for Service → Agentforce tab
 */
import { chromium } from "playwright";
import fs from "fs";

const storageState = JSON.parse(fs.readFileSync(".auth/sf-cdo-org.json", "utf8"));
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ storageState });
const page = await context.newPage();

const baseUrl = "https://cl1772719470642.lightning.force.com";
fs.mkdirSync("screenshots", { recursive: true });

// Go to home
await page.goto(`${baseUrl}/lightning/page/home`, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(3000);

// Open App Launcher and search for Command Center
console.log("Opening app launcher...");
await page.locator("div.appLauncher button").first().click({ timeout: 5000 });
await page.waitForTimeout(1500);

const searchInput = page.locator("input[placeholder='Search apps and items...']").first();
await searchInput.fill("Command Center");
await page.waitForTimeout(2500);

const result = page.locator("one-app-launcher-menu-item a, a[data-label]").filter({ hasText: "Command Center" }).first();
await result.click({ timeout: 5000 });
await page.waitForTimeout(6000);
console.log("Command Center loaded:", await page.title());

// Screenshot the Wallboard (default tab)
await page.screenshot({ path: "screenshots/cdo-cc-wallboard.png", fullPage: false });

// Now click the Agentforce tab
console.log("Clicking Agentforce tab...");
const agentforceTab = page.locator("a:has-text('Agentforce'), li:has-text('Agentforce') a, [title='Agentforce']").first();
const afVisible = await agentforceTab.isVisible({ timeout: 5000 }).catch(() => false);
console.log("Agentforce tab visible:", afVisible);

if (afVisible) {
  await agentforceTab.click();
  await page.waitForTimeout(5000);
  console.log("Agentforce tab URL:", page.url());
  await page.screenshot({ path: "screenshots/cdo-cc-agentforce.png", fullPage: false });

  // Get the content of the Agentforce tab
  const bodyText = await page.locator("body").innerText();
  const relevantLines = bodyText.split("\n")
    .filter(l => l.trim())
    .filter(l => /agent|conversation|session|active|queue|topic/i.test(l))
    .slice(0, 20);
  console.log("\nRelevant content on Agentforce tab:");
  relevantLines.forEach(l => console.log("  ", l.trim()));

  // Scroll down and take another screenshot
  await page.evaluate(() => window.scrollBy(0, 500));
  await page.waitForTimeout(2000);
  await page.screenshot({ path: "screenshots/cdo-cc-agentforce-scrolled.png", fullPage: false });
} else {
  console.log("Agentforce tab not found with initial selector, trying broader match...");
  // Try clicking the tab text directly
  await page.locator("text=Agentforce").first().click({ timeout: 5000 }).catch(e => console.log("Click failed:", e.message));
  await page.waitForTimeout(5000);
  await page.screenshot({ path: "screenshots/cdo-cc-agentforce.png", fullPage: false });
}

console.log("\nBrowser open for 120 seconds...");
await page.waitForTimeout(120000);
await browser.close();
