import { expect, test } from 'vitest';
import type { LiveEvent } from '../../api/dto.ts';
import { fx } from '../../test/fixtures.ts';
import {
  applyLiveEvent,
  countThreads,
  filterThreads,
  pinNumbers,
  removeComment,
  threadsForVersion,
  upsertComment,
  upsertThread,
} from './threads.ts';

const a = fx.thread({ id: 'cmt_a', created_at: 1 });
const b = fx.thread({ id: 'cmt_b', created_at: 2 });
const reply1 = fx.comment({ id: 'cmt_r1', thread_id: 'cmt_a', created_at: 5 });
const a1 = { ...a, replies: [reply1] };

const ids = (list: { id: string }[]) => list.map((t) => t.id);

test('upsert keeps creation order and replaces by id', () => {
  expect(ids(upsertThread([b], a))).toEqual(['cmt_a', 'cmt_b']);
  expect(upsertThread([a, b], { ...a, body: 'x' })[0]?.body).toBe('x');
  expect(ids(upsertThread([a], b))).toEqual(['cmt_a', 'cmt_b']);

  // Threads made in the same millisecond keep the order of their ids.
  const tie = fx.thread({ id: 'cmt_c', created_at: 2 });
  expect(ids(upsertThread([a, tie], b))).toEqual(['cmt_a', 'cmt_b', 'cmt_c']);

  // The same thread again changes nothing: same array, same thread objects.
  const list = [a, b];
  expect(upsertThread(list, structuredClone(a))).toBe(list);
});

test('comments update roots and replies', () => {
  // A root edit replaces the root's fields and keeps replies, anchor and status.
  const root = fx.comment({
    id: 'cmt_a',
    thread_id: 'cmt_a',
    created_at: 1,
    body: 'edited',
    edited_at: 9,
  });
  const edited = upsertComment([a1, b], root);
  expect(edited[0]).toMatchObject({ id: 'cmt_a', body: 'edited', edited_at: 9, status: 'open' });
  expect(edited[0]?.anchor).toEqual(a.anchor);
  expect(edited[0]?.replies).toEqual([reply1]);
  expect(edited[1]).toBe(b);

  // A new reply is appended in creation order; an earlier one goes before.
  const r2 = fx.comment({ id: 'cmt_r2', thread_id: 'cmt_a', created_at: 7 });
  const r0 = fx.comment({ id: 'cmt_r0', thread_id: 'cmt_a', created_at: 3 });
  expect(ids(upsertComment([a1], r2)[0]?.replies ?? [])).toEqual(['cmt_r1', 'cmt_r2']);
  expect(ids(upsertComment([a1], r0)[0]?.replies ?? [])).toEqual(['cmt_r0', 'cmt_r1']);

  // A reply edit replaces that reply.
  const edit = { ...reply1, body: 'new text', edited_at: 8 };
  expect(upsertComment([a1], edit)[0]?.replies).toEqual([edit]);

  // An unknown thread, or a comment already in the cache, returns the same array.
  const list = [a1, b];
  expect(upsertComment(list, fx.comment({ id: 'cmt_x', thread_id: 'cmt_missing' }))).toBe(list);
  expect(upsertComment(list, structuredClone(reply1))).toBe(list);
});

test('remove drops a reply or the whole thread', () => {
  const list = [a1, b];
  expect(removeComment(list, 'cmt_a', 'cmt_r1')[0]?.replies).toEqual([]);
  expect(removeComment(list, 'cmt_a', 'cmt_r1')[1]).toBe(b);
  expect(ids(removeComment(list, 'cmt_a', 'cmt_a'))).toEqual(['cmt_b']);
  expect(removeComment(list, 'cmt_a', 'cmt_none')).toBe(list);
  expect(removeComment(list, 'cmt_none', 'cmt_none')).toBe(list);
});

