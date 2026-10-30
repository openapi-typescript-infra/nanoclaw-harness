import { readConfig } from './config.js';
import { readCompany, resolveCompany } from './company.js';

/** YAML is the company onboarding format; JSON retains the low-level job format. */
export function loadConfig(file: string) {
  return /\.ya?ml$/i.test(file) ? resolveCompany(readCompany(file)) : readConfig(file);
}
