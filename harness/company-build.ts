import fs from 'node:fs';
import path from 'node:path';
import { compile } from './compile.js';
import { resolveCompany, type Company } from './company.js';

/** Only validated, supported configurations produce deployment artifacts. */
export function buildCompany(company: Company, root: string, output: string) {
  const config = resolveCompany(company);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'slack-app-manifest.json'), 'utf8'));
  manifest.display_information.name = company.company.agentName;
  manifest.display_information.description = 'Company assistant for configured workflows';
  manifest.features.bot_user.display_name = company.company.agentName;
  const runtimeEnv = fs
    .readFileSync(path.join(root, 'env.example'), 'utf8')
    .replace(
      /^NANOCLAW_TEMPLATES_DIR=.*$/m,
      `NANOCLAW_TEMPLATES_DIR=${company.deployment.root}/harness/generated/templates`,
    )
    .replace(/^TZ=.*$/m, `TZ=${company.company.timezone}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const staged = fs.mkdtempSync(`${output}.staging-`);
  try {
    compile(config, root, path.join(staged, 'templates'));
    const artifacts = {
      'jobs.json': JSON.stringify(config, null, 2) + '\n',
      'slack-app-manifest.json': JSON.stringify(manifest, null, 2) + '\n',
      'runtime.env.example': runtimeEnv,
      'deployment.env': `# Generated; edit company.local.yaml instead.\nNANOCLAW_ROOT=${company.deployment.root}\nCOMPOSE_PROJECT_NAME=${company.company.id}\n`,
    };
    for (const [file, value] of Object.entries(artifacts))
      fs.writeFileSync(path.join(staged, file), value, { mode: 0o600 });
    // Do not overwrite the output until all templates pass NanoClaw's parser.
    fs.rmSync(output, { recursive: true, force: true });
    fs.renameSync(staged, output);
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }
  return { jobs: config.jobs.length, output };
}
