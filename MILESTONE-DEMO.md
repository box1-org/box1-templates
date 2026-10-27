> **Retired historical record.** The orders-service demo is preserved for evidence only; it is no longer an operational deployment. See [the decommission runbook](https://github.com/box1-org/box1-docs/blob/document-service-decommission/runbooks/service-decommission.md).

# Orders service milestone demonstration — 2026-10-25

The requested sequence uses `orders-service`, namespace `orders-service-dev`, and
Route `https://orders-service-dev.apps.ocp.box1.org`.

## Creation

Developer Hub was opened at `/create`. Its in-app-browser sign-in did not open a
GitHub authentication window. The user explicitly selected **Run creation through
the Hub API**, so creation used the same live Hub scaffolder and registered
Software Template through its authenticated API.

Template: `template:default/quarkus-rest-service`, displayed as
**Create Quarkus Service**.

[Scaffolder task](https://developer-hub.apps.ocp.box1.org/create/tasks/abe9f413-6562-46f8-8821-30a98eed5388)
completed generation, repository publishing, onboarding PR creation, and catalog
registration without copying source or writing application deployment YAML.

[Application repository](https://github.com/box1-org/orders-service) is private.
Initial scaffold commit: `2d25792403e8eff2ce0b262d07f874e82b4b230f`.
Its fresh clone was clean, including the Windows Maven wrapper.

Catalog Component: `component:default/orders-service`, owner
`user:default/mike4263`, namespace annotation `orders-service-dev`, Kubernetes ID
`orders-service`, and Argo Application annotation `orders-service`. The catalog
reported no entity status errors. Matching Kubernetes labels were generated.

[Onboarding PR #8](https://github.com/box1-org/box1-gitops/pull/8) added eight
files under `applications/orders-service.yaml` and `workloads/orders-service/`.
Both required exact-head GitOps checks passed; it merged as
`e29038d5bd0410f9b412383221eb11ceda90d24f`.

Normal app-of-apps reconciliation installed the Namespace, restricted runtime
ServiceAccount, zero-replica Deployment, probes, Service, Route, hashed ConfigMap,
PAC Repository, registry pull access, and scoped observer RBAC. The shared Tasks
were already installed through `pipelines-ci`; generated `.tekton` definitions
reference them through the cluster resolver.

## Initial delivery

Once onboarding was Synced/Healthy and PAC registered the source repository,
an empty source commit started the first delivery without changing application
code or deployment YAML:
`015316eaf4e00793353bd8ea77c12e8d9c7fef34`.

This explicit bootstrap is needed because repository publication precedes PAC
registration; its initial creation webhook is not assumed to be replayed.

Tekton `orders-service-release-dl85v` ran 7 unit/in-process HTTP tests and 4
packaged JVM HTTP tests, with zero failures, zero Checkstyle violations, and
zero SpotBugs/FindSecBugs findings. Jib built and pushed on the cluster:

```
registry.apps.ocp.box1.org/box1-ci/orders-service:015316eaf4e00793353bd8ea77c12e8d9c7fef34
sha256:84348460978dd0c166a1352f550c6f30cfede87d046150e39928769a134d4a93
```

Tekton created [promotion PR #9](https://github.com/box1-org/box1-gitops/pull/9),
waited for both required exact-head checks, and automatically merged it as
`64eb3fe6f759347f569408602300b491ebd76f33`. This activated the Deployment at
one replica using the application's own immutable digest.

The baseline release completed all build/promote/smoke tasks successfully. Argo
was Synced/Healthy at the promotion commit, with an Available Deployment and a
Ready Pod actually running the baseline digest. Verified public responses:

```json
{"message":"Hello from box1, OpenShift!","service":"orders-service"}
```

`/api/info.gitRef` was `015316eaf4e00793353bd8ea77c12e8d9c7fef34`.
The independent HTTPS smoke script also passed health/startup/readiness, Java 21,
OpenAPI, Micrometer metrics, and invalid-input checks.

## REST change through a pull request

[Source PR #1](https://github.com/box1-org/orders-service/pull/1) adds
`revisionLabel: "updated"` to `GET /api/greetings`, preserves the existing greeting
fields, and extends the HTTP test. That test runs both in process and against
the packaged JVM application. No deployment configuration or CI definition was
changed.

PR head: `1bda8c8c2ce0e5aa71a999a4a1176b6d3532f59a`.
Validation PipelineRun: `orders-service-validate-9mhxd`.
[GitHub validation check](https://github.com/box1-org/orders-service/runs/121077756969).

The PR passed all 11 tests and both static checks, then merged as
`3038baae28aedbb91c4daf9ba30120f6f311274b`. Its GitHub push started the new
release automatically, with no OpenShift console action or manual PipelineRun.

Release `orders-service-release-9cl9h` repeated all tests/static checks, then
Jib published source `3038baae28aedbb91c4daf9ba30120f6f311274b` as digest:

```
sha256:afa8f03bbf333fc444a85eeb80942298c088512b0a17654aafb3a775f54b0ad5
```

The central Task created [promotion PR #10](https://github.com/box1-org/box1-gitops/pull/10)
and automatically merged it after both exact-head checks passed, as
`d0ad167467a0b41215826f5fa4a6dec9e824413b`.

Automatic redeployment completed successfully. Argo was Synced/Healthy at
`d0ad167467a0b41215826f5fa4a6dec9e824413b`, and a Ready Pod actually ran the
new image digest. The public response was:

```json
{"message":"Hello from box1, OpenShift!","service":"orders-service","revisionLabel":"updated"}
```

`/api/info.gitRef` was `3038baae28aedbb91c4daf9ba30120f6f311274b`.
The release's Argo observer/HTTP smoke task and the independent HTTPS smoke
script both passed. There was no console action, direct application apply,
manual PipelineRun, or forced Argo application sync.

## Rollback through GitOps

[Rollback PR #11](https://github.com/box1-org/box1-gitops/pull/11) is a Git revert
of promotion commit `d0ad167467a0b41215826f5fa4a6dec9e824413b`. It changes only
`workloads/orders-service/kustomization.yaml` and `deployment.yaml`: restore the
previous digest and source/build provenance while preserving one replica.
The resulting workload files were compared byte-for-byte to the verified
baseline at `64eb3fe6f759347f569408602300b491ebd76f33` and matched.

Both required exact-head GitOps checks passed on the rollback PR, and it merged
as `8cd0755fca6aee2add8d3d3ff796819a91028c4d`. No application rebuild, direct
Deployment mutation, console action, or forced Argo sync was used.

Rollback verification passed. Argo was Synced/Healthy at the rollback merge,
with an Available Deployment and a Ready Pod actually running
`sha256:84348460978dd0c166a1352f550c6f30cfede87d046150e39928769a134d4a93`.
`/api/info.gitRef` returned to
`015316eaf4e00793353bd8ea77c12e8d9c7fef34`, and the greeting response again
had no `revisionLabel`. The full public HTTPS smoke test passed.

The service is deliberately left rolled back. Source `main` still contains the
endpoint update at `3038baae28aedbb91c4daf9ba30120f6f311274b`; GitOps desired
state selects the previously verified image independently of source HEAD.

## Definition of done

| Step | Evidence / result |
| --- | --- |
| 1–2. Select the template and create orders-service | Completed through the live Hub API, explicitly approved by the user after in-app-browser sign-in was unavailable. Scaffolder task completed all steps. |
| 3. Verify repository, catalog, CI and GitOps | Private repository and catalog Component registered; .tekton definitions and eight GitOps files generated; onboarding PR #8 merged. |
| 4. Observe cluster build/test/push | Baseline release dl85v succeeded, 11 tests passed, image SHA-tagged and digest recorded. |
| 5. Argo deploys to orders-service-dev | Synced/Healthy; Ready Pod on baseline digest; public Route and API Git SHA verified. |
| 6. Change endpoint through a PR | Source PR #1 added revisionLabel and its HTTP test; exact-head CI passed; PR merged. |
| 7. Automatic redeployment | Release 9cl9h and promotion PR #10 succeeded; new digest, source SHA, and updated response verified live. |
| 8. Revert GitOps image and verify rollback | Git revert PR #11 passed checks and merged; old runtime digest, API SHA, response, and health restored automatically. |

Machine-readable snapshots, captured after each live state was verified:
[baseline](verification/orders-service/baseline.json),
[updated](verification/orders-service/updated.json), and
[rollback](verification/orders-service/rollback.json).

All Argo Applications were Synced/Healthy at the final acceptance check. The
OpenShift console was not used. Cluster commands during application delivery and
rollback were read-only observations; only Git changes drove workload mutations.
