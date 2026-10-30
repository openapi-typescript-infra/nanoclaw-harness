# Put your company specifics here

Use one `harness/company.local.yaml` per installation. Start from the commented
template; names such as `engineering`, `team`, `standard`, and `analytics` are
aliases you choose. Each actual user ID, channel ID, model choice, and integration
setting is entered once, then referenced by workflows.

From the repository root:

```sh
pnpm run company:init
# Edit harness/company.local.yaml, working through its seven sections.
pnpm run company:check
pnpm run company:build
```

`init` creates a private, Git-ignored file and refuses to overwrite an existing
one. All three commands accept a file path as their final argument. The default
local YAML filenames are also excluded from Docker's build context; keep custom
filenames outside the checkout or add matching ignore rules. Do not put tokens
or passwords in YAML, even though the file is private.

## The checklist

| Section         | Put your specifics here                                                      | What it controls                                                  |
| --------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1. Company      | ID, display name, agent name, timezone, business/event definitions           | Slack branding and instructions in every workflow                 |
| 2. Deployment   | Absolute checkout path on a dedicated Linux VM                               | Matching host/container paths and generated Compose settings      |
| 3. Slack        | Named users and channels, owner, access groups                               | Who can invoke each job and where it responds                     |
| 4. Execution    | Account inventory and named model/effort profiles                            | Per-job inference settings on the active Codex account            |
| 5. Integrations | Provider, regional/self-hosted origin, named resources, credential reference | Central inventory for optional connectors; see availability below |
| 6. Workers      | Named HTTPS Mac endpoint and allowed recipes                                 | Optional native macOS tool execution                              |
| 7. Workflows    | Enablement, preset, channel, access group, model profile, trigger            | The jobs that are actually generated and provisioned              |

For ParkTab, change `company.id`, `company.name`, and `company.agentName`, then
replace the example Slack IDs. Keep the company context specific to your own
products: a provider swap does not translate another company's event names or
definitions of conversion, activation, revenue, and retention.

To choose Mixpanel instead of PostHog, change `integrations.analytics.provider`
and its endpoint/resource details. Workflows continue referring to `analytics`.
This centralizes the choice; it does not install a connector. Adding analytics
to an active workflow currently fails the check because neither adapter exists.

Model profiles select an account plus a model and reasoning effort. `null` uses
the runtime default. Multiple profiles on the active account work today. A
profile selecting another subscription is rejected when an enabled workflow
uses it. `activeAccount` labels the login configured on this installation; it
does not authenticate or verify that account. Actual model availability and
effort compatibility require a live authenticated runtime.

## What is available

| Choice                                                                 | Current behavior                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Conversation, incident, daily-health presets                           | Generate real NanoClaw templates; evidence still requires installed tools |
| Named Slack channels/users/access groups                               | Resolve to provisioning permissions and routes                            |
| Company instructions and agent name                                    | Included in templates and the generated Slack manifest                    |
| Codex profiles on one account                                          | Applied as native group model/effort settings                             |
| Native Mac recipes                                                     | Use the existing MCP worker; endpoint/auth setup is separate              |
| PostHog, Mixpanel, Sentry, Jira, Linear, BigQuery, GitHub connectors   | Inventory only; blocked if required by an enabled workflow                |
| PR review / implement-change presets                                   | Planned; blocked when enabled                                             |
| Multiple subscription routing, Claude executor, per-step model changes | Planned; not enabled by listing accounts/profiles                         |
| Tart VM creation / GitHub Actions dispatch                             | Planned; a worker URL does not create a VM                                |

These definitions live in `company-catalog.ts`, so the setup check and resolver
use the same availability list. Optional disabled workflows may stay in the YAML
as your setup checklist. Their references and syntax must still be valid; example
Slack IDs on unused channels do not prevent an otherwise complete setup.

## What gets generated

`company:check` is offline and does not contact any service. It reports missing
inputs, unknown references, unsupported active choices, invalid schedules, and
ambiguous routes. A successful check means the configuration can be built; it
does not mean credentials or integrations have been verified.

`company:build` writes the following under `harness/generated/`:

- `templates/`: actual NanoClaw templates, checked by NanoClaw's own parser.
- `jobs.json`: the resolved low-level job registry, useful for inspection.
- `slack-app-manifest.json`: the app manifest with your agent's display name.
- `deployment.env`: Compose project name and host checkout path.
- `runtime.env.example`: blank credential fields, the correct template path,
  and your timezone, ready to copy to `.env` on first installation.

Generated files are disposable and are replaced on each successful build. Edit
the company YAML, not generated files. Build validation failures preserve the
existing output. Legacy `jobs.local.json` remains supported, but use the company
YAML as the source of truth for new installations.

## Connect and activate

The remaining external setup is deliberate: install the generated Slack app,
put its tokens in the installation's `.env`, configure the gateway, and complete
Codex sign-in. `runtime.env.example` is only a first-install template; do not
overwrite an existing `.env` or vault when rebuilding configuration. Follow
[Linux VM rollout](README.md#linux-vm-rollout) for these steps.

On the target VM, run from the exact `deployment.root` directory. Use the generated
Compose settings so you do not re-enter paths:

The target may be a cloud Linux VM or a persistent Tart Linux guest on an Apple
Silicon Mac. Mac simulator jobs use separate macOS guests. Neither VM creation
nor Tart lifecycle is performed by the company setup commands.

```sh
docker compose --env-file harness/generated/deployment.env -f harness/compose.yaml build
docker compose --env-file harness/generated/deployment.env -f harness/compose.yaml up -d
pnpm run harness:provision harness/company.local.yaml
```

Provisioning accepts the company YAML directly and applies only enabled workflows.
Schedules start paused. Verify a permitted Slack mention and a denied unlisted
user before enabling more members or schedules. No GitHub publication or model
request happens during `init`, `check`, or `build`.

Configuration changes after provisioning still require the explicit update
procedure in the README: this starter does not yet reconcile removed permissions
or changed profiles automatically. Each company uses its own installation,
state, credentials, and backups.

For shared-box deployment and independent company releases, see [the host API integration](HOST-API.md).
