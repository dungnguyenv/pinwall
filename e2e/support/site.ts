import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** An 8x8 PNG of one color, small enough to live in the source. */
const COVER_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGPwDnuMFTEMLQkAwPNhAepbaaoAAAAASUVORK5CYII=';

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>E2E Site</title>
    <meta property="og:image" content="img/cover.png" />
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <h1>E2E Site</h1>
    <p>A small site that the end-to-end walk uploads as a folder.</p>
  </body>
</html>
`;

const STYLE_CSS = `body {
  font-family: system-ui, sans-serif;
  margin: 2rem;
}
`;

/** Writes a small static site into `dir`: a page, a stylesheet and a cover image. */
export async function makeSite(dir: string): Promise<void> {
  await mkdir(join(dir, 'img'), { recursive: true });
  await writeFile(join(dir, 'index.html'), INDEX_HTML);
  await writeFile(join(dir, 'style.css'), STYLE_CSS);
  await writeFile(join(dir, 'img', 'cover.png'), Buffer.from(COVER_PNG_BASE64, 'base64'));
}
