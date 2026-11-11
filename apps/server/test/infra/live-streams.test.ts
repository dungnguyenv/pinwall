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

  test('counts streams under their keys until they stop being tracked', () => {
    const streams = new LiveStreams();
    const address = { key: 'address:198.51.100.1', limit: 2 };
    const link = { key: 'share-link:shr_1', limit: 3 };
    expect(streams.hasRoom([address, link])).toBe(true);
    const a = streams.add(vi.fn(), [address, link]);
    streams.add(vi.fn(), [address, link]);
    expect(streams.countOf(address.key)).toBe(2);
    // The address is at its limit; the link, and the same link from another address, are not.
    expect(streams.hasRoom([address, link])).toBe(false);
    expect(streams.hasRoom([address])).toBe(false);
    expect(streams.hasRoom([link])).toBe(true);
    const other = { key: 'address:198.51.100.2', limit: 2 };
    expect(streams.hasRoom([other, link])).toBe(true);
    streams.add(vi.fn(), [other, link]);
    expect(streams.hasRoom([other, link])).toBe(false);

    // Untracking releases the stream's place under every key, once.
    a();
    a();
    expect(streams.countOf(address.key)).toBe(1);
    expect(streams.countOf(link.key)).toBe(2);
    expect(streams.hasRoom([address, link])).toBe(true);
    expect(streams.hasRoom([])).toBe(true);
  });

  test('closeAll releases every count', () => {
    const streams = new LiveStreams();
    const session = { key: 'session:s1', limit: 1 };
    const untrack = streams.add(vi.fn(), [session]);
    expect(streams.hasRoom([session])).toBe(false);
    streams.closeAll();
    untrack();
    expect(streams.countOf(session.key)).toBe(0);
    // A stream added after closeAll ends at once and holds no place.
    streams.add(vi.fn(), [session]);
    expect(streams.countOf(session.key)).toBe(0);
  });
});
