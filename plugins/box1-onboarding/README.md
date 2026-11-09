# Development onboarding module

Canonical source for the RHDH 1.9.7 / Backstage 1.45.3 dynamic backend module.
It registers `box1:repository:ensure`, the `box1:development:` actions `provision`,
`platform`, `build`, `promote`, `verify` and `onboard`, and the `box1:catalog:` actions
`submit`, `verify` and `ensure`.
No private runtime dependencies are bundled; the compatible Hub image supplies
the declared peer dependencies.

RHDH installs this module from a digest-pinned OCI image. `box1-gitops` holds only
the reference, never the source:

```text
oci://registry.apps.ocp.box1.org/box1-plugins/box1-onboarding-plugin@sha256:<digest>!box1-scaffolder-onboarding
```

To build it locally, run `npm ci --prefix tools/rhdh-cli`, then
`npm run package:onboarding-oci -- --tag <image>`. This uses the RHDH CLI version
pinned in `tools/rhdh-cli`, which must match the deployed RHDH version. The CLI
derives `${name}-dynamic`, so the package is staged without the suffix: the runtime
package name stays `box1-scaffolder-onboarding-dynamic`, and the image path is
`box1-scaffolder-onboarding`. The package is private and is not published to npm.

To release, raise `version` in `package.json`, merge to `main`, and tag that commit
`onboarding-plugin-v<version>`. CI publishes the image, confirms the digest in the
registry is this build, and opens a `box1-gitops` PR. Argo CD applies it after merge
and sync. Each version can be released once, so a failed release needs a new version.
The release, verification, rollback, and credential rotation procedures are in
`box1-docs/runbooks/rhdh-onboarding-plugin-oci.md`.

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

Validation: `npm run validate && npm run test:onboarding && npm run test:onboarding-oci`. `test:onboarding` exercises
development-only scope, baseline protection, lease exclusion, readiness gates,
credential/run creation ordering, completed-build reuse, and exact-check/App
merge gating. Live acceptance uses POST `/api/scaffolder/v2/tasks` with the normal
GitHub-authenticated user or existing backend automation authentication.

Catalog registration reuses an existing matching entity. If only its source
Location exists, a 409 is treated as a pending registration and the action waits
for the matching entity. Other catalog errors propagate immediately; an entity
with a different source repository fails validation. Completed-workflow replay
therefore does not fail on duplicate catalog locations.

## Onboarding profiles

