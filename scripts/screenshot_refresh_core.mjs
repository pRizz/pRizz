import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class ScreenshotBatchError extends Error {
  constructor(failures) {
    const summary = failures
      .map(({ target, error }) => `${target.id}: ${normalizeError(error).message}`)
      .join('; ');

    super(`Failed to refresh ${failures.length} screenshot target(s): ${summary}`);
    this.name = 'ScreenshotBatchError';
    this.failures = failures;
  }
}

export function normalizeError(error) {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

export function parseArgs(argv, targets) {
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

export async function validateScreenshot(filePath, expectedViewport) {
  const contents = await readFile(filePath);

  if (contents.length < 24 || !contents.subarray(0, pngSignature.length).equals(pngSignature)) {
    throw new Error(`Screenshot is not a valid PNG: ${filePath}`);
  }

  if (contents.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error(`Screenshot is missing a PNG IHDR header: ${filePath}`);
  }

  const width = contents.readUInt32BE(16);
  const height = contents.readUInt32BE(20);

  if (width !== expectedViewport.width || height !== expectedViewport.height) {
    throw new Error(
      `Screenshot has ${width}x${height} pixels; expected ${expectedViewport.width}x${expectedViewport.height}: ${filePath}`,
    );
  }

  return { width, height, bytes: contents.length };
}

export async function promoteCaptures(captures, expectedViewport) {
  for (const capture of captures) {
    await validateScreenshot(capture.stagedPath, expectedViewport);
  }

  for (const capture of captures) {
    await mkdir(path.dirname(capture.outputPath), { recursive: true });
    await copyFile(capture.stagedPath, capture.outputPath);
  }
}

export async function runCaptureBatch({
  targets,
  captureTarget,
  expectedViewport,
  maxAttempts = 3,
  retryDelaysMs = [2_000, 5_000],
  sleep = delay,
  promote = promoteCaptures,
  logger = console,
}) {
  const captures = [];
  const failures = [];

  for (const target of targets) {
    let maybeCapture = null;
    let maybeLastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        maybeCapture = await captureTarget(target, attempt);
        break;
      } catch (error) {
        maybeLastError = normalizeError(error);
        logger.error(`Attempt ${attempt}/${maxAttempts} failed for ${target.id}: ${maybeLastError.message}`);

        if (attempt < maxAttempts) {
          const delayIndex = Math.min(attempt - 1, retryDelaysMs.length - 1);
          const retryDelayMs = retryDelaysMs[delayIndex] ?? 0;
          await sleep(retryDelayMs);
        }
      }
    }

    if (maybeCapture) {
      captures.push(maybeCapture);
      continue;
    }

    failures.push({
      target,
      error: maybeLastError ?? new Error('Capture failed without an error'),
      attempts: maxAttempts,
    });
  }

  if (failures.length > 0) {
    throw new ScreenshotBatchError(failures);
  }

  await promote(captures, expectedViewport);
  return captures;
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
