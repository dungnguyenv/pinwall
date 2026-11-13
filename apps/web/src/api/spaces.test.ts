import { expect, test } from 'vitest';
import { fx } from '../test/fixtures.ts';
import { BOB, fxOwn, fxShared } from '../test/spaces.ts';
import {
  mayExpose,
  NO_RIGHTS,
  ownDefaultProject,
  type Rights,
  rightsFor,
  type Standing,
  splitProjects,
  standingOf,
} from './spaces.ts';

const me = fx.me({ role: 'member' });
const admin = fx.me({ role: 'admin' });

/** An artifact published by the signed-in person or by Bob, with `can_manage` as sent. */
const artifact = (by: 'me' | 'other', canManage?: boolean) => ({
  created_by: by === 'me' ? me.id : BOB.id,
  can_manage: canManage,
});

const mine = { created_by: { user_id: me.id, name: me.name } };
const bobs = { created_by: { user_id: BOB.id, name: BOB.name } };
const orphan = { created_by: null };
/** Whether `r` revokes my link, Bob's link and a link whose maker is gone. */
const revokes = (r: Rights) => [r.revokeLink(mine), r.revokeLink(bobs), r.revokeLink(orphan)];

test.each<[Standing, 'me' | 'other', boolean | undefined, boolean, boolean, boolean, boolean]>([
  // standing, artifact.created_by, can_manage, publish, deleteArtifact, deleteOthersComments, createShareLinks
  ['team', 'me', undefined, true, true, true, true],
  ['team', 'other', undefined, true, false, false, true],
  ['owner', 'other', true, true, true, true, true],
  ['editor', 'me', true, true, true, false, true],
  ['editor', 'other', false, true, false, false, true],
  ['viewer', 'other', false, false, false, false, false],
  [null, 'me', true, false, false, false, false],
])(
  'rightsFor %s on an artifact by %s',
  (standing, by, canManage, publish, deleteArtifact, deleteOthersComments, createShareLinks) => {
    const r = rightsFor(me, artifact(by, canManage), standing);
    expect({
      publish: r.publish,
      deleteArtifact: r.deleteArtifact,
      deleteOthersComments: r.deleteOthersComments,
      createShareLinks: r.createShareLinks,
    }).toEqual({ publish, deleteArtifact, deleteOthersComments, createShareLinks });
    // Only the owner, and everyone in team mode, changes the project itself.
    expect(r.manageProject).toBe(standing === 'team' || standing === 'owner');
  },
);

test('rightsFor team as an admin deletes and moderates what others published, as in 1.0', () => {
  const r = rightsFor(admin, artifact('other'), 'team');
  expect(r.deleteArtifact).toBe(true);
  expect(r.deleteOthersComments).toBe(true);
});

test('deleteVersion: never the last one; an editor only their own', () => {
  const byMe = { created_by: me.id };
  const byBob = { created_by: BOB.id };

  const owner = rightsFor(me, artifact('other', true), 'owner');
  expect(owner.deleteVersion(byBob, 2)).toBe(true);
  expect(owner.deleteVersion(byBob, 1)).toBe(false);

  const editor = rightsFor(me, artifact('other', false), 'editor');
  expect(editor.deleteVersion(byMe, 2)).toBe(true);
  expect(editor.deleteVersion(byMe, 1)).toBe(false);
  expect(editor.deleteVersion(byBob, 2)).toBe(false);
  expect(editor.deleteVersion(null, 2)).toBe(false);

  // 1.0: whoever may delete the artifact deletes any version but the last.
  const team = rightsFor(admin, artifact('other'), 'team');
  for (const v of [byMe, byBob, null]) {
    expect(team.deleteVersion(v, 2)).toBe(true);
    expect(team.deleteVersion(v, 1)).toBe(false);
  }
  expect(rightsFor(me, artifact('other'), 'team').deleteVersion(byMe, 2)).toBe(false);

  for (const standing of ['viewer', null] as const) {
    expect(rightsFor(me, artifact('me', true), standing).deleteVersion(byMe, 2)).toBe(false);
  }
});

