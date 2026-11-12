import type { Browser } from '@playwright/test';

/** The clip's size in pixels and length in milliseconds. */
const SIZE = 64;
const LENGTH_MS = 1000;

/**
 * A one-second 64×64 WebM (VP8) made on the spot: Chromium records a canvas animation with
 * `MediaRecorder`, so the suite needs no binary fixture in the repository.
 */
export async function makeWebm(browser: Browser): Promise<Buffer> {
  const page = await browser.newPage();
  try {
    const base64 = await page.evaluate(
      async ({ size, lengthMs }) => {
        const mimeType = 'video/webm;codecs=vp8';
        if (!MediaRecorder.isTypeSupported(mimeType)) throw new Error(`${mimeType} unsupported`);
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        document.body.append(canvas);
        const ctx = canvas.getContext('2d');
        if (ctx === null) throw new Error('No 2D canvas');
        let frame = 0;
        const draw = () => {
          ctx.fillStyle = `hsl(${(frame * 15) % 360} 70% 50%)`;
          ctx.fillRect(0, 0, size, size);
          ctx.fillStyle = '#fff';
          ctx.fillRect((frame * 2) % size, size / 2 - 4, 8, 8);
          frame += 1;
        };
        draw();

        const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType });
        const chunks: Blob[] = [];
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunks.push(event.data);
        };
        const stopped = new Promise<void>((resolve) => {
          recorder.onstop = () => resolve();
        });
        recorder.start();
        const timer = setInterval(draw, 1000 / 30);
        await new Promise((resolve) => setTimeout(resolve, lengthMs));
        clearInterval(timer);
        recorder.stop();
        await stopped;

        const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary);
      },
      { size: SIZE, lengthMs: LENGTH_MS },
    );
    const webm = Buffer.from(base64, 'base64');
    if (webm.length === 0) throw new Error('MediaRecorder produced no video');
    return webm;
  } finally {
    await page.close();
  }
}
