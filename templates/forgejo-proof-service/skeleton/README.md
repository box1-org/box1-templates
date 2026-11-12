# ${{ values.name }}

Forgejo proof service (box1-docs#164). `GET /` returns the service name, a
message and the source revision baked into the image.

- **Pull request:** `.tekton/pull-request.yaml` runs the unit tests and a build.
- **Push to main:** `.tekton/push.yaml` builds and pushes the image to
  `box1-fj-ci`, then `forgejo-gitops-promote` opens a PR in
  `box1-fj/workloads-proof`. When the required check passes, it squash-merges
  the PR pinned to its head and Argo CD deploys it to `box1-fj-dev`.
