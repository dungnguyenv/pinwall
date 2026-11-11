import { z } from 'zod';
import { Label, page, Timestamp } from './common.ts';

/** What the agent reads about a project before it publishes into it. */
const Instructions = z.string().max(20_000);

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  instructions: z.string(),
  /** The project publishes without a project go to. It cannot be archived. */
  is_default: z.boolean(),
  /** When the project was archived; `null` while it is active. */
  archived_at: Timestamp.nullable(),
  /** Artifacts in the project, whatever their state. */
  artifact_count: z.number().int(),
  created_at: Timestamp,
  updated_at: Timestamp,
});
export type Project = z.infer<typeof Project>;

export const ProjectList = page(Project);
export type ProjectList = z.infer<typeof ProjectList>;

export const CreateProjectRequest = z.object({
  name: Label,
  instructions: Instructions.optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

/** Only the fields given change. `archived: true` archives, `false` brings the project back. */
export const UpdateProjectRequest = z.object({
  name: Label.optional(),
  instructions: Instructions.optional(),
  archived: z.boolean().optional(),
});
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;