test('revokeLink: team by the 1.0 rule, owner any, editor their own, viewer none', () => {
  // 1.0: the link's maker, the artifact's publisher, or an admin.
  expect(revokes(rightsFor(me, artifact('other'), 'team'))).toEqual([true, false, false]);
  expect(revokes(rightsFor(me, artifact('me'), 'team'))).toEqual([true, true, true]);
  expect(revokes(rightsFor(admin, artifact('other'), 'team'))).toEqual([true, true, true]);

  expect(revokes(rightsFor(me, artifact('other', true), 'owner'))).toEqual([true, true, true]);
  // Publishing the artifact gives an editor no say over other people's links.
  expect(revokes(rightsFor(me, artifact('me', true), 'editor'))).toEqual([true, false, false]);
  expect(revokes(rightsFor(me, artifact('me', true), 'viewer'))).toEqual([false, false, false]);
  expect(revokes(rightsFor(me, artifact('me', true), null))).toEqual([false, false, false]);
});

test('without an artifact, rights hold the project-level flags only', () => {
  const flags = (r: Rights) => ({
    publish: r.publish,
    manageProject: r.manageProject,
    createShareLinks: r.createShareLinks,
    deleteArtifact: r.deleteArtifact,
    deleteOthersComments: r.deleteOthersComments,
    deleteVersion: r.deleteVersion({ created_by: me.id }, 2),
    revokeLink: r.revokeLink(mine),
  });
  const artifactFlags = {
    deleteArtifact: false,
    deleteOthersComments: false,
    deleteVersion: false,
    revokeLink: false,
  };
  expect(flags(rightsFor(admin, null, 'team'))).toEqual({
    publish: true,
    manageProject: true,
    createShareLinks: true,
    ...artifactFlags,
  });
  expect(flags(rightsFor(me, null, 'owner'))).toEqual({
    publish: true,
    manageProject: true,
    createShareLinks: true,
    ...artifactFlags,
  });
  expect(flags(rightsFor(me, null, 'editor'))).toEqual({
    publish: true,
    manageProject: false,
    createShareLinks: true,
    ...artifactFlags,
  });
  expect(flags(rightsFor(me, null, 'viewer'))).toEqual(flags(NO_RIGHTS));
});

test('NO_RIGHTS allows nothing', () => {
  expect(NO_RIGHTS).toMatchObject({
    publish: false,
    manageProject: false,
    deleteArtifact: false,
    deleteOthersComments: false,
    createShareLinks: false,
  });
  expect(NO_RIGHTS.deleteVersion({ created_by: me.id }, 5)).toBe(false);
  expect(NO_RIGHTS.revokeLink(mine)).toBe(false);
});

test('standingOf: team at once; in personal mode the project role, or null until it is known', () => {
  expect(standingOf('team', undefined)).toBe('team');
  expect(standingOf('team', fxShared('viewer'))).toBe('team');
  expect(standingOf('personal', undefined)).toBeNull();
  expect(standingOf('personal', fxOwn())).toBe('owner');
  expect(standingOf('personal', fxShared('editor'))).toBe('editor');
  expect(standingOf('personal', fxShared('viewer'))).toBe('viewer');
  // A project without a role, which personal mode never sends, gives no rights.
  expect(standingOf('personal', fx.project())).toBeNull();
});

test('mayExpose: absent and true allow, false refuses', () => {
  expect(mayExpose(fx.me())).toBe(true);
  expect(mayExpose(fx.me({ can_create_share_links: true }))).toBe(true);
  expect(mayExpose(fx.me({ can_create_share_links: false }))).toBe(false);
});

test('ownDefaultProject skips a default project shared with me', () => {
  expect(
    ownDefaultProject([
      fxShared('editor', { id: 'prj_b', is_default: true }),
      fxOwn({ id: 'prj_d', is_default: true }),
    ])?.id,
  ).toBe('prj_d');
  expect(ownDefaultProject([fx.project({ is_default: true })])?.id).toBe('prj_1'); // team: no role
  expect(ownDefaultProject([fxShared('viewer', { is_default: true })])).toBeUndefined();
  expect(ownDefaultProject([fxOwn()])).toBeUndefined();
  expect(ownDefaultProject(undefined)).toBeUndefined();
});

test('splitProjects: my own (or, in team mode, every one) apart from those shared with me', () => {
  const own = fxOwn({ id: 'prj_o' });
  const editing = fxShared('editor', { id: 'prj_e' });
  const viewing = fxShared('viewer', { id: 'prj_v' });
  const team = fx.project({ id: 'prj_t' });
  const split = splitProjects([editing, own, viewing, team]);
  expect(split.own.map((p) => p.id)).toEqual(['prj_o', 'prj_t']);
  expect(split.shared.map((p) => p.id)).toEqual(['prj_e', 'prj_v']);
});
