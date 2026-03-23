#!/usr/bin/env node

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const viewport = { width: 1440, height: 1080 };
const settleDelayMs = 1_000;
const navigationTimeoutMs = 60_000;
const locatorTimeoutMs = 30_000;
const debugDir = path.join(repoRoot, 'output', 'playwright');

const targets = [
  {
    id: 'openlinks',
    url: 'https://openlinks.us/',
    outputPath: path.join(repoRoot, 'assets', 'screenshots', 'openlinks.png'),
    readyChecks: [
      (page) => page.getByRole('heading', { level: 1, name: 'Peter Ryszkiewicz' }).first(),
      (page) => page.getByText("Peter's OpenLinks", { exact: true }).first(),
    ],
  },
  {
    id: 'free-the-world',
    url: 'https://freetheworld.ai/companies',
    outputPath: path.join(repoRoot, 'assets', 'screenshots', 'free-the-world.png'),
    readyChecks: [
      (page) => page.getByRole('heading', { level: 2, name: 'Company Registry' }).first(),
      (page) => page.getByText('Search companies', { exact: true }).first(),
    ],
  },
  {
    id: 'win3bitcoin',
    url: 'https://win3bitco.in/',
    outputPath: path.join(repoRoot, 'assets', 'screenshots', 'win3bitcoin.png'),
    readyChecks: [
      (page) => page.getByRole('heading', { level: 1, name: 'Win3Bitco.in' }).first(),
      (page) => page.getByRole('heading', { level: 2, name: 'Mining Controls' }).first(),
      (page) => page.getByText('Configure your mining settings', { exact: true }).first(),
    ],
    beforeScreenshot: async (page) => {
      const sidebarIsCollapsed = await page.evaluate(() => {
        const maybeButton = Array.from(document.querySelectorAll('button')).find(
          (element) => element.textContent?.trim() === 'Clear Data',
        );

        return maybeButton ? maybeButton.getBoundingClientRect().left < 0 : false;
      });

      if (!sidebarIsCollapsed) {
        return;
      }

      await page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click();
      await page.waitForFunction(() => {
        const maybeButton = Array.from(document.querySelectorAll('button')).find(
          (element) => element.textContent?.trim() === 'Clear Data',
        );

        return maybeButton ? maybeButton.getBoundingClientRect().left >= 0 : false;
      });
    },
  },
];

function parseArgs(argv) {
  let maybeOnly = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--') {
      continue;
    }

    if (arg === '--only') {
      maybeOnly = argv[index + 1];
      if (!maybeOnly || maybeOnly === '--') {
        throw new Error('Missing value for --only');
      }
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!maybeOnly) {
    return targets;
  }

  const maybeTarget = targets.find((target) => target.id === maybeOnly);
  if (!maybeTarget) {
    const knownTargets = targets.map((target) => target.id).join(', ');
    throw new Error(`Unknown screenshot target "${maybeOnly}". Available targets: ${knownTargets}`);
  }

  return [maybeTarget];
}

async function disableMotion(page) {
  await page.addStyleTag({
    content: `
      *,
      *::before,
      *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        scroll-behavior: auto !important;
      }
    `,
  });
}

async function waitForFonts(page) {
  await page.evaluate(async () => {
    if (document.fonts?.ready) {
      await document.fonts.ready;
    }
  });
}

async function captureDebugArtifacts(page, target, error) {
  const targetDebugDir = path.join(debugDir, target.id);
  await mkdir(targetDebugDir, { recursive: true });

  const screenshotPath = path.join(targetDebugDir, `${target.id}.png`);
  const htmlPath = path.join(targetDebugDir, `${target.id}.html`);
  const metadataPath = path.join(targetDebugDir, `${target.id}.json`);

  try {
    await page.screenshot({
      path: screenshotPath,
      fullPage: true,
      animations: 'disabled',
    });
  } catch {
    // Keep the original failure as the primary signal.
  }

  try {
    await writeFile(htmlPath, await page.content(), 'utf8');
  } catch {
    // Keep the original failure as the primary signal.
  }

  const metadata = {
    id: target.id,
    url: page.url(),
    title: await page.title().catch(() => null),
    error: error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) },
  };

  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

async function captureTarget(browser, target) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();

  page.setDefaultNavigationTimeout(navigationTimeoutMs);
  page.setDefaultTimeout(locatorTimeoutMs);

  try {
    console.log(`Refreshing ${target.id} from ${target.url}`);

    await page.goto(target.url, {
      waitUntil: 'domcontentloaded',
      timeout: navigationTimeoutMs,
    });

    await disableMotion(page);
    await waitForFonts(page);

    for (const readyCheck of target.readyChecks) {
      await readyCheck(page).waitFor({ state: 'visible', timeout: locatorTimeoutMs });
    }

    if (target.beforeScreenshot) {
      await target.beforeScreenshot(page);
    }

    await page.waitForTimeout(settleDelayMs);
    await mkdir(path.dirname(target.outputPath), { recursive: true });
    await page.screenshot({
      path: target.outputPath,
      animations: 'disabled',
    });
  } catch (error) {
    await captureDebugArtifacts(page, target, error);
    throw error;
  } finally {
    await context.close();
  }
}

async function main() {
  const selectedTargets = parseArgs(process.argv.slice(2));

  await rm(debugDir, { recursive: true, force: true });

  const browser = await chromium.launch({ headless: true });

  try {
    for (const target of selectedTargets) {
      await captureTarget(browser, target);
    }
  } finally {
    await browser.close();
  }

  console.log(`Refreshed ${selectedTargets.length} screenshot target(s).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
