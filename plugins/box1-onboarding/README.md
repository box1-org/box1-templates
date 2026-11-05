# Development onboarding module

Canonical source for the RHDH 1.9.7 / Backstage 1.45.3 dynamic backend module.
It registers `box1:repository:ensure`, the `box1:development:` actions `provision`,
`platform`, `build`, `promote`, `verify` and `onboard`, and the `box1:catalog:` actions
`submit`, `verify` and `ensure`.
No private runtime dependencies are bundled; the compatible Hub image supplies
the declared peer dependencies. Run `npm run package:onboarding` from
box1-templates to copy the three runtime files into the sibling box1-gitops
ConfigMap transport and refresh the Deployment source checksum. Review/publish
both repositories together; `npm run check:onboarding-package` detects drift. The installer stages real files because npm pack
ignores ConfigMap-volume symlinks. The adapter invalidates only this small local
module's cache hash on every boot to avoid the 1.9 local-package reinstall cleanup
removing the new module; installed third-party plugins retain their caches.

The source repository marker and a durable `rhdh/box1-onboard-<name>` ConfigMap
bind one request to one source repository, development namespace, PR pair and
initial PipelineRun. A renewable Kubernetes Lease prevents concurrent tasks for
the same name. Retry with the identical name, owner, visibility and description;
unmanaged existing repositories and reserved baseline names are rejected.

States: REQUESTED → REPOSITORY_READY → CATALOG_SUBMITTING → CATALOG_SUBMITTED →
ONBOARDING_PR_OPEN → ONBOARDING_MERGED → PLATFORM_SYNC_REQUESTED → BUILD_RUNNING →
IMAGE_BUILT → PLATFORM_READY → PROMOTION_PR_OPEN → PROMOTION_MERGED →
PROMOTION_SYNC_REQUESTED → DEPLOYMENT_READY → CATALOG_REGISTERING → COMPLETE.
PLATFORM_APPS_SYNCED replaces PLATFORM_SYNC_REQUESTED when the service Application is
already at the expected revision. FAILED retains the prior successful state, failed
stage, diagnostic message, timestamps and resource links. State transitions are
visible in scaffolder task logs. Waits observe bounded API conditions; polling
intervals are not readiness assumptions.

Both PRs are limited to this service's development files. Required check names
and their `box1-pipelines` App identity, current head SHA, full file contents,
namespace and RBAC allowlist must pass before merge. Failed required checks are
never overridden: up to two new commits with the identical GitOps tree trigger
fresh validation; then the task fails explicitly. Other environments and the
existing orders-service baseline cannot be selected. Repo creation and merges
use the configured Hub GitHub App; all installation tokens are short lived.

The template runs these phases in order, and `box1:development:onboard` is a
compatibility wrapper that runs the same five development phases:

1. `box1:development:provision` merges the onboarding PR.
2. `box1:development:platform` syncs the `box1-workloads-dev` Argo Application,
   waits for the service Application, requests its sync without waiting for the
   result, then waits only for the build prerequisites: the active Namespace, the
   `ci-build` ServiceAccount and its registry push binding.
3. `box1:development:build` runs the first `box1-quarkus-maven` build and, alongside
   it, waits for the service sync and the full readiness set: Namespace,
   ServiceAccounts, registry bindings, observer roles, PAC registration, Application
   sync and Deployment existence. A build failure stops those observers. A platform
   failure lets the build finish, so its digest is kept and a retry does not rebuild.
4. `box1:development:promote` requires platform readiness, merges the separate checked
   promotion PR, then requests a sync of the service Application to the merge commit.
5. `box1:development:verify` requires the expected immutable image, current Deployment
   generation Available, Argo Synced/Healthy, public readiness UP and `/api/info`
   matching the original source SHA. It fails at once if the requested sync fails.

`box1:catalog:submit` runs before these phases and does not wait for catalog
processing. `box1:catalog:verify` runs after them. Scaffolder steps run one at a time,
so the build and readiness overlap happens inside `box1:development:build`.

Sync requests wait for any active Argo operation to finish first and are skipped when
the Application is already at the expected revision. A failed operation blocks the
request, and a retry does not start a new sync, so a manual sync may be needed.

The build credential is a fresh one-hour installation token limited to
source-repository Contents read. The Secret exists before PipelineRun creation, is
removed after the build succeeds or fails, and is also owned by the PipelineRun for
garbage collection. A failed build can be retried by resubmitting the template (at
most three recorded attempts); a running or successful build is reused. The credential
lifecycle stays inside one action, so there is no separate build start and wait step.

Runtime Kubernetes permissions are separate from the read-only plugin service
credentials. The provisioner can manage state/leases in rhdh and bootstrap build
Secrets/PipelineRuns in box1-ci, plus get readiness resources. It can patch
Argo Applications in `openshift-gitops` to request syncs, but cannot delete them. That
permission is not limited to service Applications. It cannot mutate workload
Deployments or Namespaces, or grant RBAC. Namespace
resources are created only by the existing Argo GitOps controller after merge.
The Hub backend is a trusted privileged component: protect template edits and
Hub administration accordingly. Do not expose these actions to untrusted users.

Validation: `npm run validate && npm run test:onboarding`. The latter exercises
development-only scope, baseline protection, lease exclusion, readiness gates,
credential/run creation ordering, completed-build reuse, and exact-check/App
merge gating. Live acceptance uses POST `/api/scaffolder/v2/tasks` with the normal
GitHub-authenticated user or existing backend automation authentication.

Catalog registration reuses an existing matching entity. If only its source
Location exists, a 409 is treated as a pending registration and the action waits
for the matching entity. Other catalog errors propagate immediately; an entity
with a different source repository fails validation. Completed-workflow replay
therefore does not fail on duplicate catalog locations.
