# Box1 Software Templates

Platform-owned Developer Hub golden paths. Start with **Create → Create Quarkus Service** at https://developer-hub.apps.ocp.box1.org/create.

The `quarkus-rest-service` template creates a repository under `box1-org`, a
catalog Component, and a GitOps onboarding PR. Its application skeleton derives
from the proven Quarkus reference at
`b1a2026552bd9bf09f091b05d6b1cba41ea4b72d`. It includes Java 21, Quarkus 3.40.1.1,
Maven wrapper, unit/HTTP/packaged tests, Checkstyle, FindSecBugs, immutable Git
metadata, Jib with a pinned UBI runtime, and centrally resolved Tekton tasks.

Development workloads run in `<service>-dev` with a matching Route hostname.
The GitOps skeleton supplies Namespace, Deployment, probes, Service, TLS Route,
hashed ConfigMap, runtime ServiceAccount, image-puller binding, PAC Repository,
scoped observer RBAC, and an automatically reconciled Argo CD Application.
The central Tasks remain in `box1-gitops`; generated repositories own only their
PipelineRun definitions and application code.

## Ownership and prerequisites

Template owner: `user:default/mike4263`. Developers select an imported catalog
User or Group for each service. Both GitHub Apps must remain installed for all
organization repositories: Developer Hub creates repositories and onboarding
PRs; Box1 Pipelines handles GitHub events and short-lived CI tokens.

Developer Hub needs its bundled GitHub scaffolder backend module enabled, and
Contents, Administration, Pull requests write permissions on its App. It uses
App authentication; the form never requests a personal access token.
GitOps `pipelines-ci` must contain the parameterized Phase 4 tasks. The existing
root Argo Application discovers newly merged `applications/*.yaml` files.

Onboarding remains a reviewed GitOps PR. Merge it and wait for Argo reconciliation
before the first application change. The repository creation event precedes PAC
registration, so the first delivery starts with the next push. Until then the
Deployment has zero replicas and a non-runnable zero digest. Promotion activates
it with the digest from its own successful Jib build. Application code is never
deployed by the scaffolder or Tekton.

## Layout and validation

- `catalog-info.yaml`: Location for registration/discovery.
- `templates/quarkus-rest-service/template.yaml`: supported scaffolder actions.
- `templates/quarkus-rest-service/skeleton/`: application repository.
- `templates/quarkus-rest-service/gitops/`: allowlisted onboarding files.
- `scripts/validate.mjs`: render/schema/Kustomize checks for multiple names.

Install Node.js 20.11+ and `kubectl`, then run `npm ci && npm run validate`. The validation uses the same Nunjucks variable
delimiters as `fetch:template`, checks action inputs against the live exported
schemas when available, and renders both application and GitOps manifests.
Live acceptance evidence is recorded in `VERIFICATION.md`.

Maintain changes through PRs and retest a generated project when updating the
Quarkus BOM, runtime digest, plugin versions, pipeline contract, or manifests.
Java package/group `org.box1` and the lab ingress/registry are deliberately fixed.
Generated repository names must be unique, 3–35 characters, DNS-safe, and may not
start with `box1-`, `openshift-`, or `kube-`, or reuse platform names. Repository publishing fails on an
existing name; it does not overwrite a repository. If a later step fails, inspect
the task output and existing repository/PR before retrying with that name.
