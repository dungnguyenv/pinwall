import type { Project, PublicConfig } from '../api/dto.ts';
import { fx } from './fixtures.ts';

/** Another person, who owns the projects shared with the signed-in fixture user. */
export const BOB = { id: 'usr_b', name: 'Bob Example' } as const;

/** `renderRoute`'s `config` for a server in `personal` mode. */
export const PERSONAL: Partial<PublicConfig> = { visibility: 'personal' };

/** A project of the signed-in fixture user's own space, as `personal` mode sends it. */
export function fxOwn(o: Partial<Project> = {}): Project {
  const me = fx.me();
  return fx.project({ role: 'owner', owner: { id: me.id, name: me.name }, ...o });
}

/** One of Bob's projects, shared with the signed-in fixture user as `role`. */
export function fxShared(role: 'editor' | 'viewer', o: Partial<Project> = {}): Project {
  return fx.project({ role, owner: { id: BOB.id, name: BOB.name }, ...o });
}