Profiles were introduced in 1.2.0. Since 1.3.0 every profile-specific behaviour is an entry in the `PROFILES` dispatch table in `workflow.cjs`; see [Adding an onboarding profile](#adding-an-onboarding-profile-130).

`box1:repository:ensure` and every `box1:development:*` action accept an optional `profile` input. Its enum is generated from the table:

- **`service`** (default): the Quarkus Deployment path. Records, markers, template version, commit message and checks are unchanged from 1.1.x, so in-flight 1.1.x onboardings resume as before.
- **`virtual-machine`**: RHEL 10 image mode VMs, from template `templates/rhel-image-vm` (box1-docs#55).
  - The profile is stored in the state record and in the `.box1/onboarding.json` marker. Every later phase must pass the same profile.

What each phase does for `virtual-machine`:

| Phase | Behaviour |
| --- | --- |
| Bundle check (`validateVmBundle`) | Expects one Application, plus `namespace`, `updater`, `admin-access`, `virtualmachine`, `datavolume`, `onboarding` and `kustomization` under `workloads/<name>/`. The VM must be Halted with zero digests. `datavolume.yaml` is generated but must not be listed in the kustomization, because DataVolume specs are immutable. Only SSH public keys may appear in Secrets. The registry pull binding is for Group `system:serviceaccounts:<name>-dev`. The rules mirror the `virtual-machine` profile of `box1-gitops-validate`. |
| Build barrier and platform readiness | Waits for `ci-bootc-release` and its image-builder and privileged-SCC bindings, the `<name>-updater` SA, the Group pull binding, and the VirtualMachine. |
| Build | One PipelineRun as `ci-bootc-release`: `box1-bootc-build` → `box1-bootc-disk` → `box1-bootc-channel`. Results are the OS image digest and the disk digest. The channel move points `:development` at the image the VM is about to boot. The credential Secret lifecycle is unchanged. |
| Promote | One promotion PR. It records `box1.org/os-image-digest` and the build run on the VirtualMachine, pins the disk digest, adds `datavolume.yaml` to the kustomization, and sets `runStrategy: Always`. |
| Verify | Waits up to 25 minutes for: VirtualMachine annotation equals the digest, root DataVolume `Succeeded` (a `Failed` import fails at once), VM Ready, guest agent connected, and Argo Synced and Healthy. |

Hub RBAC: `developer-hub-onboarding-observe` needs `get` on `kubevirt.io` `virtualmachines` and `virtualmachineinstances` and on `cdi.kubevirt.io` `datavolumes` (box1-gitops#65).

Tests:
- `scripts/test-onboarding-vm.cjs` covers the profile.
- `scripts/validate.mjs` renders the template and runs the bundle check.

## Adding an onboarding profile (1.3.0)

A profile is one entry in `PROFILES` (`workflow.cjs`) plus the handlers it names. The
Workflow phases call the handlers and never test the profile name, so do not add
`if (profile === …)` branches to the Workflow. The full contract is the comment above
`PROFILES`. Every handler receives the Workflow `w`, which provides `w.name`, `w.ns`,
`w.profile`, `w.data` (the state record), `w.kube`, `w.wait(label, seconds, observe)`,
`w.content(repo, file)`, `w.save(phase, extra)` and `w.ctx.output(key, value)`.

| Key | Used by | Absent (`null`) means |
| --- | --- | --- |
| `templateVersion`, `commitMessage` | `box1:repository:ensure`: record, marker and skeleton commit | — (required) |
| `sourceRepository` (default `true`) | `box1:repository:ensure` | `false`: the action is refused; there is no source repository |
| `initialRecord(w)` | `box1:development:provision`, only when no record exists | the record must come from `box1:repository:ensure` |
| `recordFields(w)`, `markerFields(w)` | the REQUESTED record (after `templateVersion`) and `.box1/onboarding.json` | — (return `{}` to add nothing) |
| `validateBundle(files, name)` | `provision` and `promote` | no GitOps bundle: no onboarding PR, Application sync or promotion |
| `buildBarrier(w)` | end of `platform` | no build prerequisites |
| `platformChecks(w)` | readiness observed during `build`; `{condition: async () => true or 'pending reason'}` | no readiness set |
| `buildSpec(w, secretName)` | `build`: the first PipelineRun spec | no PipelineRun or build credential |
| `buildResults(w, run)` | `build`: fields saved with IMAGE_BUILT; throw to reject. `run` is `null` without `buildSpec` | with `buildSpec` also `null`: no build at all |
| `promotionUpdates(w, files)` | `promote`: files of the first-release PR in `box1-workloads-dev` | no promotion PR or promotion sync |
| `verify(w)` | `verify`: wait for the delivered state, save, set outputs | nothing to verify |
| `catalogComplete(data)` | `box1:catalog:ensure` | — (required) |

Rules:

- Declare every key, using `null` for an absent phase; a test checks this. A skipped
  phase still checks the recorded source revision and profile, and logs `state=skipped`.
- A new profile must store itself in the record and marker (`recordFields` and
  `markerFields` returning `{profile: w.profile}`). Only `service` omits it, for
  compatibility with records written before 1.2.0.
- Catalog actions take only `name`. They read the profile from the stored record, so
  `catalogComplete` is evaluated for the profile that onboarding recorded.
- Keep `service` and `virtual-machine` unchanged: `scripts/test-onboarding-characterisation.cjs`
  compares their records, markers, PR files, PipelineRuns, stored results, readiness
  checks, verify sequence and action schemas with
  `scripts/fixtures/onboarding-profiles-characterisation.json`, recorded on 1.2.0. Do
  not regenerate the fixture to make a change pass.
- Add the profile's tests next to `scripts/test-onboarding-profiles.cjs`, which shows
  test-only profiles without a GitOps workload and without a source repository.
- Templates pass `profile: <name>` to every onboarding step. Releasing the plugin is
  required before a template can use a new profile.
