/**
 * The title and description each MCP tool is listed with. They are protocol text for the model
 * that calls the tools, not UI copy, so they stay here as constants rather than in `en.json`.
 * Tool modules register under the same keys.
 */
export const DESCRIPTIONS = {
  whoami: {
    title: 'Who am I',
    description:
      'Shows which Pinwall account this connection acts as (name, email, role) and whether it ' +
      'signed in with OAuth or an API token, the address of this Pinwall, its isolation mode, ' +
      'the size limits for one publish, for an inline publish, for one file and for one ' +
      'version, the most files a version may hold, how long an upload URL stays valid, and ' +
      'notes on writing pages that work once published. Call it when you need those limits or ' +
      'are unsure which account you are using.',
  },
  list_projects: {
    title: 'List projects',
    description:
      'Lists the projects in this Pinwall, the default project first, with the number of ' +
      'artifacts in each. Use it to find the id of the project a page belongs in. Archived ' +
      'projects are left out unless you ask for them.',
  },
  get_project: {
    title: 'Get a project',
    description:
      'Returns one project with the instructions its owners wrote for agents that publish ' +
      'into it. Call it before you publish, and follow those instructions for everything you ' +
      'publish in the project. Without project_id it reads the default project.',
  },
  create_project: {
    title: 'Create a project',
    description:
      'Creates a project, a group of related artifacts that can carry instructions for the ' +
      'agents publishing into it (language, colors, structure). Use it when the user asks for ' +
      'a new project or when none of the existing ones fits.',
  },
  list_artifacts: {
    title: 'List artifacts',
    description:
      'Lists artifacts, the most recently updated first, optionally only those of one project ' +
      'or with one tag. Each one shows its current version, its open comment threads and its ' +
      'review link. Artifacts of archived projects appear only when you name that project.',
  },
  search_artifacts: {
    title: 'Search artifacts',
    description:
      'Finds artifacts by words in their name, tags or text; accents and capital letters do ' +
      'not matter, and each word may be the start of a longer one. Use it when the user ' +
      'describes a page without giving its id. The best matches come first.',
  },
  get_artifact: {
    title: 'Get an artifact',
    description:
      'Returns one artifact with its newest versions, the latest first, and the review and ' +
      'raw links of each. Call it before you publish a new version of an existing artifact: ' +
      'the publish must name the current version id it shows.',
  },
} as const;

/** What the arguments that several tools share mean. */
export const FIELDS = {
  projectId: 'The id of a project (prj_...), from list_projects.',
  artifactId: 'The id of an artifact (art_...), from list_artifacts or search_artifacts.',
  cursor: 'The next_cursor of the previous page, to continue the list.',
} as const;
