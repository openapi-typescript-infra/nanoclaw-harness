import fs from 'node:fs';
import path from 'node:path';
import { CronExpressionParser } from 'cron-parser';

export interface Inference {
  model?: string;
  effort?: string;
}

export interface Job {
  id: string;
  inference?: Inference;
  playbook: string;
  skills: string[];
  members: string[];
  triggers: (
    | { kind: 'mention'; channel: string }
    | { kind: 'pattern'; channel: string; pattern: string }
    | { kind: 'schedule'; cron: string }
  )[];
  sink: { kind: 'thread' } | { kind: 'channel'; channel: string };
  macos?: { url: string; recipes: string[]; hostProfile?: string };
}
export interface Config {
  version: 1;
  executionIdentity: string;
  owner: string;
  timezone: string;
  inference?: Inference;
  company?: { name: string; agentName: string; context: string };
  jobs: Job[];
}
const slug = /^[a-z][a-z0-9-]{0,47}$/;
const user = /^U[A-Z0-9]{8,}$/;
const channel = /^C[A-Z0-9]{8,}$/;
function ensure(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function keys(value: object, allowed: string[]) {
  ensure(
    Object.keys(value).every((key) => allowed.includes(key)),
    'Unknown configuration field (values omitted)',
  );
}

function validateInference(input: unknown): asserts input is Inference {
  ensure(input && typeof input === 'object' && !Array.isArray(input), 'Expected inference object');
  const inference = input as Inference;
  keys(inference, ['model', 'effort']);
  // Availability and model/effort compatibility must be checked against the
  // authenticated runtime; the harness must not freeze a model catalog in code.
  if (inference.model !== undefined)
    ensure(
      typeof inference.model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(inference.model),
      'Invalid model identifier',
    );
  if (inference.effort !== undefined)
    ensure(
      typeof inference.effort === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(inference.effort),
      'Invalid reasoning effort',
    );
}

export function resolveInference(config: Config, job: Job): Inference {
  return { ...config.inference, ...job.inference };
}

export function validateConfig(input: unknown): Config {
  ensure(input && typeof input === 'object', 'Expected config object');
  const c = input as Config;
  keys(c, ['version', 'executionIdentity', 'owner', 'timezone', 'inference', 'company', 'jobs']);
  ensure(c.version === 1, 'Unsupported config version');
  ensure(
    typeof c.executionIdentity === 'string' && slug.test(c.executionIdentity),
    'executionIdentity must name this deployment account',
  );
  ensure(typeof c.owner === 'string' && user.test(c.owner), 'owner must be a Slack member ID');
  ensure(typeof c.timezone === 'string', 'timezone required');
  new Intl.DateTimeFormat('en-US', { timeZone: c.timezone });
  if (c.inference !== undefined) validateInference(c.inference);
  if (c.company !== undefined) {
    ensure(c.company && typeof c.company === 'object' && !Array.isArray(c.company), 'Expected company object');
    keys(c.company, ['name', 'agentName', 'context']);
    for (const field of ['name', 'agentName'] as const)
      ensure(
        typeof c.company[field] === 'string' &&
          c.company[field].trim().length &&
          c.company[field].length <= 80 &&
          !/[\x00-\x1f]/.test(c.company[field]),
        `Invalid company ${field}`,
      );
    ensure(typeof c.company.context === 'string' && c.company.context.length <= 32_000, 'Invalid company context');
  }
  ensure(Array.isArray(c.jobs) && c.jobs.length > 0, 'At least one job required');
  const ids = new Set<string>();
  const bindings = new Set<string>();
  for (const j of c.jobs) {
    keys(j, ['id', 'inference', 'playbook', 'skills', 'members', 'triggers', 'sink', 'macos']);
    if (j.inference !== undefined) validateInference(j.inference);
    ensure(typeof j.id === 'string' && slug.test(j.id) && !ids.has(j.id), 'Invalid or duplicate job ID');
    ids.add(j.id);
    ensure(typeof j.playbook === 'string' && /^[a-z][a-z0-9-]*\.md$/.test(j.playbook), `${j.id}: invalid playbook`);
    ensure(
      Array.isArray(j.skills) && j.skills.every((s) => typeof s === 'string' && slug.test(s)),
      `${j.id}: invalid skills`,
    );
    ensure(
      Array.isArray(j.members) && j.members.length && j.members.every((s) => typeof s === 'string' && user.test(s)),
      `${j.id}: explicit members required`,
    );
    ensure(Array.isArray(j.triggers) && j.triggers.length, `${j.id}: triggers required`);
    ensure(j.sink && ['thread', 'channel'].includes(j.sink.kind), `${j.id}: invalid sink`);
    keys(j.sink, j.sink.kind === 'thread' ? ['kind'] : ['kind', 'channel']);
    if (j.sink.kind === 'channel') ensure(channel.test(j.sink.channel), `${j.id}: invalid sink channel`);
    const wired = new Set<string>();
    for (const t of j.triggers) {
      if (t.kind === 'schedule') {
        keys(t, ['kind', 'cron']);
        ensure(j.sink.kind === 'channel', `${j.id}: schedule requires channel sink`);
        CronExpressionParser.parse(t.cron, { tz: c.timezone });
      } else {
        ensure(t.kind === 'mention' || t.kind === 'pattern', `${j.id}: unknown trigger`);
        keys(t, t.kind === 'mention' ? ['kind', 'channel'] : ['kind', 'channel', 'pattern']);
        ensure(channel.test(t.channel), `${j.id}: invalid Slack channel`);
        ensure(!wired.has(t.channel), `${j.id}: one trigger rule per channel`);
        wired.add(t.channel);
        if (t.kind === 'pattern') {
          ensure(typeof t.pattern === 'string' && t.pattern.length > 0 && t.pattern.length <= 200, 'Invalid pattern');
          new RegExp(t.pattern);
        }
        const binding = `${t.channel}:${t.kind}:${t.kind === 'pattern' ? t.pattern : ''}`;
        ensure(!bindings.has(binding), 'Ambiguous duplicate trigger across jobs');
        bindings.add(binding);
      }
    }
    if (j.macos) {
      keys(j.macos, ['url', 'recipes', 'hostProfile']);
      if (j.macos.hostProfile !== undefined) ensure(slug.test(j.macos.hostProfile), 'Invalid host profile');
      const url = new URL(j.macos.url);
      ensure(
        url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/',
        'macOS URL must be an HTTPS origin without credentials',
      );
      ensure(
        Array.isArray(j.macos.recipes) && j.macos.recipes.length && j.macos.recipes.every((s) => slug.test(s)),
        'Invalid macOS recipes',
      );
    }
  }
  return c;
}

export function readConfig(file: string) {
  return validateConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
}

// Reject symlinks at every level, including nested skill assets.
export function collectFiles(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  function walk(dir: string, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      ensure(!entry.isSymbolicLink(), `Symlink refused: ${entry.name}`);
      const rel = path.join(prefix, entry.name);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else {
        ensure(entry.isFile(), `Special file refused: ${rel}`);
        files.set(rel, fs.readFileSync(path.join(dir, entry.name)));
      }
    }
  }
  ensure(!fs.lstatSync(root).isSymbolicLink(), `Symlink refused: ${root}`);
  walk(root);
  return files;
}
