import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolveInference } from './config.js';
import { loadConfig } from './load-config.js';
import { readCompany } from './company.js';
import { compile } from './compile.js';

const configFile = process.argv[2];
if (!configFile) throw new Error('Usage: pnpm run harness:provision harness/company.local.yaml (or jobs.local.json)');
if (/\.ya?ml$/i.test(configFile) && readCompany(configFile).deployment.root !== process.cwd())
  throw new Error('Run provisioning from deployment.root on the target VM; build/check may run locally.');
const config = loadConfig(configFile);
if (JSON.stringify(config).includes('0000000') || JSON.stringify(config).includes('example.com'))
  throw new Error('Replace example Slack IDs and worker URL before provisioning');
const hash = createHash('sha256').update(JSON.stringify(config)).digest('hex');
const receipt = path.resolve('data/harness-provision.json');
if (fs.existsSync(receipt)) {
  const previous = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  if (previous.hash === hash) {
    console.log('This configuration is already provisioned.');
    process.exit(0);
  }
  throw new Error(
    'Configuration changed since provisioning. Use ncl to review/update existing memberships and wirings; do not silently retain old permissions. See harness/README.md.',
  );
}
const templateRoot = path.resolve('harness/generated/templates');
compile(config, path.resolve('harness'), templateRoot);
function ncl(command: string[], args: Record<string, unknown> = {}) {
  const response = JSON.parse(
    execFileSync(process.execPath, ['dist/cli/client.js', ...command, '--stdin-json', '--json'], {
      input: JSON.stringify(args),
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
  if (!response.ok) throw new Error(JSON.stringify(response.error));
  return response.data;
}
// The daemon must use the same library; setting the CLI's env alone cannot change it.
const templates = ncl(['templates', 'list']);
if (!JSON.stringify(templates).includes('harness-'))
  throw new Error('Start the daemon with NANOCLAW_TEMPLATES_DIR pointing at harness/generated/templates');
const user = (id: string) => ncl(['users', 'create'], { id: `slack:${id}`, kind: 'slack' });
user(config.owner);
ncl(['roles', 'grant'], { user: `slack:${config.owner}`, role: 'owner' });
const channel = (id: string) =>
  ncl(['messaging-groups', 'create'], {
    channel_type: 'slack',
    platform_id: `slack:${id}`,
    instance: 'slack',
    is_group: 1,
    unknown_sender_policy: 'strict',
  });
const groups: Record<string, string> = {};
for (const job of config.jobs) {
  const result = ncl(['groups', 'create'], {
    template: job.id,
    name: `${config.company?.agentName ?? 'Harness'} ${job.id}`,
    timezone: config.timezone,
    yes: true,
  });
  if (result.templateReport?.length || result.report?.length)
    throw new Error('Template reported skipped content; inspect ncl groups before proceeding');
  const id = result.id ?? result.group?.id;
  if (!id) throw new Error('No group ID returned');
  groups[job.id] = id;
  ncl(['groups', 'config', 'update'], {
    id,
    provider: 'codex',
    cli_scope: 'disabled',
    timezone: config.timezone,
    ...resolveInference(config, job),
  });
  for (const member of job.members) {
    user(member);
    ncl(['members', 'add'], { user: `slack:${member}`, group: id, added_by: `slack:${config.owner}` });
  }
  if (job.sink.kind === 'channel') {
    const mg = channel(job.sink.channel);
    const destinations = ncl(['destinations', 'list'], { agent_group_id: id });
    const existing = destinations.find((d: { local_name: string }) => d.local_name === 'reports');
    if (existing && existing.target_id !== mg.id) throw new Error('Existing reports destination differs');
    if (!existing)
      ncl(['destinations', 'add'], {
        agent_group_id: id,
        local_name: 'reports',
        target_type: 'channel',
        target_id: mg.id,
      });
  }
  for (const trigger of job.triggers)
    if (trigger.kind !== 'schedule') {
      const mg = channel(trigger.channel);
      ncl(['wirings', 'create'], {
        messaging_group_id: mg.id,
        agent_group_id: id,
        engage_mode: trigger.kind === 'mention' ? 'mention-sticky' : 'pattern',
        ...(trigger.kind === 'pattern' ? { engage_pattern: trigger.pattern } : {}),
        sender_scope: 'known',
        ignored_message_policy: 'drop',
        session_mode: 'per-thread',
        threads: 1,
      });
    }
  console.log(`Provisioned ${job.id}: ${id}`);
}
fs.mkdirSync(path.dirname(receipt), { recursive: true });
fs.writeFileSync(
  receipt,
  JSON.stringify(
    { hash, executionIdentity: config.executionIdentity, groups, createdAt: new Date().toISOString() },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log('Schedules remain paused. Inspect ncl tasks list before resuming selected tasks.');
