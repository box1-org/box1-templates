# Development onboarding module

Canonical source for the RHDH 1.9.7 / Backstage 1.45.3 dynamic backend module.
It registers `box1:repository:ensure` and `box1:development:onboard`.
No private runtime dependencies are bundled; the compatible Hub image supplies
the declared peer dependencies. Run `npm run package:onboarding` from
box1-templates to copy the three runtime files into the sibling box1-gitops
ConfigMap transport and refresh the Deployment source checksum. Review/publish
both repositories together. The installer stages real files because npm pack
ignores ConfigMap-volume symlinks, and invalidates only this module's cache hash
when source changes.

The source repository marker and a durable `rhdh/box1-onboard-<name>` ConfigMap
bind one request to one source repository, development namespace, PR pair and
initial PipelineRun. A renewable Kubernetes Lease prevents concurrent tasks for
the same name. Retry with the identical name, owner, visibility and description;
unmanaged existing repositories and reserved baseline names are rejected.

States: REQUESTED → REPOSITORY_READY → ONBOARDING_PR_OPEN → ONBOARDING_MERGED →
PLATFORM_READY → BUILD_RUNNING → IMAGE_BUILT → PROMOTION_PR_OPEN →
PROMOTION_MERGED → COMPLETE. FAILED retains the prior successful state, failed
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

The initial build explicitly reuses `box1-quarkus-maven`, after Namespace,
ServiceAccounts, registry bindings, observer roles, PAC registration, Application
sync and Deployment existence are observed. Its credential is a fresh one-hour
installation token limited to source-repository Contents read. The Secret exists
before PipelineRun creation, is removed after successful build, and is also
owned by the PipelineRun for garbage collection. A failed build can be retried
by resubmitting the template (at most three recorded attempts); a running or
successful build is reused. The first image promotion is a separate checked
GitOps PR. Deployment completion requires the expected immutable image, current
Deployment generation Available, Argo Synced/Healthy, public readiness UP and
`/api/info` matching the original source SHA.

Runtime Kubernetes permissions are separate from the read-only plugin service
credentials. The provisioner can manage state/leases in rhdh and bootstrap build
Secrets/PipelineRuns in box1-ci, plus get readiness resources. It cannot mutate
workload Deployments, Argo Applications, Namespaces, or grant RBAC. Namespace
resources are created only by the existing Argo GitOps controller after merge.
The Hub backend is a trusted privileged component: protect template edits and
Hub administration accordingly. Do not expose these actions to untrusted users.

Validation: `npm run validate && npm run test:onboarding`. The latter exercises
development-only scope, baseline protection, lease exclusion, readiness gates,
credential/run creation ordering, completed-build reuse, and exact-check/App
merge gating. Live acceptance uses POST `/api/scaffolder/v2/tasks` with the normal
GitHub-authenticated user or existing backend automation authentication.
