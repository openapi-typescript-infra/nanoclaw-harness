import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { stringify } from 'yaml';
import { readCompany, validateCompany, inspectCompany, resolveCompany } from './company.js';
import { buildCompany } from './company-build.js';
import { loadConfig } from './load-config.js';
import { parseTemplate } from '../src/templates/parse.js';

const root = path.resolve('harness');
function ready() {
  const c = readCompany(path.join(root, 'company.example.yaml'));
  c.company = {
    id: 'acme',
    name: 'Acme',
    agentName: 'Acme Assistant',
    timezone: 'Europe/London',
    context: 'Activation means the first completed booking.',
  };
  c.slack.users.operator = 'U012345678';
  c.slack.channels.engineering = 'C012345678';
  c.slack.channels.reports = 'C123456789';
  return c;
}
function temporary(fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'company-harness-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('resolves company names, membership aliases, model profiles, schedules and workers into native jobs', () => {
  const c = ready();
  c.slack.users.teammate = 'U123456789';
  c.slack.access.team.push('teammate');
  c.execution.profiles.deep.model = 'test-deep-model';
  c.workflows.health.enabled = true;
  c.workflows.health.profile = 'deep';
  c.workers.mobile = { url: 'https://mac.acme.test/', recipes: ['simulators'] };
  c.workers.mobile.hostProfile = 'ios';
  c.workflows.mobile = {
    enabled: true,
    preset: 'ios-check',
    access: 'team',
    profile: 'standard',
    integrations: [],
    channel: 'engineering',
    trigger: { kind: 'pattern', pattern: '^ios-check' },
    worker: 'mobile',
  };
  const resolved = resolveCompany(validateCompany(c));
  assert.equal(resolved.executionIdentity, 'acme-primary');
  assert.equal(resolved.owner, 'U012345678');
  assert.equal(resolved.timezone, 'Europe/London');
  assert.deepEqual(resolved.jobs[0].members, ['U012345678', 'U123456789']);
  assert.deepEqual(resolved.jobs[0].triggers, [{ kind: 'mention', channel: 'C012345678' }]);
  assert.deepEqual(resolved.jobs[1].inference, { model: 'test-deep-model', effort: 'high' });
  assert.deepEqual(resolved.jobs[1].sink, { kind: 'channel', channel: 'C123456789' });
  assert.deepEqual(resolved.jobs[2].macos, c.workers.mobile);
});

test('onboarding refuses unsupported active integrations, accounts and workflows rather than silently dropping them', () => {
  const example = readCompany(path.join(root, 'company.example.yaml'));
  assert.equal(inspectCompany(example).filter((item) => item.level === 'error').length, 3);
  assert.throws(() => resolveCompany(example), /Replace the example/);
  for (const provider of ['posthog', 'mixpanel'] as const) {
    const c = ready();
    c.integrations.analytics.provider = provider;
    assert.doesNotThrow(() => resolveCompany(c)); // Inventory alone grants no access.
    c.workflows.chat.integrations = ['analytics'];
    assert.throws(() => resolveCompany(c), /Connector analytics.*not implemented/);
  }
  const c = ready();
  c.execution.accounts.reviewer = { provider: 'codex', auth: 'subscription' };
  c.execution.profiles.deep.account = 'reviewer';
  assert.doesNotThrow(() => resolveCompany(c)); // An unused account is inventory.
  c.workflows.chat.profile = 'deep';
  assert.throws(() => resolveCompany(c), /Multiple-account routing/);
  c.workflows.chat.profile = 'standard';
  c.workflows.review.enabled = true;
  assert.throws(() => resolveCompany(c), /PR review integration/);
  c.workflows.review.enabled = false;
  c.execution.accounts.primary.provider = 'claude';
  assert.throws(() => resolveCompany(c), /only provisions Codex/);
});

test('rejects unresolved references, ambiguous routes and malformed settings without printing secret values', () => {
  const mutations = [
    (c: any) => c.slack.access.team.push('unknown'),
    (c: any) => (c.workflows.chat.channel = 'unknown'),
    (c: any) => (c.workflows.chat.profile = 'unknown'),
    (c: any) => c.workflows.chat.integrations.push('unknown'),
    (c: any) => (c.execution.profiles.standard.account = 'unknown'),
    (c: any) => (c.integrations.analytics.endpoint = 'https://secret:password@acme.test/'),
    (c: any) => (c.integrations.analytics.provider = 'unknown'),
    (c: any) => (c.slack.users.operator = ['U012345678']),
    (c: any) => (c.deployment.root = '/opt/../tmp'),
    (c: any) => (c.deployment.root = '/opt/$(whoami)'),
    (c: any) => (c.workflows.health.trigger.cron = 'not a cron'),
    (c: any) => (c.workflows.chat.trigger = { kind: 'mention', pattern: 'ignored' }),
    (c: any) => (c.workflows.chat.stages = []),
  ];
  for (const mutate of mutations) {
    const c = ready();
    mutate(c);
    assert.throws(() => validateCompany(c));
  }
  const c = ready();
  c.workflows.duplicate = structuredClone(c.workflows.chat);
  assert.throws(() => resolveCompany(validateCompany(c)), /Ambiguous duplicate trigger/);
  assert.throws(
    () => validateCompany({ ...ready(), token: 'DO-NOT-PRINT-THIS' }),
    (error: Error) => !error.message.includes('DO-NOT-PRINT-THIS'),
  );
});

