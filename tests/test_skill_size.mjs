// suite: skill size (every desk SKILL.md a core of 20 KB or less, and its reference files resolve)
// covers: skills/desk-*/** agents/**
// Every skills/desk-*/SKILL.md is at most 20,480 bytes unless it is on UNSPLIT, every
// `references/<file>.md` a core names exists, and every file under a skill's references/ is named
// by some file of that skill. Each desk-autopilot worker-contract-stage-*.md is held to the same cap,
// and every file it names exists. Every agents/*.md description, listed in full in every session,
// is at most 600 characters and keeps its trigger phrase. Each check is also run on made-up input,
// to prove it can fail.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CAP = 20480;
// The skills over the cap that are not split yet (DS-228's children). Each split takes its skill
// off; a listed skill is not size-checked, so feature tickets can still grow it until then.
const UNSPLIT = ['desk-autopilot', 'desk-ci'];
// Reference files install.sh writes from another file in the checkout, so they are not in skills/.
const INSTALLED = { 'desk-setup/references/desk-config.template.md': 'desk-config.md' };

// A skill is { name, core, refs: [file names under references/], files: { path in the skill: text } }.
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const loadSkills = (dir) => readdirSync(dir).filter((n) => n.startsWith('desk-') && existsSync(join(dir, n, 'SKILL.md'))).sort().map((name) => {
  const d = join(dir, name);
  const files = Object.fromEntries(walk(d).map((p) => [relative(d, p), readFileSync(p, 'utf8')]));
  return { name, core: files['SKILL.md'], refs: Object.keys(files).filter((p) => p.startsWith('references/')).map((p) => p.slice('references/'.length)), files };
});

// AC1, AC3: each core is within the cap unless listed, and a listed core within it must come off.
const sizeProblems = (skills, unsplit) => [
  ...skills.flatMap(({ name, core }) => {
    const bytes = Buffer.byteLength(core);
    if (unsplit.includes(name)) return bytes <= CAP ? [`${name}/SKILL.md is ${bytes} bytes, within the ${CAP}-byte cap: take ${name} off UNSPLIT`] : [];
    return bytes > CAP ? [`${name}/SKILL.md is ${bytes} bytes, over the ${CAP}-byte cap`] : [];
  }),
  ...unsplit.filter((n) => !skills.some((s) => s.name === n)).map((n) => `UNSPLIT names ${n}, which is not a desk skill: take it off`),
];

// AC4: the references/<file>.md paths a core names. One written as `desk-x/references/…` or
// "desk-x's `references/…`" is desk-x's; any other is the core's own skill's.
const cited = (name, core) => [...core.replace(/\s+/g, ' ').matchAll(/(?:(desk-[\w-]+)(?:\/|`?'s `))?references\/([\w.-]+\.md)/g)].map((m) => ({ owner: m[1] || name, file: m[2] }));
const refProblems = (skills, installed) => skills.flatMap(({ name, core }) => cited(name, core).flatMap(({ owner, file }) => {
  const path = `${owner}/references/${file}`;
  if (skills.find((s) => s.name === owner)?.refs.includes(file) || installed(path)) return [];
  return [`${name}/SKILL.md names ${owner === name ? '' : `${owner}/`}references/${file}, which is not in skills/${owner}/references/`];
}));

// AC5: each reference file is named, by its file name, in some other file of its skill.
const orphanProblems = (skills) => skills.flatMap(({ name, refs, files }) => refs.filter((f) =>
  !Object.entries(files).some(([p, text]) => p !== `references/${f}` && text.includes(basename(f)))).map((f) => `skills/${name}/references/${f} is named by no file of ${name}`));

