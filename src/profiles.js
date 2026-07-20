const PROFILE_VERSION = '1.0.0';

export const ARTIFACT_ROLES = Object.freeze([
  { id: 'unclassified', meaning: 'Durable intake that still needs a Project or final role.', class: 'input' },
  { id: 'raw_input', meaning: 'Original user or external input preserved without semantic rewriting.', class: 'input' },
  { id: 'source', meaning: 'Reference material used as evidence or context.', class: 'input' },
  { id: 'note', meaning: 'A durable personal knowledge note that is not yet a formal output.', class: 'working' },
  { id: 'journal', meaning: 'A time-oriented personal record.', class: 'working' },
  { id: 'draft', meaning: 'A human-reviewable work in progress.', class: 'working' },
  { id: 'intermediate', meaning: 'A generated or transformed step that supports a later output.', class: 'working' },
  { id: 'report', meaning: 'A reviewable deliverable that summarizes or analyzes inputs.', class: 'output' },
  { id: 'canonical', meaning: 'The currently accepted authoritative result.', class: 'output' },
  { id: 'index', meaning: 'A durable map or entry point for other Artifacts.', class: 'output' },
  { id: 'template', meaning: 'A reusable pattern rather than a task-specific result.', class: 'support' },
  { id: 'archive', meaning: 'A retained Artifact no longer active in daily work.', class: 'archive' },
]);

export const ROLE_TRANSITIONS = Object.freeze({
  unclassified: ['raw_input', 'source', 'note', 'journal', 'draft', 'archive'],
  raw_input: ['source', 'note', 'draft', 'intermediate', 'archive'],
  source: ['note', 'draft', 'intermediate', 'report', 'archive'],
  note: ['draft', 'intermediate', 'report', 'canonical', 'archive'],
  journal: ['note', 'report', 'archive'],
  draft: ['intermediate', 'report', 'canonical', 'archive'],
  intermediate: ['draft', 'report', 'canonical', 'archive'],
  report: ['canonical', 'archive'],
  canonical: ['archive'],
  index: ['archive'],
  template: ['archive'],
  archive: [],
});

const roles = new Set(ARTIFACT_ROLES.map((role) => role.id));

function area(role, defaultPath, purpose, {
  aliases = [], required = true, accepts = [], nested = [],
} = {}) {
  return {
    role,
    default_path: defaultPath,
    aliases: [...new Set([defaultPath, ...aliases])],
    purpose,
    required,
    durability: 'durable',
    accepts,
    nested,
  };
}

