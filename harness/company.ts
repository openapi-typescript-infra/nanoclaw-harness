import fs from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { CronExpressionParser } from 'cron-parser';
import { validateConfig, type Config, type Inference, type Job } from './config.js';
import { integrationCatalog, workflowCatalog } from './company-catalog.js';

export interface Company {
  version: 1;
  company: { id: string; name: string; agentName: string; timezone: string; context: string };
  deployment: { root: string };
  slack: {
    owner: string;
    users: Record<string, string>;
    channels: Record<string, string>;
    access: Record<string, string[]>;
  };
  execution: {
    activeAccount: string;
    accounts: Record<string, { provider: 'codex' | 'claude'; auth: 'subscription' }>;
    profiles: Record<string, { account: string; model: string | null; effort: string | null }>;
  };
  integrations: Record<
    string,
    {
      provider: keyof typeof integrationCatalog;
      endpoint: string | null;
      resources: Record<string, string>;
      credentialRef: string | null;
    }
  >;
  workers: Record<string, { url: string; recipes: string[]; hostProfile?: string }>;
  workflows: Record<
    string,
    {
      enabled: boolean;
      preset: keyof typeof workflowCatalog;
      access: string;
      profile: string;
      integrations: string[];
      channel: string;
      trigger: { kind: 'mention' } | { kind: 'pattern'; pattern: string } | { kind: 'schedule'; cron: string };
      worker?: string;
    }
  >;
}

