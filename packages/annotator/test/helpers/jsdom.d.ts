/**
 * The small part of `jsdom` (which ships no type definitions) the annotator tests use to open a
 * second, fresh window. Shapes follow the library's own runtime API.
 */
declare module 'jsdom' {
  export interface ConstructorOptions {
    url?: string;
    runScripts?: 'dangerously' | 'outside-only';
    pretendToBeVisual?: boolean;
  }

  export class JSDOM {
    constructor(html?: string, options?: ConstructorOptions);
    readonly window: Window & typeof globalThis;
  }
}
