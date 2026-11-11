import { CommentThread } from '@pinwall/shared';
import type { Anchor } from '@pinwall/shared/protocol';
import { apiInit } from './auth.ts';
import type { TestContext } from './context.ts';

/** A text anchor on `docs/`, with a DOM path too, merged with `over`. */
export function sampleAnchor(over: Partial<Anchor> = {}): Anchor {
  return {
    page: 'docs/',
    kind: 'text',
    quote: { exact: 'Bảng giá', prefix: 'Xem ', suffix: ' mới' },
    dom: { path: '#pricing > h2' },
    position: { x: 0.1, y: 0.2 },
    viewport: { width: 1280 },
    ...over,
  };
}

/**
 * Opens a thread on the artifact as the holder of `cookie`, through the REST API, and returns it.
 * Defaults: body "Sửa giá", `sampleAnchor()`, the current version.
 */
export async function postThread(
  ctx: TestContext,
  cookie: string,
  artifactId: string,
  o: { body?: string; anchor?: Anchor; versionId?: string } = {},
): Promise<CommentThread> {
  const body = {
    body: o.body ?? 'Sửa giá',
    anchor: o.anchor ?? sampleAnchor(),
    ...(o.versionId === undefined ? {} : { version_id: o.versionId }),
  };
  const r = await ctx.request(
    `/api/v1/artifacts/${artifactId}/comments`,
    apiInit(ctx, { method: 'POST', cookie, body }),
  );
  if (r.status !== 201) {
    throw new Error(
      `POST /artifacts/${artifactId}/comments answered ${r.status}: ${await r.text()}`,
    );
  }
  return CommentThread.parse(await r.json());
}