export interface Check {
  level: 'error' | 'note';
  field: string;
  message: string;
}
function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function object(value: unknown, location: string, fields?: string[]): asserts value is Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), `${location}: expected an object`);
  // Never echo values: a misplaced credential must not appear in diagnostics.
  if (fields)
    requireValue(
      Object.keys(value).every((key) => fields.includes(key)),
      `${location}: unknown field; see company.example.yaml (credentials belong in the vault)`,
    );
}
function text(value: unknown, location: string, max = 200): asserts value is string {
  requireValue(
    typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value),
    `${location}: expected nonempty text (at most ${max} characters)`,
  );
}
function slug(value: unknown, location: string) {
  requireValue(
    typeof value === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(value),
    `${location}: use a lowercase name with hyphens`,
  );
}
function namedMap(value: unknown, location: string) {
  object(value, location);
  for (const key of Object.keys(value)) slug(key, location);
}
function names(value: unknown, location: string): asserts value is string[] {
  requireValue(Array.isArray(value), `${location}: expected a list of names`);
  value.forEach((item) => slug(item, location));
  requireValue(new Set(value).size === value.length, `${location}: duplicate names`);
}
function reference(map: object, key: unknown, location: string) {
  requireValue(typeof key === 'string' && Object.hasOwn(map, key), `${location}: unknown reference`);
}
function origin(value: unknown, location: string) {
  text(value, location, 2048);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${location}: expected an HTTPS origin`);
  }
  requireValue(
    url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/',
    `${location}: expected an HTTPS origin without credentials`,
  );
}

export function validateCompany(input: unknown): Company {
  object(input, 'company config', [
    'version',
    'company',
    'deployment',
    'slack',
    'execution',
    'integrations',
    'workers',
    'workflows',
  ]);
  const c = input as unknown as Company;
  requireValue(c.version === 1, 'version: expected 1');
  object(c.company, 'company', ['id', 'name', 'agentName', 'timezone', 'context']);
  slug(c.company.id, 'company.id');
  text(c.company.name, 'company.name', 80);
  text(c.company.agentName, 'company.agentName', 60);
  text(c.company.timezone, 'company.timezone');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: c.company.timezone });
  } catch {
    throw new Error('company.timezone: invalid IANA timezone');
  }
  requireValue(
    typeof c.company.context === 'string' && c.company.context.length <= 32_000,
    'company.context: expected text up to 32000 characters',
  );
  object(c.deployment, 'deployment', ['root']);
  requireValue(
    typeof c.deployment.root === 'string' &&
      /^\/[a-zA-Z0-9_./-]+$/.test(c.deployment.root) &&
      path.posix.normalize(c.deployment.root) === c.deployment.root &&
      !c.deployment.root.endsWith('/'),
    'deployment.root: use a normalized absolute Linux path without spaces or shell substitutions',
  );
  object(c.slack, 'slack', ['owner', 'users', 'channels', 'access']);
  namedMap(c.slack.users, 'slack.users');
  namedMap(c.slack.channels, 'slack.channels');
  namedMap(c.slack.access, 'slack.access');
  for (const [name, id] of Object.entries(c.slack.users))
    requireValue(typeof id === 'string' && /^U[A-Z0-9]{8,}$/.test(id), `slack.users.${name}: expected Slack user ID`);
  for (const [name, id] of Object.entries(c.slack.channels))
    requireValue(
      typeof id === 'string' && /^C[A-Z0-9]{8,}$/.test(id),
      `slack.channels.${name}: expected Slack channel ID`,
    );
  reference(c.slack.users, c.slack.owner, 'slack.owner');
  for (const [name, users] of Object.entries(c.slack.access)) {
    names(users, `slack.access.${name}`);
    requireValue(users.length > 0, `slack.access.${name}: select at least one member`);
    users.forEach((user) => reference(c.slack.users, user, `slack.access.${name}`));
  }
  object(c.execution, 'execution', ['activeAccount', 'accounts', 'profiles']);
  namedMap(c.execution.accounts, 'execution.accounts');
  namedMap(c.execution.profiles, 'execution.profiles');
  reference(c.execution.accounts, c.execution.activeAccount, 'execution.activeAccount');
  slug(
    `${c.company.id}-${c.execution.activeAccount}`,
    'company.id plus execution.activeAccount (combined length at most 48)',
  );
  for (const [name, account] of Object.entries(c.execution.accounts)) {
    object(account, `execution.accounts.${name}`, ['provider', 'auth']);
    requireValue(
      ['codex', 'claude'].includes(account.provider) && account.auth === 'subscription',
      `execution.accounts.${name}: expected provider codex/claude and auth subscription`,
    );
  }
  for (const [name, profile] of Object.entries(c.execution.profiles)) {
    object(profile, `execution.profiles.${name}`, ['account', 'model', 'effort']);
    reference(c.execution.accounts, profile.account, `execution.profiles.${name}.account`);
    requireValue(
      profile.model === null ||
        (typeof profile.model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(profile.model)),
      `execution.profiles.${name}.model: expected model identifier or null`,
    );
    requireValue(
      profile.effort === null || (typeof profile.effort === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(profile.effort)),
      `execution.profiles.${name}.effort: expected effort identifier or null`,
    );
  }
  namedMap(c.integrations, 'integrations');
  for (const [name, integration] of Object.entries(c.integrations)) {
    object(integration, `integrations.${name}`, ['provider', 'endpoint', 'resources', 'credentialRef']);
    reference(integrationCatalog, integration.provider, `integrations.${name}.provider`);
    if (integration.endpoint !== null) origin(integration.endpoint, `integrations.${name}.endpoint`);
    namedMap(integration.resources, `integrations.${name}.resources`);
    for (const value of Object.values(integration.resources)) text(value, `integrations.${name}.resources`);
    if (integration.credentialRef !== null) slug(integration.credentialRef, `integrations.${name}.credentialRef`);
  }
  namedMap(c.workers, 'workers');
  for (const [name, worker] of Object.entries(c.workers)) {
    object(worker, `workers.${name}`, ['url', 'recipes', 'hostProfile']);
    if (worker.hostProfile !== undefined) slug(worker.hostProfile, `workers.${name}.hostProfile`);
    origin(worker.url, `workers.${name}.url`);
    names(worker.recipes, `workers.${name}.recipes`);
    requireValue(worker.recipes.length > 0, `workers.${name}.recipes: select a recipe`);
  }
  namedMap(c.workflows, 'workflows');
  for (const [name, job] of Object.entries(c.workflows)) {
    const loc = `workflows.${name}`;
    object(job, loc, ['enabled', 'preset', 'access', 'profile', 'integrations', 'channel', 'trigger', 'worker']);
    requireValue(typeof job.enabled === 'boolean', `${loc}.enabled: expected boolean`);
    reference(workflowCatalog, job.preset, `${loc}.preset`);
    reference(c.slack.access, job.access, `${loc}.access`);
    reference(c.execution.profiles, job.profile, `${loc}.profile`);
    reference(c.slack.channels, job.channel, `${loc}.channel`);
    names(job.integrations, `${loc}.integrations`);
    job.integrations.forEach((integration) => reference(c.integrations, integration, `${loc}.integrations`));
    object(job.trigger, `${loc}.trigger`, ['kind', 'pattern', 'cron']);
    switch (job.trigger.kind) {
      case 'mention':
        object(job.trigger, `${loc}.trigger`, ['kind']);
        break;
      case 'pattern':
        object(job.trigger, `${loc}.trigger`, ['kind', 'pattern']);
        text(job.trigger.pattern, `${loc}.trigger.pattern`);
        try {
          new RegExp(job.trigger.pattern);
        } catch {
          throw new Error(`${loc}.trigger.pattern: invalid regular expression`);
        }
        break;
      case 'schedule':
        object(job.trigger, `${loc}.trigger`, ['kind', 'cron']);
        text(job.trigger.cron, `${loc}.trigger.cron`);
        try {
          CronExpressionParser.parse(job.trigger.cron, { tz: c.company.timezone });
        } catch {
          throw new Error(`${loc}.trigger.cron: invalid schedule`);
        }
        break;
      default:
        throw new Error(`${loc}.trigger: expected mention, pattern, or schedule`);
    }
    if (job.worker !== undefined) reference(c.workers, job.worker, `${loc}.worker`);
    requireValue(job.preset !== 'ios-check' || job.worker !== undefined, `${loc}: ios-check requires a worker`);
    requireValue(
      job.worker === undefined || job.preset === 'ios-check',
      `${loc}: worker is only supported by ios-check`,
    );
    requireValue(
      job.preset !== 'daily-health' || job.trigger.kind === 'schedule',
      `${loc}: daily-health requires a schedule`,
    );
  }
  return c;
}

export function readCompany(file: string): Company {
  requireValue(fs.statSync(file).size <= 256 * 1024, 'Company configuration is too large');
  const doc = parseDocument(fs.readFileSync(file, 'utf8'), { uniqueKeys: true });
  requireValue(
    doc.errors.length === 0 && doc.warnings.length === 0,
    'Invalid YAML: check syntax and duplicate keys (values omitted from diagnostics)',
  );
  let input: unknown;
  try {
    input = doc.toJS({ maxAliasCount: 0 });
  } catch {
    throw new Error('YAML aliases are not supported');
  }
  return validateCompany(input);
}

export function inspectCompany(c: Company): Check[] {
  const checks: Check[] = [];
  const add = (level: Check['level'], field: string, message: string) => checks.push({ level, field, message });
  const active = Object.entries(c.workflows).filter(([, job]) => job.enabled);
  if (c.company.id === 'your-company' || c.company.name === 'Your Company')
    add('error', 'company', 'Replace the example company ID and display name');
  if (!active.length) add('error', 'workflows', 'Enable at least one workflow');
  const usedUsers = new Set([c.slack.owner]);
  const usedChannels = new Set<string>();
  if (c.execution.accounts[c.execution.activeAccount].provider !== 'codex')
    add(
      'error',
      'execution.activeAccount',
      'This starter only provisions Codex; a Claude executor adapter is not installed',
    );
  for (const [name, job] of active) {
    const loc = `workflows.${name}`;
    const preset = workflowCatalog[job.preset];
    if (!preset.available) add('error', loc, preset.description);
    c.slack.access[job.access].forEach((user) => usedUsers.add(user));
    usedChannels.add(job.channel);
    if (c.execution.profiles[job.profile].account !== c.execution.activeAccount)
      add(
        'error',
        `${loc}.profile`,
        'Multiple-account routing is not implemented; use a profile on execution.activeAccount',
      );
    for (const name of job.integrations) {
      const integration = c.integrations[name];
      if (!integrationCatalog[integration.provider].available)
        add(
          'error',
          `${loc}.integrations`,
          `Connector ${name} (${integration.provider}) is not implemented; it cannot be enabled by configuration alone`,
        );
    }
    if (job.worker && /(^|\.)example\.com$/.test(new URL(c.workers[job.worker].url).hostname))
      add('error', `workers.${job.worker}.url`, 'Replace the example worker hostname');
  }
  for (const name of usedUsers)
    if (/^U0+$/.test(c.slack.users[name])) add('error', `slack.users.${name}`, 'Replace the example user ID');
  for (const name of usedChannels)
    if (/^C0+$/.test(c.slack.channels[name])) add('error', `slack.channels.${name}`, 'Replace the example channel ID');
  for (const [name, integration] of Object.entries(c.integrations))
    add(
      'note',
      `integrations.${name}`,
      `${integration.provider}: configuration inventory only; no connector installed or credentials verified`,
    );
  add(
    'note',
    'authentication',
    'Offline check only: Slack tokens, model login, subscription entitlement and refresh require live verification',
  );
  add('note', 'execution.profiles', 'Models and effort values require verification against the authenticated runtime');
  return checks;
}

export function resolveCompany(c: Company): Config {
  const errors = inspectCompany(c).filter((item) => item.level === 'error');
  requireValue(!errors.length, errors.map((item) => `${item.field}: ${item.message}`).join('\n'));
  const jobs: Job[] = Object.entries(c.workflows)
    .filter(([, job]) => job.enabled)
    .map(([id, job]) => {
      const preset = workflowCatalog[job.preset];
      const profile = c.execution.profiles[job.profile];
      const inference: Inference = {
        ...(profile.model !== null ? { model: profile.model } : {}),
        ...(profile.effort !== null ? { effort: profile.effort } : {}),
      };
      const channel = c.slack.channels[job.channel];
      return {
        id,
        playbook: preset.playbook,
        skills: [...preset.skills],
        inference,
        members: [...new Set(c.slack.access[job.access].map((name) => c.slack.users[name]))],
        triggers: [job.trigger.kind === 'schedule' ? job.trigger : { ...job.trigger, channel }],
        sink: job.trigger.kind === 'schedule' ? { kind: 'channel', channel } : { kind: 'thread' },
        ...(job.worker ? { macos: c.workers[job.worker] } : {}),
      };
    });
  return validateConfig({
    version: 1,
    executionIdentity: `${c.company.id}-${c.execution.activeAccount}`,
    owner: c.slack.users[c.slack.owner],
    timezone: c.company.timezone,
    company: { name: c.company.name, agentName: c.company.agentName, context: c.company.context },
    jobs,
  });
}
