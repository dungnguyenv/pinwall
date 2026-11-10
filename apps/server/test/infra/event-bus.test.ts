import { describe, expect, test, vi } from 'vitest';
import { InProcessEventBus, type PinwallEvent } from '../../src/infra/event-bus.ts';

describe('InProcessEventBus', () => {
  test('delivers to subscribers of a topic only', () => {
    const bus = new InProcessEventBus();
    const onA = vi.fn();
    const onB = vi.fn();
    bus.subscribe('artifact:art_1', onA);
    bus.subscribe('artifact:art_2', onB);

    const event: PinwallEvent = { type: 'version.created', number: 3 };
    bus.publish('artifact:art_1', event);

    expect(onA).toHaveBeenCalledExactlyOnceWith(event);
    expect(onB).not.toHaveBeenCalled();
  });

  test('delivers to every subscriber of the topic, in subscription order', () => {
    const bus = new InProcessEventBus();
    const seen: string[] = [];
    bus.subscribe('t', () => seen.push('first'));
    bus.subscribe('t', () => seen.push('second'));

    bus.publish('t', { type: 'x' });

    expect(seen).toEqual(['first', 'second']);
  });

  test('unsubscribe stops delivery', () => {
    const bus = new InProcessEventBus();
    const kept = vi.fn();
    const dropped = vi.fn();
    bus.subscribe('t', kept);
    const unsubscribe = bus.subscribe('t', dropped);

    bus.publish('t', { type: 'one' });
    unsubscribe();
    unsubscribe();
    bus.publish('t', { type: 'two' });

    expect(dropped).toHaveBeenCalledTimes(1);
    expect(kept).toHaveBeenCalledTimes(2);
  });

  test('the same handler subscribed twice is called twice, and unsubscribed separately', () => {
    const bus = new InProcessEventBus();
    const handler = vi.fn();
    const first = bus.subscribe('t', handler);
    bus.subscribe('t', handler);

    bus.publish('t', { type: 'x' });
    first();
    bus.publish('t', { type: 'y' });

    expect(handler).toHaveBeenCalledTimes(3);
  });

  test('a handler may unsubscribe itself while an event is delivered', () => {
    const bus = new InProcessEventBus();
    const later = vi.fn();
    const unsubscribe = bus.subscribe('t', () => unsubscribe());
    bus.subscribe('t', later);

    bus.publish('t', { type: 'x' });
    bus.publish('t', { type: 'y' });

    expect(later).toHaveBeenCalledTimes(2);
  });

  test('publishing to a topic nobody listens to is harmless', () => {
    expect(() => new InProcessEventBus().publish('nobody', { type: 'x' })).not.toThrow();
  });

  test('a throwing handler does not stop others', () => {
    const errors: unknown[] = [];
    const bus = new InProcessEventBus((error) => errors.push(error));
    const after = vi.fn();
    const boom = new Error('boom');
    bus.subscribe('t', () => {
      throw boom;
    });
    bus.subscribe('t', after);

    expect(() => bus.publish('t', { type: 'x' })).not.toThrow();

    expect(after).toHaveBeenCalledOnce();
    expect(errors).toEqual([boom]);
  });

  test('a rejecting async handler is reported, not left unhandled', async () => {
    const errors: unknown[] = [];
    const bus = new InProcessEventBus((error) => errors.push(error));
    const boom = new Error('async boom');
    bus.subscribe('t', async () => {
      throw boom;
    });

    bus.publish('t', { type: 'x' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(errors).toEqual([boom]);
  });
});