// Each worker contract stage file is a core too, read whole by every worker that reaches its
// stage. A stage is { file, text }, its file name under desk-autopilot/references/.
const STAGES = 'desk-autopilot/references';
const loadStages = (dir) => readdirSync(join(dir, STAGES)).filter((f) => /^worker-contract-stage-.*\.md$/.test(f)).sort().map((file) => ({ file, text: readFileSync(join(dir, STAGES, file), 'utf8') }));
// AC1, AC2: each is within the cap, and one over it fails naming the file and its size.
const stageSizeProblems = (stages) => stages.flatMap(({ file, text }) => {
  const bytes = Buffer.byteLength(text);
  return bytes > CAP ? [`${STAGES}/${file} is ${bytes} bytes, over the ${CAP}-byte cap`] : [];
});
// AC4: the files a stage file names exist: a `references/<file>.md` (its own skill's unless written
// as another's, as for a core), and a sibling `worker-contract-<…>.md` it sends the worker to.
const stageRefProblems = (stages, skills) => stages.flatMap(({ file, text }) => [
  ...cited('desk-autopilot', text).map(({ owner, file: f }) => ({ owner, f })),
  ...[...new Set(text.match(/worker-contract-[\w-]+\.md/g) || [])].map((f) => ({ owner: 'desk-autopilot', f })),
].filter(({ owner, f }) => !skills.find((s) => s.name === owner)?.refs.includes(f)).map(({ owner, f }) => `${STAGES}/${file} names ${owner}/references/${f}, which is not in skills/${owner}/references/`));

// Each agent install.sh copies into ~/.claude/agents is listed by its description in every
// session; its worked examples belong in the body, which loads only when the agent runs.
// An agent is { name, text }, its file name under agents/ without .md.
const AGENT_CAP = 600;
const loadAgents = (dir) => readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => ({ name: f.slice(0, -3), text: readFileSync(join(dir, f), 'utf8') }));
// The frontmatter's one-line description: a double-quoted value unescaped, a plain one as written,
// null for none or a block scalar.
const description = (text) => {
  const line = (text.match(/^---\n([\s\S]*?)\n---/)?.[1] || '').split('\n').find((l) => l.startsWith('description:'));
  if (!line) return null;
  const v = line.slice('description:'.length).trim();
  if (v.startsWith('"')) { try { return JSON.parse(v); } catch { return null; } }
  return /^[>|]/.test(v) ? null : v;
};
// AC1, AC2: each description is readable, non-empty and within the cap, counted in characters.
const agentProblems = (agents) => agents.flatMap(({ name, text }) => {
  const d = description(text);
  if (d === null) return [`agents/${name}.md has no one-line description the check can read`];
  if (!d.trim()) return [`agents/${name}.md has an empty description`];
  const n = [...d].length;
  return n > AGENT_CAP ? [`agents/${name}.md description is ${n} characters, over the ${AGENT_CAP}-character cap`] : [];
});
// AC3: a phrase each agent's description held before it was trimmed, which must still route to it.
const TRIGGERS = {
  'ada-devils-advocate': "devil's advocate", 'bea-business-analyst': 'Hello Bea', 'jim-solution-architect': 'infrastructure-as-code',
  'karen-seo-optimizer': 'schema markup', 'lena-code-reviewer': 'check my code', 'mira-playwright-expert': 'Playwright tests',
  'muriel-design-engineer': 'figma.com link', 'nadia-security-auditor': 'tenant boundaries', 'otto-ia-mapper': '/userflow',
  'suki-frontend-architect': 'build this UI', 'theo-api-designer': 'API surface',
};
const triggerProblems = (agents, triggers) => Object.entries(triggers).flatMap(([name, phrase]) => {
  const a = agents.find((x) => x.name === name);
  if (!a) return [`TRIGGERS names ${name}, which is not in agents/`];
  return (description(a.text) || '').includes(phrase) ? [] : [`agents/${name}.md description lost its trigger phrase "${phrase}"`];
});

