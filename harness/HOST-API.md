# Separate shared-host infrastructure

The company agent remains in this repository. The shared Mac service is a
separate `company-vm-host` package, maintained in its own infrastructure repository.
They have separate Git histories, configuration, processes and release versions.
There are no cross-repository imports, shared source mounts or npm workspace links.
The compatibility boundary is HTTP API `/v1`, not a shared deployment checkout.

Each company has its own persistent Linux VM, release checkout, Docker images,
Slack app, gateway, model authentication, databases and backups. The host starts
those persistent VMs with independent machine supervisors. Changing a company's
code or credentials does not upgrade another company or the host service.
Persistent VM disks are preserved; replacing a base image requires migration.

Disposable worker VMs are siblings of those Linux VMs. The host service owns
Tart/Softnet, worker images, fixed recipes, per-company quotas, shared capacity,
leases and cleanup. Company agents receive neither host shell access nor Tart
credentials. GitHub CI cycles and agent leases use the same worker allocator.

## Company configuration

Add a worker binding in company.local.yaml:

```yaml
workers:
  mobile:
    url: https://vm-host.your-company.example/
    hostProfile: ios
    recipes: [simulators, ios-tests]
```

Bind an enabled `ios-check` workflow to `worker: mobile`. The existing company
compiler generates an MCP client for the host API. Without `hostProfile`, a
worker retains the original standalone recipe-worker behavior.

Set up this company's host bearer token in its gateway for that exact HTTPS
origin. The generated client uses a placeholder token; the gateway injects the
real credential. Do not put a host token in YAML or share it across companies.
The API derives company ownership from that token. TLS/gateway injection still
requires live verification on the deployed installation.

The client discovers API v1 and the named profile, requests a company-scoped
lease, waits for readiness, and keeps that VM for successive `macos_run` calls.
It renews the lease while the MCP process is alive and releases it on explicit
`macos_release`, stdin closure or process termination. TTL bounds orphaned work;
a busy guest may take until its bounded recipe completes to release. Restarting
the client starts a new lease rather than adopting another session's VM.

The host's company profile chooses the image, CPU/RAM, SSH identity and fixed
recipe argv. A company cannot supply shell commands, mounts, image names or
resource overrides through this client. Recipe output returns to the requesting
agent. Large artifacts require a company-specific recipe and artifact store.
Automatic repo/patch synchronization and general GUI interaction are still
separate workflow features; leasing alone does not implement them.

## Network and upgrades

Persistent company VMs and job VMs use Softnet. A host-owned reverse SSH tunnel
exposes only the broker on each persistent guest's loopback. That company manages
an HTTPS proxy inside its Linux VM; its gateway connects there. This avoids
opening private-network access from disposable macOS guests. Follow the host
package's setup for SSH forwarding and target-host network verification.

Companies may evolve independently as long as they support API v1. The host
package's contract describes request/response formats; the company client has no
knowledge of host filesystem paths. Drain job leases before changing host profile
images/recipes or upgrading the host service. Persistent company services have
their own upgrade procedure and remain independently supervised.

The host migration requires draining old macVM slot daemons, installing the
updated guarded runner/bake scripts, and creating the managed-host marker. The
broker refuses startup without that marker. Legacy direct Tart cycles must not
run alongside the broker because they bypass shared capacity. Image baking is
an explicit maintenance operation.

Implemented and tested with simulated VM drivers: API scoping, shared scheduling,
leases, restart cleanup, company bindings, and client/server interoperability.
Live Tart boot, Softnet, SSH tunnel, GitHub JIT registration and iOS execution
require deployment on a prepared Mac; this development host has no Tart installed.
