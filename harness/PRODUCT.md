# Portable company agent

## Deliverable

An agent a company can provision under its own identity, connect to Slack and
GitHub, and operate on its own infrastructure. A generic corporation is the reference example;
the same release must work for another company through configuration and company
content, without source edits or access to another company’s systems.

One installation belongs to one company. Each has independent credentials,
model authentication, conversations, memory, job history, repository checkouts,
artifacts, and backups. Share code and generic skills across installations, not
runtime state. Start with a dedicated Linux VM per company. An optional Apple
Silicon host supplies macOS workers.

This document describes the target product. The offline company onboarding
configuration is implemented; live account setup, GitHub review integration,
and Tart lifecycle still need implementation and verification as described below.

## What the operator supplies

- Company name, agent name, timezone, and a responsible human administrator.
- A company-controlled workspace identity for account provisioning and recovery.
- A Slack app installation with the agent's visible name, approved channels,
  allowed members, and administrator identity.
- A GitHub identity: preferably an installation-scoped GitHub App for the product,
  with a machine-account adapter available where existing tooling needs one.
  Repository selection and permitted actions are explicit deployment settings.
- An eligible ChatGPT/Codex account and subscription authentication. Slack and
  GitHub identities do not determine model-account entitlement.
- Company context, repository guidance, selected skills, enabled workflows, and
  schedules. Jira, incident tools, and native mobile execution are optional.

The workspace user is the administrative identity; Slack uses its bot identity
and GitHub uses its configured app or machine account. These credentials are
connected separately rather than assuming one login grants all integrations.

## Reusable core and company configuration

The reusable core owns event routing, durable jobs, isolated agent execution,
conversation continuity, credential boundaries, result delivery, and operations.
Company configuration owns display identity, account bindings, access policy,
repositories, workflow selection, instructions, and integration endpoints.

Generic workflows should include:

| Workflow                   | Start                                            | Result                                                  |
| -------------------------- | ------------------------------------------------ | ------------------------------------------------------- |
| Conversation/investigation | Slack mention or thread follow-up                | Evidence and response in that thread                    |
| PR review                  | Slack request or configured GitHub review signal | Findings in Slack and, when enabled, a GitHub review    |
| Implement a change         | Explicit authorized request                      | Validated changes and a draft PR                        |
| Scheduled report           | Configured schedule                              | Report to its configured destination                    |
| Native mobile validation   | An authorized workflow step                      | Simulator/test evidence attached to the originating job |

Repository names, issue prefixes, incident tools, private network routes, and
industry-specific review rules are optional company content. Keep them outside
the generic core and preserve applicable upstream licenses.

## Component responsibilities

- **NanoClaw:** session mailboxes, permissions, isolated Codex containers,
  provider/gateway integration, and Slack delivery.
- **Workflow layer:** declarative jobs, triggers, playbooks, selected skills,
  persistent conversations, and result destinations.
- **Review lifecycle:** review request detection, debounce, durable review queue,
  context preparation, prior findings, stale-commit rejection, structured
  findings, and publication. Extract these behind a reviewer execution interface
  so the current Claude call can be replaced by the Codex execution path.
- **Shared host service / Tart:** optional execution service for bounded build and
  test jobs. Start by dispatching to existing GitHub Actions runners. Add VM
  leasing only when interactive simulator sessions require it.

Review triggers from Slack and GitHub converge on one review lifecycle. One
component owns deduplication and publication. Preserve the reviewed head SHA,
base revision, request identity, findings, and artifact references. Before
publishing, verify that the head is still current; requeue stale work. A deliberate
new review request for the same SHA remains distinguishable from event redelivery.
The agent returns structured findings; the trusted publisher owns write access.

Persist the initiating user's identity separately from the agent's service
identity. A GitHub trigger must pass repository and sender policy just as a Slack
request passes channel and membership checks. Repository content and review
comments are task input, not authority to expand permissions.

Native execution checks out the requested revision and returns artifacts before
the disposable VM is deleted. A company without a Mac can run all non-mobile
workflows. Mac workers do not need copies of the planner's model login.

## Models, subscriptions, and execution profiles

One company agent can use several models and several separately authenticated
subscriptions. Its visible Slack/GitHub identity stays the same. Keep three
independent choices: the workflow's purpose, the model/account executor, and the
tools' Linux or macOS execution environment.

The target configuration names accounts separately from execution profiles:

- An **account** references a company-owned credential binding and provider,
  authorized users/jobs, concurrency cap, and authentication health. It contains
  no raw credentials. Two subscriptions to the same provider are distinct
  accounts. Different providers need their own supported runtime adapters.
- An **execution profile** selects an account, model, and reasoning effort. Several
  profiles can share one subscription, so their scheduling limit is shared too.
- A **job** selects its default profile. Explicit workflow steps may override it,
  for example a quick triage pass, a deeper investigation, independent reviewers,
  and a final synthesis. A skill supplies procedures, not account authority.

