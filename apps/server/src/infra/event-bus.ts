export type PinwallEvent = { type: string; [k: string]: unknown };

/** Fan-out of events to live listeners (artifact pages, comment threads). */
export interface EventBus {
  publish(topic: string, event: PinwallEvent): void;
  /** Returns a function that removes the subscription; calling it again does nothing. */
  subscribe(topic: string, handler: (e: PinwallEvent) => void): () => void;
}

type Handler = (e: PinwallEvent) => void;

/** Delivers synchronously, in subscription order, to the subscribers of the exact topic. */
export class InProcessEventBus implements EventBus {
  // Each subscription is its own object, so one handler subscribed twice is called twice.
  private readonly topics = new Map<string, Set<{ handler: Handler }>>();

  /**
   * `onHandlerError` receives whatever a handler throws, or the rejection of one that returns a
   * rejected promise; either way the remaining handlers still run. Without it such errors are
   * dropped, so the application should pass one that logs.
   */
  constructor(
    private readonly onHandlerError: (error: unknown, topic: string) => void = () => {},
  ) {}

  publish(topic: string, event: PinwallEvent): void {
    const subscriptions = this.topics.get(topic);
    if (!subscriptions) return;
    // A copy, so handlers may subscribe or unsubscribe while the event is delivered.
    for (const { handler } of [...subscriptions]) {
      try {
        const result: unknown = handler(event);
        if (result instanceof Promise) {
          result.catch((error: unknown) => this.onHandlerError(error, topic));
        }
      } catch (error) {
        this.onHandlerError(error, topic);
      }
    }
  }

  /** How many subscriptions `topic` has: for diagnostics and tests. */
  subscriberCount(topic: string): number {
    return this.topics.get(topic)?.size ?? 0;
  }

  subscribe(topic: string, handler: Handler): () => void {
    const subscription = { handler };
    let subscriptions = this.topics.get(topic);
    if (!subscriptions) {
      subscriptions = new Set();
      this.topics.set(topic, subscriptions);
    }
    subscriptions.add(subscription);

    return () => {
      const current = this.topics.get(topic);
      if (!current) return;
      current.delete(subscription);
      if (current.size === 0) this.topics.delete(topic);
    };
  }
}
