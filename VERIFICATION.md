# Phase 4 acceptance — 2026-10-25

The live Red Hat Developer Hub scaffolder generated a new private service with
no copied application files or hand-written deployment manifests.

## Template and infrastructure

Repository: https://github.com/box1-org/box1-templates

Catalog entity: `template:default/quarkus-rest-service`, available under
[Create](https://developer-hub.apps.ocp.box1.org/create).

Platform enablement PR:
https://github.com/box1-org/box1-gitops/pull/5
merged as `8cce4c0602893d9f925398e09491035ef6d1284c` after both required checks.
Argo reconciled the `pipelines-ci` and `developer-hub` platform Applications.
A follow-up GitOps commit `ca7eca3c09cf4aef0209780e6163a73cc385e7c7` cleared
incomplete connection placeholders for previously UI-enabled Kubernetes/Argo
plugins, allowing the Hub to start while preserving installed plugin choices.
Read-only UI cluster connections remain separate from this template workflow.

Offline validation rendered `orders-api`, `inventory-service`, and
`quarkus-golden-path-smoke`, plus the longest accepted 35-character name, checked action input schemas exported from the live
Hub, pipeline parameter contracts, namespaced identities, ConfigMap references,
immutable images, both Kustomize trees, and unsafe/reserved-name rejection.
Platform Python scripts compiled and the live API server accepted dry runs of
all changed platform resources.

## Live generation

Scaffolder task:
[`10dcca8d-6b19-4b41-9f07-c9a68a73ce60`](https://developer-hub.apps.ocp.box1.org/create/tasks/10dcca8d-6b19-4b41-9f07-c9a68a73ce60)
completed all five steps: application generation, repository publication, GitOps
generation, onboarding PR creation, and catalog registration.

Generated repository:
https://github.com/box1-org/quarkus-golden-path-smoke

Initial source: `748fe602bce11bfc9c0ccdb128be102e528908ac`.
Catalog Component: `component:default/quarkus-golden-path-smoke`, with an
`ownedBy` relation to `user:default/mike4263` and no catalog status errors.

Generated onboarding PR:
https://github.com/box1-org/box1-gitops/pull/6
merged as `92456a619db30052a6245093a00f9076edc1b8f5` after both required checks.
Its eight generated files installed the Argo Application and all runtime/PAC/RBAC
resources through normal app-of-apps reconciliation. No manual application apply,
manual PipelineRun, or forced application sync was used.

Argo reported Synced/Healthy with the initial Deployment at zero replicas and
PAC registered in `box1-ci`. The observer could get this service's Deployment and
Argo Application; it could not patch Deployments.

## Generated PR and release

Acceptance source PR:
https://github.com/box1-org/quarkus-golden-path-smoke/pull/1

The PR changed README acceptance text and corrected Windows wrapper attribute
handling. The same attribute fix is included in the template; it prevents a dirty
checkout after publishing with isomorphic-git. Application code and all generated
deployment YAML required no edits.

Validation run: `quarkus-golden-path-smoke-validate-4mjx8`.
[GitHub check](https://github.com/box1-org/quarkus-golden-path-smoke/runs/121071248009)
passed: 7 unit/in-process HTTP tests plus 4 packaged HTTP integration tests,
0 failures, 0 Checkstyle violations, and 0 SpotBugs/FindSecBugs findings.

The source PR merged as `01922f3d20c131b139a80951675b8d85b276e389` and the
GitHub push automatically started `quarkus-golden-path-smoke-release-jsg22`.
It repeated verification and used Jib on the cluster to push:

```
registry.apps.ocp.box1.org/box1-ci/quarkus-golden-path-smoke:01922f3d20c131b139a80951675b8d85b276e389
sha256:f763c280bc199e2db476534f0174fc8662e32784de2f2f3936481c74867cfc1a
```

The central promotion Task created
[GitOps PR #7](https://github.com/box1-org/box1-gitops/pull/7), waited for both
exact-head checks, and automatically merged it as
`d4911d348edff0d3c010c1907a3e4e2f82b47b32`.
The PR changed only the service's digest and Deployment provenance/replica files.

The release token was verified through GitHub's installation repository API:
its complete scope was exactly `box1-org/quarkus-golden-path-smoke` and
`box1-org/box1-gitops`. The PR Maven container had no Secret-backed environment
variables and used `ci-test`.

The original acceptance release completed successfully: Argo reconciled commit
`d4911d348edff0d3c010c1907a3e4e2f82b47b32` automatically, and all three
build/promote/smoke tasks succeeded. This initial case used the service-name
namespace. The final template now uses `<service>-dev`; the requested
`orders-service` milestone is recorded separately in `MILESTONE-DEMO.md`.
