import { onTestFinished } from 'vitest';

/** A client rect of a test, in viewport pixels. */
export interface StubRect {
  left: number;
  top: number;
  width?: number;
  height?: number;
}

/** The layout a test gives jsdom, which computes none. */
export interface LayoutStub {
  scrollWidth?: number;
  scrollHeight?: number;
  clientWidth?: number;
  clientHeight?: number;
  scrollX?: number;
  scrollY?: number;
  /** The one client rect of each element or range; any other has none. */
  rects?: [Element | Range, StubRect][];
  /** The client rects of ranges `rects` does not list, such as ranges the code makes itself. */
  rangeRects?: (range: Range) => StubRect[];
}

type Restore = () => void;

/** Defines `key` on `target` as a plain value, and returns what puts the old one back. */
function override(target: object, key: string, value: unknown): Restore {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  return () => {
    if (previous) Object.defineProperty(target, key, previous);
    else Reflect.deleteProperty(target, key);
  };
}

function domRect(rect: StubRect | undefined): DOMRect {
  const { left = 0, top = 0, width = 0, height = 0 } = rect ?? {};
  return new DOMRect(left, top, width, height);
}

/**
 * Gives `document.documentElement` and `window` the sizes and scroll offsets of `stub`, and makes
 * `getClientRects`/`getBoundingClientRect` of every element and range answer from `stub.rects`
 * (jsdom's ranges have neither method). Everything is put back when the test finishes.
 */
export function stubLayout(stub: LayoutStub): void {
  const restores: Restore[] = [];
  const root = document.documentElement;
  for (const key of ['scrollWidth', 'scrollHeight', 'clientWidth', 'clientHeight'] as const) {
    if (stub[key] !== undefined) restores.push(override(root, key, stub[key]));
  }
  for (const key of ['scrollX', 'scrollY'] as const) {
    if (stub[key] !== undefined) restores.push(override(window, key, stub[key]));
  }
  const rects = new Map(stub.rects ?? []);
  for (const proto of [Element.prototype, Range.prototype]) {
    restores.push(
      override(proto, 'getClientRects', function (this: Element | Range) {
        const rect = rects.get(this);
        if (rect) return [domRect(rect)];
        return this instanceof Range && stub.rangeRects ? stub.rangeRects(this).map(domRect) : [];
      }),
      override(proto, 'getBoundingClientRect', function (this: Element | Range) {
        return domRect(rects.get(this));
      }),
    );
  }
  onTestFinished(() => {
    for (const restore of restores.reverse()) restore();
  });
}
