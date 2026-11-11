import {
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { ApiError } from '../../api/client.ts';
import type { Anchor, Comment, CommentThread } from '../../api/dto.ts';
import { qk } from '../../api/keys.ts';
import type { CommentBackend } from './backend.ts';
import { removeComment, upsertComment, upsertThread } from './threads.ts';

/** Every thread of the review, resolved ones too. */
export function useThreads(b: CommentBackend): UseQueryResult<CommentThread[], ApiError> {
  return useQuery<CommentThread[], ApiError>({
    queryKey: qk.threads(b.scope),
    queryFn: () => b.list(),
  });
}

type CreateVars = { body: string; anchor: Anchor; versionId: string | null };
type ReplyVars = { threadId: string; body: string };
type EditVars = { commentId: string; body: string };
/** `commentId` equal to `threadId` deletes the whole thread. */
type RemoveVars = { threadId: string; commentId: string };
type ResolveVars = { threadId: string; versionId: string };

export interface CommentActions {
  create: UseMutationResult<CommentThread, ApiError, CreateVars>;
  reply: UseMutationResult<Comment, ApiError, ReplyVars>;
  edit: UseMutationResult<Comment, ApiError, EditVars>;
  remove: UseMutationResult<void, ApiError, RemoveVars>;
  resolve: UseMutationResult<CommentThread, ApiError, ResolveVars>;
  /** Takes the thread's id. */
  reopen: UseMutationResult<CommentThread, ApiError, string>;
}

/**
 * The comment writes of a review. A success changes the cached threads from
 * the server's answer rather than reading the list again, so the panel and
 * pins update at once. Before the list is first read there is nothing to
 * change: the read that follows holds the new state.
 */
export function useCommentActions(b: CommentBackend): CommentActions {
  const queryClient = useQueryClient();
  const key = qk.threads(b.scope);
  const change = (update: (list: CommentThread[]) => CommentThread[]) =>
    queryClient.setQueryData<CommentThread[]>(key, (list) => list && update(list));

  const create = useMutation<CommentThread, ApiError, CreateVars>({
    mutationFn: (p) => b.create(p),
    onSuccess: (thread) => change((list) => upsertThread(list, thread)),
  });
  const reply = useMutation<Comment, ApiError, ReplyVars>({
    mutationFn: (p) => b.reply(p.threadId, p.body),
    onSuccess: (comment) => change((list) => upsertComment(list, comment)),
  });
  const edit = useMutation<Comment, ApiError, EditVars>({
    mutationFn: (p) => b.edit(p.commentId, p.body),
    onSuccess: (comment) => change((list) => upsertComment(list, comment)),
  });
  const remove = useMutation<void, ApiError, RemoveVars>({
    mutationFn: (p) => b.remove(p.commentId),
    onSuccess: (_none, p) => change((list) => removeComment(list, p.threadId, p.commentId)),
  });
  const resolve = useMutation<CommentThread, ApiError, ResolveVars>({
    mutationFn: (p) => {
      if (!b.resolve) throw new Error('This review cannot resolve threads');
      return b.resolve(p.threadId, p.versionId);
    },
    onSuccess: (thread) => change((list) => upsertThread(list, thread)),
  });
  const reopen = useMutation<CommentThread, ApiError, string>({
    mutationFn: (threadId) => {
      if (!b.reopen) throw new Error('This review cannot reopen threads');
      return b.reopen(threadId);
    },
    onSuccess: (thread) => change((list) => upsertThread(list, thread)),
  });

  return { create, reply, edit, remove, resolve, reopen };
}
