# Box1 Software Templates

Platform-owned Developer Hub golden paths. Start with **Create → Create Quarkus Service** at https://developer-hub.apps.ocp.box1.org/create.

The `quarkus-rest-service` template creates a repository under `box1-org`, a
catalog Component/API, and a deployed development service through checked GitOps PRs. Its application skeleton derives
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

The `github-repository` template (**Create → Create GitHub Repository**) creates
a plain repository under `box1-org` for documentation or configuration, such as
`box1-docs` or `box1-gitops`. It generates only a README and catalog entry, with
no build, pipeline, namespace, or deployment. Names that already exist are refused.

## Ownership and prerequisites

Template owner: `user:default/mike`. Developers select an imported catalog
User or Group for each service. Both GitHub Apps must remain installed for all
organization repositories: Developer Hub creates repositories and onboarding
PRs; Box1 Pipelines handles GitHub events and short-lived CI tokens.

Developer Hub needs its bundled GitHub scaffolder backend module enabled, and
Contents, Administration, Pull requests write permissions on its App. It uses
App authentication; the form never requests a personal access token.
GitOps `pipelines-ci` must contain the parameterized Phase 4 tasks. The existing
root Argo Application discovers newly merged `applications/*.yaml` files.

Development onboarding PRs are validated and merged by the workflow under the
platform's development-only allowlist. It observes namespace, ServiceAccount,
registry, observer, PAC and Argo readiness before explicitly starting the initial
CI build. The creation webhook is not used as a first-delivery trigger. The
Deployment starts at zero replicas with a zero digest and is activated only by
a checked first-image promotion. Only Argo CD applies workload manifests.

## Layout and validation

- `catalog-info.yaml`: Location for registration/discovery, and this repository's catalog Component.
- `templates/quarkus-rest-service/template.yaml`: supported scaffolder actions.
- `templates/quarkus-rest-service/skeleton/`: application repository.
- `templates/quarkus-rest-service/gitops/`: allowlisted onboarding files.
- `scripts/validate.mjs`: render/schema/Kustomize checks for multiple names.

Install Node.js 20.11+ and `kubectl`, then run `npm ci && npm run validate`. The validation uses the same Nunjucks variable
delimiters as `fetch:template`, checks action inputs against the live exported
schemas when available, and renders both application and GitOps manifests.
Initial acceptance evidence is recorded in [VERIFICATION.md](VERIFICATION.md).
The requested orders-service creation, redeployment, and rollback demonstration
is recorded in [MILESTONE-DEMO.md](MILESTONE-DEMO.md).

### `rhel-image-vm`: optional cloud-init (`cloudInit`)

`cloudInit` (default `false`, box1-docs#140) installs cloud-init in the OS image,
restricted to the NoCloud datasource (`datasource_list: [ NoCloud, None ]`). It
lets one image boot as several VM instances: an instance VM that attaches a
`cloudinitdisk` volume with `cloudInitNoCloud.secretRef` gets its site
configuration and machine credential as files. The image configuration
(`skeleton/{% if ... %}rootfs-cloud-init{% endif %}/`, copied only when the
parameter is on) runs only `write_files`, on every boot, with networking and
vendor-data disabled. Accounts, SSH keys, passwords, disks and packages stay with
the image, qemu-guest-agent and bootc; `sshd-keygen` keeps generating host keys.
These module lists shape what Box1-generated user-data does; they are not a
security boundary, because user-data can override them. Write access to an
instance's cloud-init Secret is root in that guest.
The GitOps bundle this template generates is the same either way; the VM it
creates boots without a NoCloud disk. Instance bundles come from the `vm-instance`
profile (box1-docs#138). The Secret is assembled outside Git with the box1-docs
runbook `runbooks/vm-cloud-init-identity.md`.

With the parameter off, the rendered repository must be byte-identical to the
template before the parameter existed. `npm run validate` checks that off and
omitted render the same; to compare with a revision, run
`VM_BASELINE_REF=origin/main npm run validate` (or any other Git ref).

Maintain changes through PRs and retest a generated project when updating the
Quarkus BOM, runtime digest, plugin versions, pipeline contract, or manifests.
Java package/group `org.box1` and the lab ingress/registry are deliberately fixed.
Generated repository names must be unique, 3–35 characters, DNS-safe, and may not
start with `box1-`, `openshift-`, or `kube-`, or reuse platform names. Existing unmanaged repositories are rejected. Requests with matching durable
ownership records resume their previous repositories, PRs and initial builds.
Catalog registration is idempotent, and completion requires the catalog entry
as well as the verified deployment.

## Zero-touch development onboarding (template 1.2.0)

The Quarkus template creates or resumes its source repository and then runs the
stateful development workflow from [plugins/box1-onboarding](plugins/box1-onboarding/README.md).
It validates and merges the scoped GitOps onboarding PR, requests the platform
sync, starts the first CI build once its prerequisites exist, confirms platform
readiness alongside the build, validates and merges the immutable development
image promotion, requests its Argo sync, and verifies the public deployment.
No manual merge, arbitrary delay, or additional source push is required.

The task output includes source, catalog, initial pipeline, deployment and Argo
links. Failure messages identify the failed state; retry the same service
parameters to resume. Existing unowned repositories and reserved baseline names
are refused. State is recorded in `rhdh/box1-onboard-<name>` with a concurrency
Lease. See the module guide for scope, credentials, retries and diagnostics.

Maintain the runtime source here. Validate with `npm run validate &&
npm run test:onboarding && npm run test:onboarding-oci` and compare the action
inputs with the installed Hub schemas before rollout. A tagged release publishes
a digest-pinned OCI image and opens the GitOps PR; see the module guide.

## Development repository

Onboarding and image promotion target `box1-org/box1-workloads-dev`. Argo CD
reads that public repository anonymously over HTTPS. Shared Tasks and
Developer Hub configuration remain in `box1-gitops`. Generated services keep
deployment manifests in the GitOps workload repository.
