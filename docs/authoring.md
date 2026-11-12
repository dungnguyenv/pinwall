# Writing pages for Pinwall

Pinwall serves the files you publish as they are, from an address of its own, and shows them in a
review viewer. A few rules keep a page working in both content-isolation modes and in review. They
are the same for an agent that publishes and for a person who uploads, and the Pinwall skill hands
the short version of them to Claude Code.

- [The entry page](#the-entry-page)
- [Links, frames and anchors](#links-frames-and-anchors)
- [What a page can keep](#what-a-page-can-keep)
- [The page's own Content-Security-Policy](#the-pages-own-content-security-policy)
- [Text encoding](#text-encoding)
- [Size and file limits](#size-and-file-limits)
- [Markdown](#markdown)

## The entry page

A version opens on its entry page, chosen from the top level of what you publish, in this order:

1. `index.html`
2. `index.md`
3. `README.md`
4. the only file, when you publish a single file

With none of these and more than one file, the publish is refused with a message that asks you to
name the main page `index.html` or `index.md`. A folder that wraps everything, such as the `site/`
that `tar -czf site.tgz site/` creates, is removed first, so the entry page does not have to sit
one level down. A request for a folder, such as `docs/`, opens the `index.html` or `index.md` in it.

Publish a single file, or a tar, tar.gz or zip archive. Paths use `/` and stay within 512
characters. Pinwall refuses an archive with an absolute path, a `..` segment, a
backslash or a control character in a name, a symbolic or hard link, a device or other special file,
two names that differ only in Unicode normalization, or anything under the folder `__pinwall/`,
which is Pinwall's own. It drops macOS leftovers (`__MACOSX/`, `._*` and `.DS_Store`) without
complaint. Whatever you publish can be read by everyone who can open the artifact, so keep `.env`
files and `.git` folders out of it.

## Links, frames and anchors

Use relative links and relative asset paths: `css/site.css`, `../img/logo.png`, `about.html`. Every
version is served under an address of its own, and the address changes with the isolation mode and
with each new access:

- in single-domain mode, under `/c/<token>/` on the app's own host;
- in content-domain mode, at the root of a host such as `<token>.pinwall-content.example`.

A page cannot know that base, and a relative path does not need to. A link that starts with `/`
points at the root of the host instead. In single-domain mode that root is the app, so
`/css/site.css` asks the app for a file that is not there and the page loads without its style.
Such a page might happen to load in content-domain mode, but the mode can be changed at any time, so
do not rely on it.

When a file contains one of these links, Pinwall publishes anyway and warns. A warning reads like
this, and it is part of the publish result, in the web app and in what an agent gets back:

> `index.html` refers to `/css/site.css` from the server root, which does not load in
> single-domain mode. Use a relative path.

Pinwall looks for these in the `href`, `src`, `action`, `poster`, `data`, `formaction` and `srcset`
attributes of HTML, in `<style>` blocks, and in the `url()` and `@import` of CSS files. It reports a
file and a link once, and keeps at most 50 warnings per version. It cannot see a link that a script
builds at run time, such as `fetch('/data.json')`, so check those yourself.

Include everything the page needs in what you publish. A version never changes after it is
published, and a page that loads a script from somewhere else is only as stable as that place.

**Nested frames.** A page can embed other pages of its own version, as in
`<iframe src="detail.html">`, with a relative address. They load in the review viewer exactly as they
do on the raw link. In single-domain mode, and always inside the review viewer, each page and frame
has an origin of its own that matches nothing, so frames cannot read each other's DOM. Let them talk
with `postMessage`.

**Anchors.** A link such as `#pricing` scrolls the page to the element with that id, and
`other.html#pricing` opens the other page at that element, in review and on the raw link alike.
Nothing rewrites your links. Headings in a Markdown file get ids too, see [Markdown](#markdown).

## What a page can keep

Pinwall treats a page as untrusted code, so it never gives it the session of the app. What that
means for the page depends on `PINWALL_ISOLATION`.

**Single-domain mode.** Every response comes with `Content-Security-Policy: sandbox` and without
`allow-same-origin`, so the page has an opaque origin. It can run scripts, submit forms, open
popups and dialogs, download files, use pointer lock and presentation, and fetch its own files. It
has no cookies, no `localStorage` or `sessionStorage`, no IndexedDB and no service workers. A script
that touches them without a `try`/`catch` stops at that line, and that includes libraries that read
saved state when they load. Keep state in memory, or in the URL (the query string or the hash) when
it has to survive a reload.

**Content-domain mode.** Each version is served from a host of its own, so a raw link opens the
page with an ordinary origin, and storage works while that page stays open. Each
new access to a version gets a new host name, and a different version is a different origin too, so
nothing carries over between versions or between visits. Treat storage as scratch space.

**In the review viewer**, in both modes, the page sits in a frame sandboxed the same way as in
single-domain mode, so storage is not available there. Write the page so that it works without it.

## The page's own Content-Security-Policy

A page can set its own policy with `<meta http-equiv="Content-Security-Policy" content="…">`.
Pinwall respects it and never relaxes it. In single-domain mode the sandbox policy is added to it,
and the browser applies both.

To let people pin comments on text and elements, Pinwall adds a small annotator script to the page,
but only when the page is shown for review, and never to a raw link, which serves your bytes exactly
as published. The script tag is placed right after the page's last policy tag, so your policy
decides whether it may run. When the policy blocks it, as `script-src 'none'` does, the page still
takes point comments: a person clicks a spot on the page and the viewer pins the comment on its own
overlay. Only the comments on a selected text or a chosen element need the annotator.

## Text encoding

Write pages in UTF-8. Pinwall labels an HTML file UTF-8 unless its own bytes say otherwise, the way
a browser reads them: a byte order mark, or a `<meta charset="…">` or
`<meta http-equiv="Content-Type" content="text/html; charset=…">` within its first 1024 bytes. A
page in Shift_JIS or windows-1258 that declares its encoding like that is served with that charset,
on the raw link and in review, and its bytes are never changed. Pinwall still reads every page as
UTF-8 for its title and for search, so a page in another encoding can show a garbled title in the
list and be hard to find by its words. CSS, JavaScript, JSON, Markdown and other text files are
always served as UTF-8.

## Size and file limits

An operator sets these limits with environment variables, and a publish that goes over one is
refused with a message that names it. The defaults are in the table, and
[docs/configuration.md](configuration.md#upload-limits) has the full text. An agent can ask its
Pinwall for the values in force with `whoami`, and the upload dialog of the web app shows them.

| Variable | Default | What it limits |
| --- | --- | --- |
| `PINWALL_MAX_UPLOAD_BYTES` | 95 MB | One publish request, as it is sent |
| `PINWALL_MAX_INLINE_BYTES` | 2 MB | All the text an agent sends inline in one MCP publish |
| `PINWALL_MAX_FILE_BYTES` | 50 MB | One file in a version |
| `PINWALL_MAX_VERSION_BYTES` | 500 MB | A version, unpacked |
| `PINWALL_MAX_FILES` | 10000 | Files in one version |
| `PINWALL_MAX_EXPANSION_RATIO` | 100 | How many times larger than the upload a version may unpack to |

## Markdown

A Markdown entry page, or any other `.md` file in a version, is shown as a formatted page:

- It follows CommonMark with tables, strikethrough, and bare web addresses turned into links. Raw
  HTML in it is kept, and runs in the same sandbox as an HTML artifact. Pinwall adds no other
  extension, so footnotes, task-list checkboxes, math and diagrams do not render. Write those in HTML.
- The title is the first heading. The page follows the viewer's light or dark setting and has a
  print style.
- A table of contents appears at the top when the file has at least two headings of level 2 or 3.
- Every heading gets an id: lower case, spaces turned into hyphens, punctuation dropped, letters of
  any language kept, and a repeated heading numbered `-1`, `-2`. So `## Chụp ảnh` is `#chụp-ảnh`.
- A fenced block with a language name, as in ` ```ts `, is highlighted when the language is one of
  the common ones, and shown plain otherwise.
- Relative links and images work like in HTML. A link to another `.md` file opens it as a page, and
  adding `?source` to a Markdown address shows the file as it was stored.
- A Markdown file larger than 200 KB is not formatted: its page says so and offers the source.