// The checks on the real skills.
const skills = loadSkills(join(root, 'skills'));
const installed = (path) => path in INSTALLED && existsSync(join(root, INSTALLED[path]));
t(`the desk skills are read (${skills.length})`, skills.length >= 15, true);
t('AC1 AC3 every core is within the cap, or on UNSPLIT and over it', sizeProblems(skills, UNSPLIT), []);
t('AC2 UNSPLIT is exactly the skills over the cap', UNSPLIT, skills.filter((s) => Buffer.byteLength(s.core) > CAP).map((s) => s.name));
t(`AC4 the references/ paths the cores name are read (${skills.reduce((n, s) => n + cited(s.name, s.core).length, 0)})`, skills.reduce((n, s) => n + cited(s.name, s.core).length, 0) >= 50, true);
t('AC4 every references/ path a core names exists', refProblems(skills, installed), []);
t('AC4 the installed config template comes from a file in the checkout', Object.values(INSTALLED).filter((f) => !existsSync(join(root, f))), []);
t('AC5 every reference file is named by a file of its skill', orphanProblems(skills), []);
const stages = loadStages(join(root, 'skills'));
t(`DS-364 the worker contract stage files are read (${stages.length})`, stages.length >= 4, true);
t('DS-364 AC1 every worker contract stage file is within the cap', stageSizeProblems(stages), []);
t('DS-364 AC4 the Stage 4 file names a sibling file the check resolves', /worker-contract-stage-3\.md/.test(stages.find((s) => s.file === 'worker-contract-stage-4.md')?.text || ''), true);
t('DS-364 AC4 every file a stage file names exists', stageRefProblems(stages, skills), []);
const agents = loadAgents(join(root, 'agents'));
t(`DS-366 the agents are read (${agents.length})`, agents.length >= 11, true);
t('DS-366 AC1 every agent description is within the cap', agentProblems(agents), []);
t('DS-366 AC3 every agent description keeps its trigger phrase', triggerProblems(agents, TRIGGERS), []);

