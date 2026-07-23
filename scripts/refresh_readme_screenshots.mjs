#!/usr/bin/env node

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import {
  normalizeError,
  parseArgs,
  runCaptureBatch,
  ScreenshotBatchError,
  validateScreenshot,
} from './screenshot_refresh_core.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const viewport = { width: 1440, height: 1080 };
const maxCaptureAttempts = 3;
const settleDelayMs = 1_000;
const navigationTimeoutMs = 60_000;
const locatorTimeoutMs = 30_000;
const artifactsDir = path.join(repoRoot, 'output', 'playwright');
const debugDir = path.join(artifactsDir, 'debug');
const generatedDir = path.join(artifactsDir, 'generated');
const summaryPath = path.join(artifactsDir, 'summary.json');

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

async function captureDebugArtifacts({ page, target, attempt, startedAt, responseStatus, error }) {
  const targetDebugDir = path.join(debugDir, target.id, `attempt-${attempt}`);
  await mkdir(targetDebugDir, { recursive: true });

  const screenshotPath = path.join(targetDebugDir, 'page.png');
  const htmlPath = path.join(targetDebugDir, 'page.html');
  const metadataPath = path.join(targetDebugDir, 'metadata.json');

  try {
    await page.screenshot({
      path: screenshotPath,
      fullPage: true,
      animations: 'disabled',
    });
  } catch (artifactError) {
    console.warn(`Could not capture debug screenshot for ${target.id}: ${normalizeError(artifactError).message}`);
  }

  try {
    await writeFile(htmlPath, await page.content(), 'utf8');
  } catch (artifactError) {
    console.warn(`Could not capture debug HTML for ${target.id}: ${normalizeError(artifactError).message}`);
  }

  let maybeTitle = null;

  try {
    maybeTitle = await page.title();
  } catch (artifactError) {
    console.warn(`Could not read page title for ${target.id}: ${normalizeError(artifactError).message}`);
  }

  const normalizedError = normalizeError(error);
  const metadata = {
    id: target.id,
    attempt,
    sourceUrl: target.url,
    url: page.url(),
    title: maybeTitle,
    responseStatus,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - Date.parse(startedAt),
    error: { message: normalizedError.message, stack: normalizedError.stack },
  };

  try {
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  } catch (artifactError) {
    console.warn(`Could not write debug metadata for ${target.id}: ${normalizeError(artifactError).message}`);
  }
}

async function captureTarget(browser, target, attempt) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const startedAt = new Date().toISOString();
  const stagedPath = path.join(generatedDir, `${target.id}.png`);
  let maybeResponseStatus = null;

  page.setDefaultNavigationTimeout(navigationTimeoutMs);
  page.setDefaultTimeout(locatorTimeoutMs);

  try {
    console.log(`Refreshing ${target.id} from ${target.url} (attempt ${attempt}/${maxCaptureAttempts})`);

    const maybeResponse = await page.goto(target.url, {
      waitUntil: 'domcontentloaded',
      timeout: navigationTimeoutMs,
    });
    maybeResponseStatus = maybeResponse?.status() ?? null;

    if (!maybeResponse) {
      throw new Error(`Navigation did not return an HTTP response for ${target.url}`);
    }

    if (!maybeResponse.ok()) {
      throw new Error(`Navigation returned HTTP ${maybeResponse.status()} for ${target.url}`);
    }

    await disableMotion(page);
    await waitForFonts(page);

    for (const readyCheck of target.readyChecks) {
      await readyCheck(page).waitFor({ state: 'visible', timeout: locatorTimeoutMs });
    }

    if (target.beforeScreenshot) {
      await target.beforeScreenshot(page);
    }

    await page.waitForTimeout(settleDelayMs);
    await mkdir(generatedDir, { recursive: true });
    await page.screenshot({
      path: stagedPath,
      animations: 'disabled',
    });

    const validation = await validateScreenshot(stagedPath, viewport);
    return {
      id: target.id,
      stagedPath,
      outputPath: target.outputPath,
      attempt,
      responseStatus: maybeResponseStatus,
      durationMs: Date.now() - Date.parse(startedAt),
      validation,
    };
  } catch (error) {
    try {
      await captureDebugArtifacts({
        page,
        target,
        attempt,
        startedAt,
        responseStatus: maybeResponseStatus,
        error,
      });
    } catch (artifactError) {
      console.warn(`Could not capture debug artifacts for ${target.id}: ${normalizeError(artifactError).message}`);
    }
    throw error;
  } finally {
    try {
      await context.close();
    } catch (closeError) {
      console.warn(`Could not close browser context for ${target.id}: ${normalizeError(closeError).message}`);
    }
  }
}

async function writeSummary(summary) {
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}

async function main() {
  const selectedTargets = parseArgs(process.argv.slice(2), targets);

  await rm(artifactsDir, { recursive: true, force: true });

  const browser = await chromium.launch({ headless: true });

  try {
    const captures = await runCaptureBatch({
      targets: selectedTargets,
      expectedViewport: viewport,
      maxAttempts: maxCaptureAttempts,
      captureTarget: (target, attempt) => captureTarget(browser, target, attempt),
    });

    try {
      await writeSummary({
        status: 'success',
        finishedAt: new Date().toISOString(),
        captures,
      });
    } catch (summaryError) {
      console.warn(`Could not write success summary: ${normalizeError(summaryError).message}`);
    }

    console.log(`Refreshed ${captures.length} screenshot target(s).`);
  } catch (error) {
    const normalizedError = normalizeError(error);
    const failures =
      error instanceof ScreenshotBatchError
        ? error.failures.map(({ target, error: failureError, attempts }) => ({
            id: target.id,
            attempts,
            error: normalizeError(failureError).message,
          }))
        : [];

    try {
      await writeSummary({
        status: 'failure',
        finishedAt: new Date().toISOString(),
        error: normalizedError.message,
        failures,
      });
    } catch (summaryError) {
      console.warn(`Could not write failure summary: ${normalizeError(summaryError).message}`);
    }

    throw error;
  } finally {
    try {
      await browser.close();
    } catch (closeError) {
      console.warn(`Could not close browser: ${normalizeError(closeError).message}`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    const normalizedError = normalizeError(error);
    console.error(normalizedError.stack ?? normalizedError.message);
    process.exitCode = 1;
  });
}