test('builds isolated company artifacts through the upstream template parser and preserves prior output on failure', () =>
  temporary((dir) => {
    const c = ready();
    const output = path.join(dir, 'acme');
    buildCompany(c, root, output);
    const instructions = fs.readFileSync(
      path.join(output, 'templates/chat/ai.nanoco.nanoclaw/context/instructions.md'),
      'utf8',
    );
    assert.match(instructions, /Acme Assistant/);
    assert.match(instructions, /first completed booking/);
    assert.doesNotMatch(instructions, /posthog|mixpanel/i);
    assert.deepEqual(parseTemplate(path.join(output, 'templates/chat')).report, []);
    const manifest = JSON.parse(fs.readFileSync(path.join(output, 'slack-app-manifest.json'), 'utf8'));
    assert.equal(manifest.features.bot_user.display_name, 'Acme Assistant');
    assert.match(fs.readFileSync(path.join(output, 'runtime.env.example'), 'utf8'), /TZ=Europe\/London/);
    assert.match(fs.readFileSync(path.join(output, 'deployment.env'), 'utf8'), /COMPOSE_PROJECT_NAME=acme/);
    assert.deepEqual(loadConfig(path.join(output, 'jobs.json')), resolveCompany(c));

    const other = ready();
    other.company = {
      ...other.company,
      id: 'other',
      name: 'Other',
      agentName: 'Other Assistant',
      context: 'Different definitions.',
    };
    buildCompany(other, root, path.join(dir, 'other'));
    assert.doesNotMatch(
      fs.readFileSync(path.join(dir, 'other/templates/chat/ai.nanoco.nanoclaw/context/instructions.md'), 'utf8'),
      /Acme|first completed booking/,
    );
    assert.equal(
      fs.readFileSync(path.join(output, 'templates/chat/ai.nanoco.nanoclaw/context/instructions.md'), 'utf8'),
      instructions,
    );

    const brokenRoot = path.join(dir, 'missing-playbooks');
    fs.mkdirSync(brokenRoot);
    for (const file of ['slack-app-manifest.json', 'env.example'])
      fs.copyFileSync(path.join(root, file), path.join(brokenRoot, file));
    assert.throws(() => buildCompany(c, brokenRoot, output));
    assert.equal(
      fs.readFileSync(path.join(output, 'templates/chat/ai.nanoco.nanoclaw/context/instructions.md'), 'utf8'),
      instructions,
    );
    assert.equal(
      fs.readdirSync(dir).some((entry) => entry.includes('.staging-')),
      false,
    );
  }));

test('CLI initializes without overwriting, reports a fill-in checklist, and checks YAML without deploying', () =>
  temporary((dir) => {
    const file = path.join(dir, 'company.local.yaml');
    const args = ['--import', 'tsx', path.join(root, 'company-cli.ts')];
    execFileSync(process.execPath, [...args, 'init', file]);
    const initial = fs.readFileSync(file, 'utf8');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.notEqual(spawnSync(process.execPath, [...args, 'init', file]).status, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), initial);
    const check = spawnSync(process.execPath, [...args, 'check', file], { encoding: 'utf8' });
    assert.equal(check.status, 1);
    assert.match(check.stdout, /TODO slack.users.operator/);
    fs.writeFileSync(file, stringify(ready()));
    assert.deepEqual(loadConfig(file), resolveCompany(ready()));
    const checked = execFileSync(process.execPath, [...args, 'check', file], { encoding: 'utf8' });
    assert.match(checked, /Configuration ready to build/);
    fs.writeFileSync(file, 'version: 1\nversion: DO-NOT-PRINT-THIS\n');
    assert.throws(
      () => readCompany(file),
      (error: Error) => /Invalid YAML/.test(error.message) && !error.message.includes('DO-NOT-PRINT-THIS'),
    );
  }));

test('host-backed worker compiles the API v1 client and named host profile', () =>
  temporary((dir) => {
    const c = ready();
    c.workers.mobile = { url: 'https://broker.acme.test/', recipes: ['simulators'], hostProfile: 'ios' };
    c.workflows.mobile = {
      enabled: true,
      preset: 'ios-check',
      access: 'team',
      profile: 'standard',
      integrations: [],
      channel: 'engineering',
      trigger: { kind: 'pattern', pattern: '^ios-check' },
      worker: 'mobile',
    };
    buildCompany(c, root, path.join(dir, 'generated'));
    const template = path.join(dir, 'generated/templates/mobile');
    const parsed = parseTemplate(template);
    assert.deepEqual(parsed.report, []);
    const mcp = JSON.parse(fs.readFileSync(path.join(template, 'mcp.json'), 'utf8'));
    assert.equal(mcp.mcpServers.macos.env.MAC_HOST_PROFILE, 'ios');
    assert.equal(mcp.mcpServers.macos.env.MAC_WORKER_TOKEN, 'placeholder');
    assert.match(fs.readFileSync(path.join(template, 'mac-client.mjs'), 'utf8'), /class CompanyHost/);
  }));
