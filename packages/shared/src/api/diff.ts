import { z } from 'zod';

/** One side of a changed file: what a version stores at the path. */
export const FileSide = z.object({
  sha256: z.string(),
  size: z.number().int(),
  content_type: z.string(),
});
export type FileSide = z.infer<typeof FileSide>;

/** A file that differs between two versions; `old` is null when it was added, `new` when removed. */
export const FileChange = z.object({
  path: z.string(),
  status: z.enum(['added', 'removed', 'modified']),
  old: FileSide.nullable(),
  new: FileSide.nullable(),
});
export type FileChange = z.infer<typeof FileChange>;

/** The files that changed from version `from` to version `to`, by content hash, in path order. */
export const VersionDiff = z.object({
  from: z.number().int(),
  to: z.number().int(),
  files: z.array(FileChange),
});
export type VersionDiff = z.infer<typeof VersionDiff>;

/**
 * The unified diff of one text file. `patch` is null when the file was not compared: `binary`
 * says a side is not text (compare `old` and `new` by size and hash), `too_large` that a side is
 * over the size or line limit or that the two differ too much to compare in bounded time. A side
 * is null when the version has no such file.
 */
export const TextFileDiff = z.object({
  path: z.string(),
  binary: z.boolean(),
  too_large: z.boolean(),
  patch: z.string().nullable(),
  old: FileSide.nullable(),
  new: FileSide.nullable(),
});
export type TextFileDiff = z.infer<typeof TextFileDiff>;

/**
 * One top-level block of a Markdown file, rendered. `old_html` is null for an added block and
 * `new_html` for a removed one; the HTML comes from the artifact and is untrusted.
 */
export const MarkdownBlockChange = z.object({
  op: z.enum(['unchanged', 'added', 'removed', 'changed']),
  old_html: z.string().nullable(),
  new_html: z.string().nullable(),
});
export type MarkdownBlockChange = z.infer<typeof MarkdownBlockChange>;

/**
 * A Markdown file compared block by block. `blocks` is empty and `too_large` true when a side is
 * over the size Pinwall renders; use the text diff then.
 */
export const MarkdownDiff = z.object({
  path: z.string(),
  too_large: z.boolean(),
  blocks: z.array(MarkdownBlockChange),
});
export type MarkdownDiff = z.infer<typeof MarkdownDiff>;

/** The query of the diff routes: two version numbers and, where a file is meant, its path. */
export const DiffQuery = z.object({
  from: z.coerce.number().int().min(1),
  to: z.coerce.number().int().min(1),
  path: z.string().min(1).max(1024).optional(),
});
export type DiffQuery = z.infer<typeof DiffQuery>;