const profiles = [
  {
    id: 'mixed-minimal',
    version: PROFILE_VERSION,
    name: 'Mixed Minimal',
    summary: 'A small, reversible baseline for a mixed or disordered personal library.',
    suitable_for: ['The library purpose is still unclear.', 'The user wants the fewest durable top-level areas.', 'Projects and reference material are mixed together today.'],
    not_suitable_for: ['A mature PARA system already exists.', 'Research or delivery workflows need dedicated stages.'],
    source_mutation_policy: 'recommend_only',
    areas: [
      area('inbox', 'Inbox', 'Durable intake awaiting classification; never treated as disposable Temp.', {
        aliases: ['00 Inbox', '未整理', '收件箱'], accepts: ['unclassified', 'raw_input'],
      }),
      area('projects', 'Projects', 'Active outcomes with an owner, intent, or completion condition.', {
        aliases: ['Project', '项目', '项目库'], accepts: ['draft', 'intermediate', 'report', 'canonical', 'index'],
      }),
      area('library', 'Library', 'Reusable sources, notes, templates, and reference material.', {
        aliases: ['Resources', 'Notes', '资料库', '资源'], accepts: ['source', 'note', 'template'],
      }),
      area('archive', 'Archive', 'Inactive but retained material with history preserved.', {
        aliases: ['Archives', '归档'], accepts: ['archive'],
      }),
    ],
    derived_routes: {
      raw_input: { area: 'projects', project_subdirectory: null },
      source: { area: 'projects', project_subdirectory: null },
      note: { area: 'projects', project_subdirectory: null },
      draft: { area: 'projects', project_subdirectory: null },
      intermediate: { area: 'projects', project_subdirectory: null },
      report: { area: 'projects', project_subdirectory: null },
      canonical: { area: 'projects', project_subdirectory: null },
      index: { area: 'projects', project_subdirectory: null },
      template: { area: 'projects', project_subdirectory: null },
    },
  },
  {
    id: 'personal-knowledge',
    version: PROFILE_VERSION,
    name: 'Personal Knowledge',
    summary: 'A personal knowledge system that separates active commitments, ongoing areas, references, and time-based notes.',
    suitable_for: ['The library contains life areas and long-running responsibilities.', 'Daily or journal notes are important.', 'The user wants a PARA-like separation without forced migration.'],
    not_suitable_for: ['Most files are deliverables for a small number of client or software projects.'],
    source_mutation_policy: 'recommend_only',
    areas: [
      area('inbox', 'Inbox', 'Durable unclassified intake.', { aliases: ['00 Inbox', '未整理', '收件箱'], accepts: ['unclassified', 'raw_input'] }),
      area('projects', 'Projects', 'Active efforts with a finite outcome.', { aliases: ['项目'], accepts: ['draft', 'intermediate', 'report', 'canonical', 'index'] }),
      area('areas', 'Areas', 'Ongoing responsibilities without a fixed completion date.', { aliases: ['领域', '职责'], accepts: ['note', 'canonical', 'index'] }),
      area('resources', 'Resources', 'Reusable source and reference material.', { aliases: ['Library', 'Notes', '资料', '资源'], accepts: ['source', 'note', 'template'] }),
      area('journal', 'Journal', 'Daily, weekly, and other time-oriented personal records.', { aliases: ['Daily', 'Diary', '日志', '日记'], accepts: ['journal'] }),
      area('archive', 'Archive', 'Inactive retained material.', { aliases: ['Archives', '归档'], accepts: ['archive'] }),
    ],
    derived_routes: {
      raw_input: { area: 'projects', project_subdirectory: null },
      source: { area: 'projects', project_subdirectory: null },
      note: { area: 'projects', project_subdirectory: null },
      journal: { area: 'projects', project_subdirectory: null },
      draft: { area: 'projects', project_subdirectory: null },
      intermediate: { area: 'projects', project_subdirectory: null },
      report: { area: 'projects', project_subdirectory: null },
      canonical: { area: 'projects', project_subdirectory: null },
      index: { area: 'projects', project_subdirectory: null },
      template: { area: 'projects', project_subdirectory: null },
    },
  },
  {
    id: 'project-work',
    version: PROFILE_VERSION,
    name: 'Project Work',
    summary: 'A delivery-oriented layout that separates project sources, working files, and approved outputs.',
    suitable_for: ['Most files belong to active projects or client work.', 'Generated drafts must stay separate from formal outputs.', 'Templates are shared across projects.'],
    not_suitable_for: ['The library is mainly a journal or research corpus without stable projects.'],
    source_mutation_policy: 'recommend_only',
    areas: [
      area('inbox', 'Inbox', 'Durable intake before assignment to a Project.', { aliases: ['00 Inbox', '未整理', '收件箱'], accepts: ['unclassified', 'raw_input'] }),
      area('projects', 'Projects', 'Active Project roots; each Project may use Sources, Working, and Outputs.', {
        aliases: ['Project', '项目'], accepts: ['source', 'draft', 'intermediate', 'report', 'canonical', 'index'],
        nested: [
          { path: 'Sources', purpose: 'Project-specific raw and reference inputs.', accepts: ['raw_input', 'source'] },
          { path: 'Working', purpose: 'Drafts and generated intermediate files.', accepts: ['note', 'draft', 'intermediate'] },
          { path: 'Outputs', purpose: 'Reviewed reports and canonical deliverables.', accepts: ['report', 'canonical', 'index'] },
        ],
      }),
      area('templates', 'Templates', 'Reusable templates shared across Projects.', { aliases: ['模板'], accepts: ['template'] }),
      area('archive', 'Archive', 'Completed or inactive Projects retained with history.', { aliases: ['Archives', '归档'], accepts: ['archive'] }),
    ],
    derived_routes: {
      raw_input: { area: 'projects', project_subdirectory: 'Sources' },
      source: { area: 'projects', project_subdirectory: 'Sources' },
      note: { area: 'projects', project_subdirectory: 'Working' },
      draft: { area: 'projects', project_subdirectory: 'Working' },
      intermediate: { area: 'projects', project_subdirectory: 'Working' },
      report: { area: 'projects', project_subdirectory: 'Outputs' },
      canonical: { area: 'projects', project_subdirectory: 'Outputs' },
      index: { area: 'projects', project_subdirectory: 'Outputs' },
      template: { area: 'projects', project_subdirectory: 'Working' },
    },
  },
  {
    id: 'research-writing',
    version: PROFILE_VERSION,
    name: 'Research & Writing',
    summary: 'A source-to-synthesis workflow for literature, notes, arguments, and publishable outputs.',
    suitable_for: ['The user collects many references or papers.', 'Evidence, notes, synthesis, and outputs must remain distinguishable.', 'Multiple inputs are repeatedly merged into writing.'],
    not_suitable_for: ['The library is primarily task delivery with little source analysis.'],
    source_mutation_policy: 'recommend_only',
    areas: [
      area('inbox', 'Inbox', 'Durable unclassified research intake.', { aliases: ['00 Inbox', '未整理'], accepts: ['unclassified', 'raw_input'] }),
      area('sources', 'Sources', 'Original references and evidence.', { aliases: ['References', 'Literature', '文献', '资料'], accepts: ['raw_input', 'source'] }),
      area('notes', 'Notes', 'Atomic or reading notes tied to sources.', { aliases: ['Reading Notes', '笔记'], accepts: ['note'] }),
      area('synthesis', 'Synthesis', 'Claims, comparisons, outlines, and intermediate reasoning.', { aliases: ['Working', 'Analysis', '综合', '分析'], accepts: ['draft', 'intermediate'] }),
      area('outputs', 'Outputs', 'Reviewed reports, papers, and canonical results.', { aliases: ['Writing', 'Papers', '成果', '输出'], accepts: ['report', 'canonical', 'index'] }),
      area('archive', 'Archive', 'Inactive retained research material.', { aliases: ['Archives', '归档'], accepts: ['archive'] }),
    ],
    derived_routes: {
      raw_input: { area: 'sources', project_subdirectory: 'Sources' },
      source: { area: 'sources', project_subdirectory: 'Sources' },
      note: { area: 'notes', project_subdirectory: 'Notes' },
      draft: { area: 'synthesis', project_subdirectory: 'Synthesis' },
      intermediate: { area: 'synthesis', project_subdirectory: 'Synthesis' },
      report: { area: 'outputs', project_subdirectory: 'Outputs' },
      canonical: { area: 'outputs', project_subdirectory: 'Outputs' },
      index: { area: 'outputs', project_subdirectory: 'Outputs' },
      template: { area: 'synthesis', project_subdirectory: 'Synthesis' },
    },
  },
];

