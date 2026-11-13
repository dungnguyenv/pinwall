import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { SSE_HEARTBEAT_MS } from '../../src/http/sse.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { readSse } from '../helpers/review.ts';
import { listen } from '../helpers/socket.ts';
import {
  MODES,
  removeMember,
  type SpacesFixture,
  sameAnswer,
  spacesContext,
  spacesFixture,
  UNKNOWN_IDS,
} from './fixture.ts';

const RETRY = 'retry: 5000\n\n';
/** How long a stream that should stay open is watched for an end. */
const STAYS_OPEN_MS = 300;

/** Only the heartbeat's interval is faked: sockets, the database and `readSse` keep real time. */
const fakeHeartbeat = () => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
/** Moves the faked interval on to the next heartbeat: a ping, then the access check. */
const heartbeat = () => vi.advanceTimersByTimeAsync(SSE_HEARTBEAT_MS);

describe.each(dialects)('member live streams on %s', (dialect) => {
  describe.each(MODES)('in %s mode', (mode) => {
    let ctx: TestContext;
    let server: Awaited<ReturnType<typeof listen>>;
    let fx: SpacesFixture;
    beforeAll(async () => {
      ctx = await spacesContext(dialect, mode);
      server = await listen(ctx.app, ctx.deps.config);
    });
    // Tests take people out of P, so each gets its own fixture, in the shared context.
    beforeEach(async () => {
      fx = await spacesFixture(ctx);
    });
    afterEach(() => {
      vi.useRealTimers();
    });
    afterAll(async () => {
      await server?.close();
      await ctx?.close();
    });

    /** A GET of the artifact's stream over a real socket, with `cookie`. */
    const open = (artifactId: string, cookie: string) =>
      fetch(`http://127.0.0.1:${server.port}/api/v1/artifacts/${artifactId}/events`, {
        headers: { cookie },
      });

    /** The artifact's stream for `cookie`, read past its `retry` line. */
    async function stream(artifactId: string, cookie: string) {
      const res = await open(artifactId, cookie);
      expect(res.status, res.status === 200 ? '' : await res.text()).toBe(200);
      const s = readSse(res);
      expect(await s.next()).toBe(RETRY);
      return s;
    }

    test("a stranger cannot follow another space's artifact", async () => {
      const { S } = fx.people;
      if (mode === 'team') {
        await (await stream(fx.ids.p, S.cookie)).cancel();
        return;
      }
      const res = await open(fx.ids.p, S.cookie);
      const missing = await open(UNKNOWN_IDS.p, S.cookie);
      expect(res.status).toBe(404);
      sameAnswer(
        { status: res.status, body: await res.json() },
        { status: missing.status, body: await missing.json() },
      );
    });

    test("a member's stream ends within one heartbeat of losing sight", async () => {
      fakeHeartbeat();
      const { E } = fx.people;
      const s = await stream(fx.ids.p, E.cookie);
      // A heartbeat while E sees p leaves the stream open.
      await heartbeat();
      expect(await s.done(STAYS_OPEN_MS)).toBe(false);

      await removeMember(ctx, fx.ids.P, E.user.id);
      await heartbeat();
      if (mode === 'personal') {
        expect(await s.done()).toBe(true);
        return;
      }
      expect(await s.done(STAYS_OPEN_MS)).toBe(false);
      await s.cancel();
    });
  });
});
