import { describe, expect, test, vi } from 'vitest';
import { LiveStreams } from '../../src/infra/live-streams.ts';

describe('LiveStreams', () => {
  test('tracks streams until they stop being tracked', () => {
    const streams = new LiveStreams();
    const end = vi.fn();
    const untrackA = streams.add(end);
    const untrackB = streams.add(end);
    expect(streams.size).toBe(2);
    untrackA();
    untrackA();
    expect(streams.size).toBe(1);
    untrackB();
    expect(streams.size).toBe(0);
    expect(end).not.toHaveBeenCalled();
  });

  test('closeAll ends every open stream once, and every later one at once', () => {
    const streams = new LiveStreams();
    const a = vi.fn();
    const b = vi.fn();
    streams.add(a);
    const untrackB = streams.add(b);
    untrackB();
    streams.closeAll();
    streams.closeAll();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    expect(streams.size).toBe(0);

    const late = vi.fn();
    const untrackLate = streams.add(late);
    expect(late).toHaveBeenCalledTimes(1);
    expect(streams.size).toBe(0);
    untrackLate();
  });
});