function clone(value) {
  return structuredClone(value);
}

export function listLibraryProfiles() {
  return clone(profiles);
}

export function getLibraryProfile(profileId) {
  const profile = profiles.find((item) => item.id === profileId);
  if (!profile) throw new Error(`Unknown library profile: ${profileId}`);
  return clone(profile);
}

export function getArtifactRole(roleId) {
  const role = ARTIFACT_ROLES.find((item) => item.id === roleId);
  if (!role) {
    throw new Error(`Derived role must be a supported role: ${[...roles].join(', ')}.`);
  }
  return clone(role);
}

function topLevelDirectories(entries) {
  return entries
    .filter((entry) => entry.kind === 'directory' && !entry.path.includes('/'))
    .map((entry) => entry.path)
    .sort((left, right) => left.localeCompare(right));
}

function mapProfile(profile, directories) {
  return profile.areas.map((definition) => {
    const aliasSet = new Set(definition.aliases.map((alias) => alias.normalize('NFC').toLowerCase()));
    const candidates = directories.filter((directory) => aliasSet.has(directory.normalize('NFC').toLowerCase()));
    return {
      area_role: definition.role,
      purpose: definition.purpose,
      accepts: definition.accepts,
      required: definition.required,
      default_path: definition.default_path,
      status: candidates.length === 1 ? 'mapped' : candidates.length > 1 ? 'ambiguous' : 'missing',
      existing_path: candidates.length === 1 ? candidates[0] : null,
      candidates,
      suggested_path: candidates.length ? null : definition.default_path,
    };
  });
}

