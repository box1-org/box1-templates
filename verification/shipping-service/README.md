# Zero-touch shipping-service acceptance

Verified on 2026-10-25 through the Hub API, without browser interaction.
Definition of done met: shipping-service's first image was built and deployed
without a manual PR merge, manual application sync/apply, or additional source
push. The final completed-workflow replay also succeeded without duplicates.

- [Source repository](https://github.com/box1-org/shipping-service)
- [Catalog service](https://developer-hub.apps.ocp.box1.org/catalog/default/component/shipping-service)
- [First CI build](https://console-openshift-console.apps.ocp.box1.org/k8s/ns/box1-ci/tekton.dev~v1~PipelineRun/onb-shipping-service-86c77b6b)
- [Development deployment](https://shipping-service-dev.apps.ocp.box1.org)
- [Argo CD](https://openshift-gitops-server-openshift-gitops.apps.ocp.box1.org/applications/openshift-gitops/shipping-service)

## Evidence

[request.json](request.json) is the POST `/api/scaffolder/v2/tasks` body.
[task-result.json](task-result.json) records successful deployment task
`145e5770-c857-43b2-b753-5c047f908006` and its generated output links.
[replay-task-result.json](replay-task-result.json) records final-template replay
`ee06c6af-46b3-4f33-a8e3-bc202ebf6f31`, which completed successfully using the custom idempotent catalog action.
[status.json](status.json) preserves the durable state history, including the
observed readiness boundary, first build, promotion and catalog completion.
Machine-readable timestamps in these artifacts are UTC.

[replay-acceptance.json](replay-acceptance.json) verifies:

- Source head remains `86c77b6b87a7eea46d2638f305ecf5748ca2c9ea`.
  The two source commits are marker initialization and initial generated content;
  no source commit was added to trigger or resume first deployment.
- Exactly one initial PipelineRun, `onb-shipping-service-86c77b6b`, succeeded.
  Its creation follows PLATFORM_READY (ObjectMeta timestamps have second
  precision; state transitions retain milliseconds).
- Both [onboarding PR #17](https://github.com/box1-org/box1-gitops/pull/17) and
  [first-image PR #18](https://github.com/box1-org/box1-gitops/pull/18) were merged
  by `box1-developer-hub[bot]` after the two required checks from the
  `box1-pipelines` App succeeded on each exact PR head. Each branch has one PR.
- Argo is Synced/Healthy, the expected digest-pinned image is available, and
  `/api/info` returns HTTP 200 with the original source SHA.
- The temporary initial-build GitHub credential Secret was deleted.

Image: `image-registry.openshift-image-registry.svc:5000/box1-ci/shipping-service@sha256:57a4ba5e24be99070f55f4db9e41a6348802224735e57bec9f7741b7a611c184`.

## Failure and resume coverage

Live validation exposed and corrected RHDH local-package staging/cache behavior,
the disabled default runtime token mount, Kubernetes Lease timestamp precision,
a Git ref ancestor collision, and duplicate catalog registration. The recorded
workflow stopped explicitly at IMAGE_BUILT on the ref collision; resubmitting
through the Hub API after the fix reused the existing repository, merged
onboarding PR and successful image, then automatically merged PR #18. No manual
PR merge or source push was used to repair this partial state.

The native catalog action's duplicate-location error was found during completed
replay and replaced by `box1:catalog:ensure`. The final replay completed all
steps, with one source repository, one PR per stage, one initial build and the
same source head/image. COMPLETE is now recorded only after catalog success.
Twelve focused tests cover scope/namespace/RBAC restrictions, baseline-name
protection, lease exclusion and precision, readiness gating, Secret-before-run
ordering, completed-build reuse, required-check/App gating, safe validation
retries, and catalog conflict/failure/resumption behavior. Four rendering cases
also passed against the live Hub action schemas.

## Orders regression baseline

[orders-regression.json](orders-regression.json) compares the deployment saved
before onboarding with the final live state. Deployment spec, UID, generation,
image and replica count are identical. The Application spec and workload Pod
UIDs are unchanged. The orders-service repository and workload manifests were
not edited by this workstream.

The runtime verifier is committed in
`box1-gitops/platform/developer-hub/scripts/verify-onboarding.cjs`; execute it in
the Hub backend with the existing environment, without printing credentials.
