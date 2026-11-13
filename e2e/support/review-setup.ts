import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { chromium } from '@playwright/test';
import { buildAnnotator } from './annotator.ts';
import { makeWebm } from './make-video.ts';
import { startPinwall, stopPinwall } from './pinwall-server.ts';
import { REVIEW_SERVERS, serverEnvNames } from './review-servers.ts';

/** The temporary directory holding the fixture video; its name says the suite made it. */
const VIDEO_DIR_PREFIX = 'pinwall-e2e-video-';

/**
 * Builds the annotator the review grants inject, starts one server per isolation mode, and
 * records a video for the fidelity fixture. The workers start after this and inherit what it
 * puts in `process.env`: each server's origin and setup link, and the video's path.
 */
export default async function reviewSetup(): Promise<void> {
  try {
    buildAnnotator();
    // Settled, not raced: when one fails, the other has finished starting and gets stopped.
    const results = await Promise.allSettled(
      REVIEW_SERVERS.map((server) =>
        startPinwall({ port: server.port, publicOrigin: server.origin, env: server.env }),
      ),
    );
    for (const [i, server] of REVIEW_SERVERS.entries()) {
      const result = results[i];
      if (result?.status !== 'fulfilled') throw result?.reason;
      const names = serverEnvNames(server);
      process.env[names.origin] = result.value.origin;
      process.env[names.setupUrl] = result.value.setupUrl;
    }
    process.env.PINWALL_E2E_VIDEO = await writeVideo();
  } catch (error) {
    await cleanUpReviewRun();
    throw error;
  }
}

/** Records the clip in a throwaway Chromium and writes it to a new temporary directory. */
async function writeVideo(): Promise<string> {
  const browser = await chromium.launch();
  try {
    const webm = await makeWebm(browser);
    const dir = await mkdtemp(join(tmpdir(), VIDEO_DIR_PREFIX));
    const path = join(dir, 'clip.webm');
    await writeFile(path, webm);
    return path;
  } finally {
    await browser.close();
  }
}

/**
 * Stops both servers, removing their data directories, and removes the video's directory. Safe
 * to call twice, and after a setup that failed half-way.
 */
export async function cleanUpReviewRun(): Promise<void> {
  await stopPinwall();
  const video = process.env.PINWALL_E2E_VIDEO;
  if (video !== undefined) {
    const dir = dirname(video);
    // Only ever the directory this setup made.
    if (dirname(dir) === tmpdir() && basename(dir).startsWith(VIDEO_DIR_PREFIX)) {
      await rm(dir, { recursive: true, force: true });
    }
    delete process.env.PINWALL_E2E_VIDEO;
  }
}
