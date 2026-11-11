import { expect, test } from 'vitest';
import {
  type Comment,
  CommentBody,
  CommentBodyRequest,
  type CommentThread,
  CommentThreadList,
  CreatedShareLink,
  CreateShareLinkRequest,
  CreateThreadRequest,
  GuestCreated,
  GuestName,
  GuestReplyRequest,
  GuestThreadRequest,
  LIVE_EVENT_TYPES,
  LiveEvent,
  ResolveRequest,
  SHARE_PASSWORD_MIN_LENGTH,
  ShareInfo,
  type ShareLink,
  ShareLinkList,
  ShareLinkQuery,
  ThreadQuery,
  UnlockRequest,
} from '../src/index.ts';
import type { Anchor } from '../src/protocol.ts';

const anchor: Anchor = {
  page: '',
  kind: 'text',
  quote: { exact: 'Bảng giá', prefix: '', suffix: '' },
  position: { x: 0.5, y: 0.5 },
  viewport: { width: 1280 },
};

const reply: Comment = {
  id: 'cmt_2',
  thread_id: 'cmt_1',
  artifact_id: 'art_1',
  version: { id: 'ver_1', number: 1 },
  author: { type: 'guest', name: 'Minh' },
  body: 'Đồng ý',
  created_at: 2,
  updated_at: 2,
  edited_at: null,
};

const thread: CommentThread = {
  id: 'cmt_1',
  thread_id: 'cmt_1',
  artifact_id: 'art_1',
  version: { id: 'ver_1', number: 1 },
  author: { type: 'member', user_id: 'usr_1', name: 'Linh' },
  body: 'Sửa giá',
  created_at: 1,
  updated_at: 3,
  edited_at: 3,
  anchor,
  status: 'resolved',
  resolved_in_version: { id: 'ver_2', number: 2 },
  resolved_by: { user_id: null, name: null },
  resolved_at: 4,
  replies: [reply],
};

const link: ShareLink = {
  id: 'shr_1',
  artifact_id: 'art_1',
  version: null,
  has_password: true,
  allow_comments: false,
  expires_at: null,
  created_by: { user_id: 'usr_1', name: 'Linh' },
  created_at: 1,
  last_used_at: null,
  revoked_at: null,
  status: 'active',
};

const samples: Record<LiveEvent['type'], unknown> = {
  'version.published': {
    type: 'version.published',
    artifact_id: 'art_1',
    version_id: 'ver_2',
    number: 2,
  },
  'version.deleted': { type: 'version.deleted', artifact_id: 'art_1', number: 2 },
  'artifact.deleted': { type: 'artifact.deleted', artifact_id: 'art_1' },
  'comment.created': { type: 'comment.created', artifact_id: 'art_1', thread },
  'comment.updated': { type: 'comment.updated', artifact_id: 'art_1', thread },
  'comment.resolved': { type: 'comment.resolved', artifact_id: 'art_1', thread },
  'comment.reopened': { type: 'comment.reopened', artifact_id: 'art_1', thread },
  'comment.deleted': {
    type: 'comment.deleted',
    artifact_id: 'art_1',
    thread_id: 'cmt_1',
    comment_id: 'cmt_2',
    version_number: 1,
    thread,
  },
};

test('LiveEvent parses every event type', () => {
  expect([...LIVE_EVENT_TYPES].sort()).toEqual(Object.keys(samples).sort());
  for (const type of LIVE_EVENT_TYPES)
    expect(LiveEvent.parse(samples[type])).toEqual(samples[type]);
  expect(LiveEvent.safeParse({ type: 'comment.created' }).success).toBe(false);
  expect(LiveEvent.safeParse({ type: 'comment.created', artifact_id: 'art_1' }).success).toBe(
    false,
  );
  expect(LiveEvent.safeParse({ type: 'comment.moved', artifact_id: 'art_1' }).success).toBe(false);
  const threadGone = { ...(samples['comment.deleted'] as object), thread: null };
  expect(LiveEvent.parse(threadGone)).toEqual(threadGone);
});

test('request defaults', () => {
  expect(CreateShareLinkRequest.parse({})).toEqual({ allow_comments: false });
  expect(ThreadQuery.parse({})).toEqual({ status: 'all', limit: 100 });
  expect(ShareLinkQuery.parse({})).toEqual({ include_revoked: false, limit: 50 });
  expect(CommentBody.safeParse('   ').success).toBe(false);
  expect(GuestName.safeParse('g'.repeat(61)).success).toBe(false);
});