function scoreProfile(profile, mappings) {
  const matched = mappings.filter((mapping) => mapping.status === 'mapped');
  const ambiguous = mappings.filter((mapping) => mapping.status === 'ambiguous');
  let score = profile.id === 'mixed-minimal' ? 1 : 0;
  score += matched.length * 4;
  score -= ambiguous.length;
  const distinctive = new Set({
    'personal-knowledge': ['areas', 'journal', 'resources'],
    'project-work': ['projects', 'templates'],
    'research-writing': ['sources', 'synthesis', 'outputs'],
    'mixed-minimal': ['library'],
  }[profile.id]);
  score += matched.filter((mapping) => distinctive.has(mapping.area_role)).length * 4;
  return {
    score,
    evidence: matched.map((mapping) => ({
      signal: 'existing_directory_alias', area_role: mapping.area_role, path: mapping.existing_path,
    })),
  };
}

function structurePlan(profile, mappings) {
  return {
    version: 'atlas-structure-plan.v1',
    profile_id: profile.id,
    profile_version: profile.version,
    read_only: true,
    source_changes: [],
    operations: mappings.map((mapping) => ({
      operation: mapping.status === 'mapped'
        ? 'map_existing_directory'
        : mapping.status === 'ambiguous'
          ? 'review_directory_mapping'
          : 'suggest_directory_create',
      area_role: mapping.area_role,
      current_path: mapping.existing_path,
      candidates: mapping.candidates,
      proposed_path: mapping.suggested_path,
      reason: mapping.purpose,
      execution: 'not_authorized',
    })),
    exclusions: [
      'No source file or directory is created, moved, renamed, or rewritten.',
      'Inbox is durable intake and is not part of Temp cleanup.',
      'Agent candidates belong in Atlas .atlas/work until captured by a governed run.',
    ],
  };
}

export function recommendLibraryProfile(entries, { profileId = null } = {}) {
  const directories = topLevelDirectories(entries);
  const scored = profiles.map((profile) => {
    const mappings = mapProfile(profile, directories);
    return { profile, mappings, ...scoreProfile(profile, mappings) };
  }).sort((left, right) => right.score - left.score
    || profiles.indexOf(left.profile) - profiles.indexOf(right.profile));
  const selected = profileId
    ? scored.find((item) => item.profile.id === profileId)
    : scored[0];
  if (!selected) throw new Error(`Unknown library profile: ${profileId}`);
  const runnerUp = scored.find((item) => item.profile.id !== selected.profile.id);
  const automaticConfidence = Math.max(
    0.5,
    Math.min(0.95, 0.58 + Math.max(0, selected.score - (runnerUp?.score ?? 0)) * 0.04),
  );
  return {
    profile: clone(selected.profile),
    selection: profileId ? 'user_selected_candidate' : 'deterministic_recommendation',
    confidence: profileId ? 1 : automaticConfidence,
    evidence: profileId
      ? [{ signal: 'explicit_profile_request', profile_id: profileId }]
      : selected.evidence,
    alternatives: scored
      .filter((item) => item.profile.id !== selected.profile.id)
      .map((item) => ({ profile_id: item.profile.id, score: item.score })),
    mappings: clone(selected.mappings),
    structure_plan: structurePlan(selected.profile, selected.mappings),
  };
}
