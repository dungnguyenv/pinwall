/*
 * The acceptance-5 fixture: a small site that uses what a review frame could break. An entry
 * page with a script, an in-page anchor and a relative link, two levels of nested frames, and a
 * video that the browser fetches by byte ranges.
 */

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Fidelity</title>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; }
      nav { display: flex; gap: 1rem; padding: 1rem; }
      section { height: 1200px; padding: 1rem; box-sizing: border-box; border-top: 1px solid #ccc; }
    </style>
  </head>
  <body>
    <nav>
      <a id="to-about" href="about.html">About</a>
      <a id="to-s3" href="#section-3">Section 3</a>
    </nav>
    <iframe id="f1" src="frames/inner.html" title="Inner" width="480" height="240"></iframe>
    <video id="v" src="media/clip.webm" muted playsinline preload="auto" width="64" height="64"></video>
    <section id="section-1"><h2>Section 1</h2></section>
    <section id="section-2"><h2>Section 2</h2></section>
    <section id="section-3"><h2>Section 3</h2></section>
    <script>
      window.__marker = 'entry';
    </script>
  </body>
</html>
`;

const INNER_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Inner</title>
  </head>
  <body>
    <p id="inner">Inner frame</p>
    <iframe id="f2" src="deeper.html" title="Deeper" width="320" height="120"></iframe>
  </body>
</html>
`;

const DEEPER_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Deeper</title>
  </head>
  <body>
    <p id="deeper">Deeper frame</p>
  </body>
</html>
`;

const ABOUT_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>About</title>
  </head>
  <body>
    <h1>About</h1>
  </body>
</html>
`;

/** The fixture's files by path; `video` is the WebM it plays (see `makeWebm`). */
export function fidelitySite(video: Buffer): Record<string, string | Buffer> {
  return {
    'index.html': INDEX_HTML,
    'frames/inner.html': INNER_HTML,
    'frames/deeper.html': DEEPER_HTML,
    'about.html': ABOUT_HTML,
    'media/clip.webm': video,
  };
}
