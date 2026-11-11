import { act } from '@testing-library/react';

/*
 * jsdom has no layout, so `window.matchMedia` is stubbed here: width queries
 * (`min-width` / `max-width` in px, joined with `and`) are answered from a
 * viewport width that tests set; every other feature, such as
 * `prefers-color-scheme: dark`, does not match.
 */

const DEFAULT_WIDTH = 1024; // jsdom's innerWidth

let width = DEFAULT_WIDTH;
const lists = new Set<StubMediaQueryList>();

function matches(query: string): boolean {
  return query.split(/\s+and\s+/i).every((part) => {
    const feature = /^\(\s*(min|max)-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)$/i.exec(part.trim());
    if (!feature) return false;
    const limit = Number(feature[2]);
    return feature[1]?.toLowerCase() === 'min' ? width >= limit : width <= limit;
  });
}

class StubMediaQueryList extends EventTarget {
  onchange: ((event: MediaQueryListEvent) => void) | null = null;
  #matched: boolean;

  constructor(readonly media: string) {
    super();
    this.#matched = matches(media);
  }

  get matches(): boolean {
    return matches(this.media);
  }

  addListener(listener: (event: MediaQueryListEvent) => void): void {
    this.addEventListener('change', listener as EventListener);
  }

  removeListener(listener: (event: MediaQueryListEvent) => void): void {
    this.removeEventListener('change', listener as EventListener);
  }

  /** Fires `change` when the new width flips the answer. */
  update(): void {
    const now = this.matches;
    if (now === this.#matched) return;
    this.#matched = now;
    const event = Object.assign(new Event('change'), { matches: now, media: this.media });
    this.onchange?.(event as MediaQueryListEvent);
    this.dispatchEvent(event);
  }
}

export function installMatchMedia(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => {
      const list = new StubMediaQueryList(query);
      lists.add(list);
      return list as unknown as MediaQueryList;
    },
  });
}

/** Sets the viewport width that media queries see, and tells listeners whose answer changed. */
export function setViewport(next: number): void {
  width = next;
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: next });
  act(() => {
    for (const list of lists) list.update();
    window.dispatchEvent(new Event('resize'));
  });
}

/** Back to the default width, forgetting the lists of unmounted components. */
export function resetViewport(): void {
  width = DEFAULT_WIDTH;
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: DEFAULT_WIDTH,
  });
  lists.clear();
}
