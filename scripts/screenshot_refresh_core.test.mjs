import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  parseArgs,
  promoteCaptures,
  runCaptureBatch,
  ScreenshotBatchError,
  validateScreenshot,
} from './screenshot_refresh_core.mjs';

const viewport = { width: 1440, height: 1080 };
const quietLogger = { error() {} };

test('parseArgs selects one known screenshot target', () => {
  // Arrange
  const targets = [{ id: 'first' }, { id: 'second' }];

  // Act
  const selectedTargets = parseArgs(['--only', 'second'], targets);

  // Assert
  assert.deepEqual(selectedTargets, [targets[1]]);
});

test('parseArgs rejects an unknown screenshot target', () => {
  // Arrange
  const targets = [{ id: 'known' }];

  // Act and Assert
  assert.throws(
    () => parseArgs(['--only', 'unknown'], targets),
    /Unknown screenshot target "unknown". Available targets: known/,
  );
});

test('parseArgs rejects a missing --only value', () => {
  // Arrange
  const targets = [{ id: 'known' }];

  // Act and Assert
  assert.throws(() => parseArgs(['--only'], targets), /Missing value for --only/);
});

test('validateScreenshot accepts a PNG with the expected viewport', async (t) => {
  // Arrange
  const temporaryDir = await createTemporaryDir(t);
  const screenshotPath = path.join(temporaryDir, 'screenshot.png');
  await writeFile(screenshotPath, createPngHeader(viewport));

  // Act
  const validation = await validateScreenshot(screenshotPath, viewport);

  // Assert
  assert.deepEqual(validation, { ...viewport, bytes: 24 });
});

test('validateScreenshot rejects unexpected image dimensions', async (t) => {
  // Arrange
  const temporaryDir = await createTemporaryDir(t);
  const screenshotPath = path.join(temporaryDir, 'screenshot.png');
  await writeFile(screenshotPath, createPngHeader({ width: 800, height: 600 }));

  // Act and Assert
  await assert.rejects(
    validateScreenshot(screenshotPath, viewport),
    /Screenshot has 800x600 pixels; expected 1440x1080/,
  );
});

test('runCaptureBatch retries a transient target failure', async () => {
  // Arrange
  const targets = [{ id: 'transient' }];
  const attempts = [];
  const retryDelays = [];

  // Act
  const captures = await runCaptureBatch({
    targets,
    expectedViewport: viewport,
    logger: quietLogger,
    captureTarget: async (target, attempt) => {
      attempts.push(attempt);
      if (attempt === 1) {
        throw new Error('temporary failure');
      }
      return { id: target.id };
    },
    sleep: async (milliseconds) => {
      retryDelays.push(milliseconds);
    },
    promote: async () => {},
  });

  // Assert
  assert.deepEqual(attempts, [1, 2]);
  assert.deepEqual(retryDelays, [2_000]);
  assert.deepEqual(captures, [{ id: 'transient' }]);
});

test('runCaptureBatch reports every target that exhausts its retries', async () => {
  // Arrange
  const targets = [{ id: 'first' }, { id: 'second' }];
  const attemptsByTarget = new Map();

  // Act
  const batchError = await captureRejection(
    runCaptureBatch({
      targets,
      expectedViewport: viewport,
      logger: quietLogger,
      captureTarget: async (target) => {
        attemptsByTarget.set(target.id, (attemptsByTarget.get(target.id) ?? 0) + 1);
        throw new Error(`${target.id} unavailable`);
      },
      sleep: async () => {},
      promote: async () => {
        throw new Error('Promotion must not run');
      },
    }),
  );

  // Assert
  assert.ok(batchError instanceof ScreenshotBatchError);
  assert.deepEqual(
    batchError.failures.map(({ target }) => target.id),
    ['first', 'second'],
  );
  assert.deepEqual(Object.fromEntries(attemptsByTarget), { first: 3, second: 3 });
});

test('runCaptureBatch leaves existing outputs unchanged when one target fails', async (t) => {
  // Arrange
  const temporaryDir = await createTemporaryDir(t);
  const outputPath = path.join(temporaryDir, 'existing.png');
  const diagnosticPath = path.join(temporaryDir, 'diagnostic.json');
  await writeFile(outputPath, 'original screenshot');
  const targets = [{ id: 'success' }, { id: 'failure' }];

  // Act
  await assert.rejects(
    runCaptureBatch({
      targets,
      expectedViewport: viewport,
      logger: quietLogger,
      captureTarget: async (target) => {
        if (target.id === 'failure') {
          await writeFile(diagnosticPath, '{"error":"site unavailable"}\n');
          throw new Error('site unavailable');
        }
        return { id: target.id, outputPath };
      },
      sleep: async () => {},
      promote: async () => {
        await writeFile(outputPath, 'replacement screenshot');
      },
    }),
    ScreenshotBatchError,
  );

  // Assert
  assert.equal(await readFile(outputPath, 'utf8'), 'original screenshot');
  await access(diagnosticPath);
});

test('promoteCaptures validates every staged image before replacing outputs', async (t) => {
  // Arrange
  const temporaryDir = await createTemporaryDir(t);
  const outputPath = path.join(temporaryDir, 'output.png');
  const validStagedPath = path.join(temporaryDir, 'valid.png');
  const missingStagedPath = path.join(temporaryDir, 'missing.png');
  await writeFile(outputPath, 'original screenshot');
  await writeFile(validStagedPath, createPngHeader(viewport));

  // Act
  await assert.rejects(
    promoteCaptures(
      [
        { stagedPath: validStagedPath, outputPath },
        { stagedPath: missingStagedPath, outputPath: path.join(temporaryDir, 'other.png') },
      ],
      viewport,
    ),
    /ENOENT/,
  );

  // Assert
  assert.equal(await readFile(outputPath, 'utf8'), 'original screenshot');
});

async function captureRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  assert.fail('Expected promise to reject');
}

async function createTemporaryDir(t) {
  const temporaryDir = await mkdtemp(path.join(os.tmpdir(), 'screenshot-refresh-test-'));
  t.after(async () => {
    await rm(temporaryDir, { recursive: true, force: true });
  });
  return temporaryDir;
}

function createPngHeader({ width, height }) {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}
