import { expect, test } from 'vitest';
import { followVersion } from './follow.ts';

// biome-ignore format: one case per line reads as a table
test.each([
  [{ follow: true, shown: null, current: 3, composing: false }, { shown: 3, pending: null }],
  [{ follow: true, shown: 3, current: 4, composing: false }, { shown: 4, pending: null }],
  [{ follow: true, shown: 3, current: 4, composing: true }, { shown: 3, pending: 4 }],
  // The shown version was deleted: move even mid-draft.
  [{ follow: true, shown: 4, current: 3, composing: true }, { shown: 3, pending: null }],
  // A chosen version stays; the page shows "View latest" instead.
  [{ follow: false, shown: 2, current: 4, composing: false }, { shown: 2, pending: null }],
  [{ follow: true, shown: 4, current: 4, composing: true }, { shown: 4, pending: null }],
  // Before the artifact is read there is nothing to follow yet.
  [{ follow: true, shown: null, current: null, composing: false }, { shown: null, pending: null }],
])('followVersion(%j)', (i, out) => expect(followVersion(i)).toEqual(out));