Illustrative routing, not yet supported registry syntax:

| Portion          | Profile            | Account       |
| ---------------- | ------------------ | ------------- |
| Slack triage     | quick-response     | primary-codex |
| Implementation   | deep-coding        | primary-codex |
| PR reviewer      | independent-review | review-codex  |
| Review synthesis | deep-coding        | primary-codex |

Profile names are operator-defined aliases. Resolve actual model identifiers and
supported reasoning settings against each authenticated runtime during setup;
never assume the same model is available on every subscription. The coordinator
resolves defaults and overrides before starting work, verifies account access,
and records the resolved profile/account/model on the run. Those choices are not
prompt instructions the executing agent may change.

Each account needs isolated authentication state and refresh ownership. Scheduling
and capacity accounting are per account, not per profile. Keep ordinary workload
allocation explicit; an exhausted or revoked account should wait or report its
state, with any fallback separately configured and authorized. Multiple accounts
are not an implicit quota-rotation pool. No paid API fallback is enabled.

Account or provider changes start a new provider session with an explicit context
handoff; do not reuse another account's opaque thread ID or credential cache.
Parallel reviewers receive independent contexts; the synthesis step consumes
their findings. Persist step results and revision/artifact references so retries
do not repeat completed publications or lose the reviewed revision.

Implementation status: the starter now accepts installation and per-job model/
effort settings and applies them through NanoClaw's existing group configuration.
The current OneCLI binding is provider-scoped; it does not implement account
selection. Before enabling multiple subscriptions, add and test a credential
binding that selects exactly one authorized account per executor, or isolate
accounts in separate worker installations behind the coordinator. Keep one Slack
listener; model workers should not each subscribe to the same Slack app events.
Step execution, execution profiles, account scheduling, and context handoffs are
still planned work, not implied by the current inference configuration.

## Subscription contract

Use Codex with subscription authentication and no automatic API-key fallback.
Usage limits pause or defer work with a visible status; they must not silently
turn into metered model charges. Infrastructure costs remain separate.

OpenAI documents subscription sign-in and an advanced trusted private automation
path. That path requires preserving refreshed credentials and avoiding concurrent
use of a copied auth file. It does not cover external-token host integrations.
The pinned OneCLI integration's refresh behavior therefore needs its own live
verification; the generic Codex guide does not prove this gateway works unattended.

The available documentation does not establish that buying a Pro subscription
for a workspace identity entitles a whole company to share it through a bot.
Confirm the intended account and usage arrangement before team rollout. Keep the
authentication adapter separate so an eligible workspace authentication method
can be used without changing workflows. Enterprise access tokens are a documented
option for permitted Enterprise members, but are not implemented in this starter.

Sources: [Codex authentication](https://learn.chatgpt.com/docs/auth),
[trusted private automation](https://learn.chatgpt.com/docs/auth/ci-cd-auth).

## Installation experience and acceptance criteria

The intended setup experience is: select a release, create the company
configuration, connect accounts, select repositories/channels/workflows, run
readiness checks, and start the service. Browser consent, subscriptions, and
external account creation remain explicit operator steps.

A release is ready for this deliverable when a fresh installation can:

1. Configure a corporation’s name and identity without editing source or borrowing
   another company’s credentials, prompts, or infrastructure.
2. Answer an authorized Slack mention and continue in its thread after restart.
3. Review a configured private GitHub PR, return findings, and publish under the
   configured GitHub identity when publication is enabled.
4. Recover a queued review after restart, deduplicate redelivered events, and
   withhold stale findings when the PR changes during execution.
5. Create a draft PR after an authorized change request, reporting the checks
   actually run and any checks unavailable in that environment.
6. Report revoked credentials and exhausted subscription capacity without paid
   model fallback; reconnect without losing company state.
7. Back up, restore, upgrade, and remove an installation independently of other
   companies. Readiness output must distinguish configured from live-verified
   integrations and must not print credentials.
8. Optionally dispatch mobile validation to a Tart worker and recover artifacts
   tied to the requested revision.

## Implementation order and current status

The current starter has a central company YAML, an offline fill-in checklist,
named access groups/channels/model profiles, company context, and generation of
Slack manifests and deployment settings. It resolves enabled workflows into
declarative Slack jobs and provisions them through NanoClaw. Integration choices
are inventoried but unsupported active connectors/account routes are rejected.
Codex-enabled images and a native Mac recipe worker are also present. The README
records local checks; no live company installation has been connected.

Next, add live onboarding checks and connector adapters, then extract the review
lifecycle and add Codex execution. Build account routing and durable
step handoffs as part of that execution boundary. Prove a Slack-requested report-only review,
then GitHub triggers and publication. Add authorized change-to-draft-PR work and
operational recovery checks. Finally integrate runner dispatch and optional Tart
sessions. The portable Slack/GitHub product is the primary milestone; mobile
workers are an extension.
