// Injected into the annotator bundle in place of every `globalThis` it references. zod keeps its
// settings on `globalThis.__zod_globalConfig`; inside a page that would be a second global, shared
// with any zod the page itself loads. Here the settings stay private to the bundle, and `jitless`
// keeps zod from probing `new Function`, which a page's CSP would report as a violation.
const scope = { __zod_globalConfig: { jitless: true } };

export { scope as globalThis };