// The same checks on made-up skills, so each is shown to fail.
const fake = (name, core, files = {}) => ({ name, core, refs: Object.keys(files).filter((p) => p.startsWith('references/')).map((p) => p.slice('references/'.length)), files: { 'SKILL.md': core, ...files } });
t('AC1 a core of exactly 20,480 bytes passes', sizeProblems([fake('desk-x', 'x'.repeat(CAP))], []), []);
t('AC1 one byte over fails naming the skill and its size', sizeProblems([fake('desk-x', 'x'.repeat(CAP + 1))], []), ['desk-x/SKILL.md is 20481 bytes, over the 20480-byte cap']);
t('AC1 the cap counts bytes, not characters', sizeProblems([fake('desk-x', 'é'.repeat(CAP / 2 + 1))], []).length, 1);
t('AC2 a listed skill over the cap is not size-checked', sizeProblems([fake('desk-x', 'x'.repeat(CAP * 3))], ['desk-x']), []);
t('AC3 a listed skill now within the cap fails saying to take it off', sizeProblems([fake('desk-x', 'x'.repeat(CAP))], ['desk-x']), ['desk-x/SKILL.md is 20480 bytes, within the 20480-byte cap: take desk-x off UNSPLIT']);
t('AC3 a listed name that is no skill fails too', sizeProblems([], ['desk-gone']), ['UNSPLIT names desk-gone, which is not a desk skill: take it off']);
const y = fake('desk-y', 'Read `references/a.md`.', { 'references/a.md': 'A' });
t('AC4 a core naming its own reference file passes', refProblems([y], () => false), []);
t('AC4 a missing reference file fails naming both', refProblems([fake('desk-x', 'Read `references/gone.md` now.'), y], () => false), ['desk-x/SKILL.md names references/gone.md, which is not in skills/desk-x/references/']);
t('AC4 another skill\'s file, named as `desk-y/references/…` or "desk-y\'s", resolves there', refProblems([fake('desk-x', 'See `~/.agents/skills/desk-y/references/a.md` and desk-y\'s\n  `references/a.md`.'), y], () => false), []);
t('AC4 another skill\'s file it does not hold fails naming that skill', refProblems([fake('desk-x', 'See desk-y\'s `references/b.md`.'), y], () => false), ['desk-x/SKILL.md names desk-y/references/b.md, which is not in skills/desk-y/references/']);
t('AC4 a file installed from the checkout passes', refProblems([fake('desk-x', '`references/t.md`')], (p) => p === 'desk-x/references/t.md'), []);
t('AC5 a reference file named by another reference file passes', orphanProblems([fake('desk-x', 'Read `references/a.md`.', { 'references/a.md': 'then b.md', 'references/b.md': 'B' })]), []);
const st = (file, text) => ({ file, text });
const ap = fake('desk-autopilot', '', { 'references/worker-contract-stage-3.md': '3', 'references/a.md': 'A' });
t('DS-364 AC1 a stage file of exactly 20,480 bytes passes', stageSizeProblems([st('worker-contract-stage-4.md', 'x'.repeat(CAP))]), []);
t('DS-364 AC2 a stage file one byte over fails naming the file and its size', stageSizeProblems([st('worker-contract-stage-4.md', 'x'.repeat(CAP + 1))]), [`${STAGES}/worker-contract-stage-4.md is 20481 bytes, over the 20480-byte cap`]);
t('DS-364 AC4 a stage file naming files that exist passes', stageRefProblems([st('worker-contract-stage-4.md', 'See `worker-contract-stage-3.md`, `references/a.md` and desk-y\'s `references/a.md`.')], [ap, y]), []);
t('DS-364 AC4 a sibling stage file that does not exist fails naming it', stageRefProblems([st('worker-contract-stage-4.md', 'See `worker-contract-review.md`.')], [ap]), [`${STAGES}/worker-contract-stage-4.md names desk-autopilot/references/worker-contract-review.md, which is not in skills/desk-autopilot/references/`]);
t('DS-364 AC4 a missing references/ file fails naming its skill', stageRefProblems([st('worker-contract-stage-4.md', 'See (`desk-y`\'s\n`references/b.md`).')], [ap, y]), [`${STAGES}/worker-contract-stage-4.md names desk-y/references/b.md, which is not in skills/desk-y/references/`]);
const ag = (name, desc) => ({ name, text: `---\nname: ${name}\ndescription: ${desc}\nmodel: opus\n---\n\nBody.\n` });
t('DS-366 AC1 a description of exactly 600 characters passes', agentProblems([ag('x', JSON.stringify('é'.repeat(AGENT_CAP)))]), []);
t('DS-366 AC2 one character over fails naming the agent and its length', agentProblems([ag('x', JSON.stringify(`a\n${'b'.repeat(AGENT_CAP - 1)}`))]), [`agents/x.md description is ${AGENT_CAP + 1} characters, over the ${AGENT_CAP}-character cap`]);
t('DS-366 AC2 a plain description is measured as written', agentProblems([ag('x', 'c'.repeat(AGENT_CAP + 1))]).length, 1);
t('DS-366 AC3 an empty description fails', agentProblems([ag('x', '""')]), ['agents/x.md has an empty description']);
t('DS-366 AC1 a block-scalar or missing description fails as unreadable', agentProblems([ag('x', '>-'), { name: 'y', text: 'no frontmatter' }]), ['agents/x.md has no one-line description the check can read', 'agents/y.md has no one-line description the check can read']);
t('DS-366 AC3 a description that lost its phrase fails naming it', triggerProblems([ag('x', '"Use for reviews."')], { x: 'check my code', gone: 'z' }), ['agents/x.md description lost its trigger phrase "check my code"', 'TRIGGERS names gone, which is not in agents/']);
t('AC5 a reference file no file names fails naming it', orphanProblems([fake('desk-x', 'Nothing here.', { 'references/c.md': 'names c.md itself' })]), ['skills/desk-x/references/c.md is named by no file of desk-x']);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
