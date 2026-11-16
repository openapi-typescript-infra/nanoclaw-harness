---
name: github-pr-review
description: Review allowlisted GitHub pull requests and optionally publish one conversation comment when explicitly requested.
---

# GitHub pull request review tools

Get PR metadata first and pin both SHAs. Follow `nextPage` through the
changed-file list and reconcile it with the metadata count. For every listed
file, call `github_pr_review_get_pull_request_file` with its page and path.
Follow `nextOffset` until null. If a patch is incomplete, compare the pinned
base and head text views, reading all chunks. Recheck both revisions at the end.
Report a blocker if full coverage is impossible, and only issue a review or
post a comment after all changed files have been reviewed.

The server permits only repositories listed in its generated allowlist. It
supports read requests plus creating one top-level pull request conversation
comment after explicit user authorization. It cannot approve, request changes,
edit or delete comments, modify pull request metadata, or change repository
contents. The comment tool rechecks that the PR is open and its head SHA has not
changed. API credentials are supplied by the deployment's OneCLI credential gateway for
`api.github.com`; never ask for, print, or store a token in a Slack message,
skill, shell command, or plugin configuration.

If GitHub returns 401 or 403, report that repository access is not connected or
does not have the required permissions. Do not retry with another identity or access
another repository. A 404 can mean either that the PR does not exist or that the
configured identity cannot see the private repository.