test('comment bodies and guest names are trimmed and bounded', () => {
  expect(CommentBody.parse('  Sửa giá \n')).toBe('Sửa giá');
  expect(CommentBody.safeParse('b'.repeat(10_000)).success).toBe(true);
  expect(CommentBody.safeParse('b'.repeat(10_001)).success).toBe(false);
  expect(GuestName.parse(' Minh ')).toBe('Minh');
  expect(GuestName.safeParse('g'.repeat(60)).success).toBe(true);
  expect(GuestName.safeParse('  ').success).toBe(false);
});

test('thread queries read their numbers and status from the query string', () => {
  expect(ThreadQuery.parse({ status: 'open', version: '2', limit: '5', cursor: 'abc' })).toEqual({
    status: 'open',
    version: 2,
    limit: 5,
    cursor: 'abc',
  });
  for (const bad of [{ status: 'closed' }, { version: '0' }, { limit: '0' }, { limit: '201' }]) {
    expect(ThreadQuery.safeParse(bad).success).toBe(false);
  }
});

test('share link queries read include_revoked as a word, not as any non-empty text', () => {
  expect(ShareLinkQuery.parse({ include_revoked: 'true' }).include_revoked).toBe(true);
  expect(ShareLinkQuery.parse({ include_revoked: 'false' }).include_revoked).toBe(false);
  expect(ShareLinkQuery.safeParse({ include_revoked: 'maybe' }).success).toBe(false);
  expect(ShareLinkQuery.safeParse({ limit: '201' }).success).toBe(false);
});

test('comment requests carry a valid body and anchor', () => {
  expect(CreateThreadRequest.parse({ body: ' Sửa ', anchor })).toEqual({ body: 'Sửa', anchor });
  expect(
    CreateThreadRequest.safeParse({ body: 'x', anchor: { ...anchor, quote: undefined } }).error
      ?.issues[0]?.path,
  ).toEqual(['anchor', 'quote']);
  expect(CommentBodyRequest.safeParse({ body: '' }).success).toBe(false);
  expect(ResolveRequest.parse({})).toEqual({});
  expect(ResolveRequest.parse({ version_id: 'ver_1' })).toEqual({ version_id: 'ver_1' });
  expect(GuestThreadRequest.safeParse({ body: 'x', anchor }).success).toBe(false);
  expect(GuestThreadRequest.parse({ guest_name: ' Minh ', body: 'x', anchor }).guest_name).toBe(
    'Minh',
  );
  expect(GuestReplyRequest.safeParse({ guest_name: 'Minh', body: ' ' }).success).toBe(false);
});

test('threads, lists and guest receipts round-trip', () => {
  const list = { items: [thread], next_cursor: null };
  expect(CommentThreadList.parse(list)).toEqual(list);
  const created = { thread, comment_id: 'cmt_1', guest_token: 'secret' };
  expect(GuestCreated.parse(created)).toEqual(created);
  expect(
    CommentThreadList.safeParse({ items: [{ ...thread, status: 'closed' }], next_cursor: null })
      .success,
  ).toBe(false);
});

test('share links and share info round-trip', () => {
  expect(SHARE_PASSWORD_MIN_LENGTH).toBe(8);
  const list = { items: [link], next_cursor: 'next' };
  expect(ShareLinkList.parse(list)).toEqual(list);
  const created = { link, token: 'tok', url: 'https://pinwall.test/s/tok' };
  expect(CreatedShareLink.parse(created)).toEqual(created);
  expect(
    ShareLinkList.safeParse({ items: [{ ...link, status: 'paused' }], next_cursor: null }).success,
  ).toBe(false);
  const info = {
    artifact_name: 'Báo giá',
    kind: 'markdown',
    version_number: 3,
    follows_current: true,
    allow_comments: true,
    expires_at: null,
    content: {
      url: 'https://c.pinwall.test/x/',
      mode: 'raw',
      expires_at: 5,
      isolation: 'content-domain',
    },
  };
  expect(ShareInfo.parse(info)).toEqual(info);
});

test('share link requests bound the password', () => {
  expect(
    CreateShareLinkRequest.parse({
      version_id: null,
      password: null,
      expires_at: null,
      allow_comments: true,
    }),
  ).toEqual({ version_id: null, password: null, expires_at: null, allow_comments: true });
  expect(CreateShareLinkRequest.safeParse({ password: '' }).success).toBe(false);
  expect(CreateShareLinkRequest.safeParse({ password: 'p'.repeat(1025) }).success).toBe(false);
  expect(CreateShareLinkRequest.safeParse({ expires_at: 1.5 }).success).toBe(false);
  expect(UnlockRequest.safeParse({ password: '' }).success).toBe(false);
  expect(UnlockRequest.safeParse({ password: 'p'.repeat(1024) }).success).toBe(true);
});
