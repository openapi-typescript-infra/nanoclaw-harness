// Product capabilities live here; company-specific choices live in company YAML.
export const workflowCatalog = {
  conversation: {
    available: true,
    playbook: 'conversation.md',
    skills: [] as string[],
    description: 'Slack conversation',
  },
  incident: {
    available: true,
    playbook: 'incident.md',
    skills: ['incident-triage'],
    description: 'Incident investigation using installed tools',
  },
  'daily-health': {
    available: true,
    playbook: 'daily-health.md',
    skills: ['incident-triage'],
    description: 'Scheduled health report',
  },
  'ios-check': {
    available: true,
    playbook: 'ios-check.md',
    skills: ['macos-checks'],
    description: 'Native Mac recipe worker (not Tart provisioning)',
  },
  'pr-review': {
    available: false,
    playbook: '',
    skills: [] as string[],
    description: 'PR review integration is not implemented',
  },
  'implement-change': {
    available: false,
    playbook: '',
    skills: [] as string[],
    description: 'GitHub change-to-draft-PR flow is not implemented',
  },
} as const;

// Declaring a provider is not installing or authenticating its connector.
export const integrationCatalog = {
  posthog: { capability: 'product-analytics', available: false },
  mixpanel: { capability: 'product-analytics', available: false },
  sentry: { capability: 'error-tracking', available: false },
  jira: { capability: 'issue-tracking', available: false },
  linear: { capability: 'issue-tracking', available: false },
  bigquery: { capability: 'warehouse', available: false },
  github: { capability: 'source-control', available: false },
} as const;
