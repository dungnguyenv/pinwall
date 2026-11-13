# Spaces, projects and members

How work is kept apart on a Pinwall where each person has a space of their own: what you can see,
how to work on a project with someone, how sharing outside Pinwall works, what counts against your
storage, and how to delete what you made. This guide is for the people who use a Pinwall. The people
who run one want [Running an open instance](open-instance.md).

- [Your space](#your-space)
- [Shared with me](#shared-with-me)
- [Project members](#project-members)
- [Sharing outside Pinwall](#sharing-outside-pinwall)
- [Usage and limits](#usage-and-limits)
- [Delete all my content](#delete-all-my-content)
- [Who can see your work](#who-can-see-your-work)

It all applies when your Pinwall runs with `PINWALL_VISIBILITY=personal`. With `team`, the default,
everyone who signs in sees every project, as in Pinwall 1.0: there are no members, no **Shared with
me** group and no **Delete all my content**. A quick way to tell which you have: in `personal` mode
every project page has a **Members** button. Usage limits and the rules for sharing outside Pinwall
apply in both modes, wherever the operator sets them.

## Your space

Your space is the set of projects you own. Only you see what is in it, and no other member does,
until you add people to a project or make a share link. Admins cannot either, see
[Who can see your work](#who-can-see-your-work).

- **A new space is empty.** Connect an agent, drop a file or a folder on the page, or create a
  project.
- **You get a project called "Default"** the first time you need one: when you publish without
  naming a project, or when you open the library for the first time. Everyone has a Default of their
  own, and an agent that publishes without a project puts the page there.
- **All artifacts** means everything you can see in your active projects: your own, and those in
  projects shared with you. Search and **Recent** show the same and nothing more.
- **Someone else's address looks like a missing one.** If a person sends you the address of a page
  in a project you are not in, Pinwall answers "not found", the same as for an address that does not
  exist. It never says that the page is there but off limits.
- **An artifact moves only between projects you own.**

## Shared with me

When an owner adds you to a project, it appears in the sidebar under **Shared with me**. The group
is there only once you have something shared. Each row shows the project's name, and under it the
owner's name and your role, joined by a dot, as in "Sam · Editor". The project's page says the same
in words: "You can publish here" for an editor, "You can view and comment" for a
viewer.

Its artifacts show up in **All artifacts**, search and **Recent** with your own. You can comment on
them whatever your role is. What else you can do depends on the role, see
[Project members](#project-members). An agent connected with your account sees these projects too,
with your role in each, and publishes into one only when you are an editor there.

## Project members

Each project has one owner, the person whose space it is. The owner can let other people into it,
and everyone in the project can see who they are: open the project and choose **Members**.

Which role to give:

| | Owner | Editor | Viewer |
| --- | --- | --- | --- |
| See the project, its artifacts, versions and comments, and search them | yes | yes | yes |
| Comment, reply, resolve and reopen threads | yes | yes | yes |
| Publish a new artifact or version, and restore a version | yes | yes | no |
| Rename, retag or delete an artifact or a version | all | only what they published | no |
| Delete other people's comments | yes | no | no |
| Make share links | yes | yes | no |
| Revoke share links | any in the project | only their own | no |
| Rename or archive the project, and edit its instructions for agents | yes | no | no |
| Add people, change a role, remove someone | yes | no | no |
| Leave the project | no | yes | yes |

People can edit and delete their own comments. Making share links is also subject to approval where
an admin requires it, see [Sharing outside Pinwall](#sharing-outside-pinwall). Editors' and viewers'
agents follow the project's instructions, but only the owner can edit them.

**Adding someone.** In **Members**, type the email address of the person, choose a role, **Editor**
or **Viewer**, and choose **Add**.

- The person must have signed in to Pinwall at least once. Pinwall sends no email and has no
  invitation links. When nobody has signed in with that address, it says so: ask the person to sign
  in once first, then add them. For an account that signs in through a company or Google login, the
  email has to be one that the login provider verified.
- When several accounts use the same email (the owner account and a single sign-on account can),
  **Which account?** lists them with their name and how each signs in, and you choose one.
- You cannot add yourself, and adding someone twice is refused: change their role instead.
- Looking up emails is limited to 30 an hour, because the answer shows whether an address has an
  account.

**Changing a role and removing someone.** The owner changes a person's role in the list, or
removes them with the bin button beside their name, after a confirmation.

**Leaving.** Anyone who is not the owner has **Leave project** in **Members**. Only the owner can
add you again. An owner cannot leave their own project.

When someone is removed, or leaves, it takes effect at once:

- the pages they had open stop loading, and their live updates end;
- the share links they made in the project stop working, for good;
- their unused upload links for the project stop working;
- their comments stay, and so do the artifacts they published. The artifacts belong to the project.

When the owner changes an editor to a viewer, the share links that person made in the project are
revoked as well, because viewers cannot make them. Nothing else of theirs changes.

## Sharing outside Pinwall

Everything above happens inside Pinwall, with accounts. A **share link** is how a page reaches
someone with no account. It works as it did in Pinwall 1.0: it shows the latest version or one fixed
version of one artifact, optionally with a password, an expiry date and guest comments, and it
reaches nothing else in your space. In the artifact's share dialog the owner and the editors of the
project make links. Viewers cannot, and the dialog says so. The owner can revoke any link in the
project, and an editor the ones they made. A link stops when the person who made it loses access to
the project.

Pinwall also hands out short-lived addresses for review and for raw pages. They stop working after a
while (12 hours by default), so open an artifact through Pinwall rather than keeping such an
address.

**Where an admin has to approve you.** A Pinwall that is open to the public can allow only admins
and the people an admin has approved to expose pages outside Pinwall
([Who may share outside Pinwall](open-instance.md#who-may-share-outside-pinwall)). Until you are
approved:

- the share dialog says "Sharing outside Pinwall needs an admin's approval" in place of the form.
  Links you made before still list, and you can revoke them, but they do not open until an admin
  approves you;
- in the review menu, **Raw page not available** stands in for **Open raw page**, and there is no
  raw link to copy;
- your pages open only inside Pinwall's own viewer, full screen included. They do not open as a page
  of their own at an address you could pass on;
- frames that a page embeds from its own files do not load in the viewer yet. The page loads and its
  frame shows an error, see [Writing pages](authoring.md#links-frames-and-anchors).

Reviewing, commenting and working with project members are not affected. An admin approves you, so
ask one. An agent that cannot make a share link has the same cause, see
[Connect an agent](connect-an-agent.md#troubleshooting).

## Usage and limits

**Settings → Usage** shows what your space holds against what it may hold: your **Storage** and your
**Artifacts**. The page is there in `personal` mode, and wherever a limit applies to you. A figure
with no limit says "(no limit)" after what is used. A bar turns to a warning at 90 percent, and at
the limit the page says "Your space is full. Publishing stops until you delete versions or
artifacts, or an admin gives you more room."

- **Every version counts at its full size,** even when it shares files with another version. That
  makes the number easy to predict.
- **It counts every version in the projects you own,** and that includes what editors publish there.
  An editor's publish is checked against the owner's limit, not the editor's, so you choose who gets
  to fill your space. A project you are an editor in costs you nothing.
- **Artifacts are counted the same way.**
- **Deleting versions or artifacts frees the space.**
- **On a Pinwall in `team` mode** the numbers are about what you published, since projects are
  shared there.
- **Admins have no limits.** An admin can set other limits for one person.

A publish that does not fit is refused with the error `quota_exceeded` (HTTP 413). It creates no
version and leaves nothing behind. The message says how much is used, what the limit is and how much
the version needed, and when the space that is full is the project owner's, it says whose. Publishing
is also limited in rate, and Pinwall asks you to wait when you hit it, see
[Quotas and rate limits](open-instance.md#quotas-and-rate-limits). An agent sees the same numbers
through `whoami`, so it can warn you before it publishes something large.

## Delete all my content

At the bottom of **Settings → Usage** is **Delete all my content**, in `personal` mode. It removes
what you made in one go.

1. Choose **Delete all my content**.
2. Type your email address, in any letter case, to confirm. An account without an email types its
   account id, which the dialog shows.
3. Choose **Delete everything**.

**What goes.** Every project you own, Default included, with all their artifacts and versions, the
comments on them and their share links, which from then on answer that they are gone. That covers
what editors published into your projects and what people commented there, and the people you added
lose the projects. Their files are removed from storage. It cannot be undone, so keep a copy of
anything you still need first.

**What stays.** The projects other people shared with you, and what you published into them, which
belongs to those projects. Your Pinwall account stays as it is, and so does your account at the
identity provider, which Pinwall never touches. You land on an empty library, and a new Default
project appears when you next need it.

If an agent keeps publishing while the deletion runs, Pinwall may ask you to try again. What it
already deleted stays deleted, and running it again finishes the job.

## Who can see your work

- **You,** and nobody else, until you add project members or make share links. The people you add
  see that project, and what they may do in it depends on their role. A share link opens only what
  you made it for.
- **Admins cannot browse it.** They manage accounts: they see how many projects, artifacts and
  versions a person has and how much they store, set limits, approve sharing, block an account and
  delete everything it owns. They can look up who made a link that someone reported, to learn whose
  it is and what it points to. None of that shows your pages, files or comments, and an admin cannot
  move your space into their own account.
- **The operator can.** Whoever runs your Pinwall also runs its database and its storage, and can
  read them, as with any self-hosted service. Only the operator can move a whole space to another
  account, from the command line
  ([Moving work between people](open-instance.md#moving-work-between-people)).