test('live events apply to the cache', () => {
  const artifact_id = 'art_1';
  const edited = { ...a, body: 'by someone else' };

  expect(applyLiveEvent([b], { type: 'comment.created', artifact_id, thread: a })).toEqual([a, b]);
  for (const type of ['comment.updated', 'comment.resolved', 'comment.reopened'] as const) {
    expect(applyLiveEvent([a, b], { type, artifact_id, thread: edited })[0]).toEqual(edited);
  }

  // A deleted first comment takes its thread with it.
  const rootDeleted: LiveEvent = {
    type: 'comment.deleted',
    artifact_id,
    thread_id: 'cmt_a',
    comment_id: 'cmt_a',
    version_number: 1,
    thread: null,
  };
  expect(ids(applyLiveEvent([a1, b], rootDeleted))).toEqual(['cmt_b']);
  // A deleted reply comes with the thread as it is now.
  const replyDeleted: LiveEvent = {
    type: 'comment.deleted',
    artifact_id,
    thread_id: 'cmt_a',
    comment_id: 'cmt_r1',
    version_number: 1,
    thread: a,
  };
  expect(applyLiveEvent([a1, b], replyDeleted)[0]).toEqual(a);

  // Version and artifact events are not about comments.
  const list = [a, b];
  expect(
    applyLiveEvent(list, {
      type: 'version.published',
      artifact_id,
      version_id: 'ver_2',
      number: 2,
    }),
  ).toBe(list);
  expect(applyLiveEvent(list, { type: 'version.deleted', artifact_id, number: 2 })).toBe(list);
  expect(applyLiveEvent(list, { type: 'artifact.deleted', artifact_id })).toBe(list);

  // An event that repeats what the cache holds changes nothing.
  expect(
    applyLiveEvent(list, { type: 'comment.updated', artifact_id, thread: structuredClone(a) }),
  ).toBe(list);
});

const resolved = {
  status: 'resolved' as const,
  resolved_in_version: { id: 'ver_2', number: 2 },
  resolved_by: { user_id: 'usr_0000000000000000000a', name: 'Ada Lovelace' },
  resolved_at: 20,
};
const t1 = fx.thread({ id: 'cmt_1', created_at: 1 });
const t2 = fx.thread({
  id: 'cmt_2',
  created_at: 2,
  version: { id: 'ver_2', number: 2 },
  ...resolved,
});
const t3 = fx.thread({ id: 'cmt_3', created_at: 3, version: { id: 'ver_3', number: 3 } });

test('version filter, status filter, sticky ids and counts', () => {
  const all = [t1, t2, t3];
  expect(threadsForVersion(all, 2)).toEqual([t1, t2]);
  expect(threadsForVersion(all, 1)).toEqual([t1]);
  expect(threadsForVersion(all, 3)).toBe(all);

  expect(countThreads([t1, t2])).toEqual({ open: 1, resolved: 1 });
  expect(countThreads([])).toEqual({ open: 0, resolved: 0 });

  const pair = [t1, t2];
  expect(filterThreads(pair, 'open', new Set())).toEqual([t1]);
  expect(filterThreads(pair, 'resolved', new Set())).toEqual([t2]);
  expect(filterThreads(pair, 'all', new Set())).toBe(pair);
  // A thread the person just resolved stays in the Open list until they leave it.
  expect(filterThreads(pair, 'open', new Set(['cmt_2']))).toEqual([t1, t2]);
  expect(filterThreads(pair, 'resolved', new Set(['cmt_1']))).toEqual([t1, t2]);
  // Nothing filtered out: the same array.
  expect(filterThreads([t1, t3], 'open', new Set())).toEqual([t1, t3]);
  const open = [t1, t3];
  expect(filterThreads(open, 'open', new Set())).toBe(open);
});

test('pin numbers follow creation order', () => {
  expect([...pinNumbers([a, b, t3])]).toEqual([
    ['cmt_a', 1],
    ['cmt_b', 2],
    ['cmt_3', 3],
  ]);
  // The numbers follow the list given, so a filtered list renumbers.
  expect([...pinNumbers([b])]).toEqual([['cmt_b', 1]]);
  expect(pinNumbers([]).size).toBe(0);
});
