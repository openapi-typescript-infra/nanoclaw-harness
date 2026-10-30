import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectCompany, readCompany, resolveCompany } from './company.js';
import { buildCompany } from './company-build.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const [command, file = path.join(root, 'company.local.yaml'), ...extra] = process.argv.slice(2);
try {
  if (extra.length || !['init', 'check', 'build'].includes(command))
    throw new Error('Usage: pnpm run company:{init|check|build} [harness/company.local.yaml]');
  if (command === 'init') {
    fs.writeFileSync(file, fs.readFileSync(path.join(root, 'company.example.yaml')), { flag: 'wx', mode: 0o600 });
    console.log(`Created ${file}. Fill in sections 1–7, then run company:check. Existing files are never overwritten.`);
  } else {
    const company = readCompany(file);
    const checks = inspectCompany(company);
    for (const check of checks)
      console.log(`${check.level === 'error' ? 'TODO' : 'NOTE'} ${check.field}: ${check.message}`);
    if (checks.some((check) => check.level === 'error')) {
      process.exitCode = 1;
    } else {
      // Also check cron expressions, resolved routes, duplicate bindings, etc.
      const config = resolveCompany(company);
      if (command === 'check')
        console.log(
          `Configuration ready to build: ${config.jobs.length} enabled workflows. Live integrations have not been verified.`,
        );
      else {
        const result = buildCompany(company, root, path.join(root, 'generated'));
        console.log(`Built ${result.jobs} workflows in ${result.output}. Nothing was deployed or connected.`);
      }
    }
  }
} catch (error) {
  // YAML parser errors are sanitized by readCompany; never print the document.
  console.error(error instanceof Error ? error.message : 'Company setup failed');
  process.exitCode = 1;
}
