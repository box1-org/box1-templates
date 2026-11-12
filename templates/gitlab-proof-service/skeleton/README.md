# ${{ values.name }}

GitLab proof service (box1-docs#164 re-run). `GET /` returns the service name, a
message and the source revision baked into the image.

- **Pull request:** `.tekton/pull-request.yaml` runs the unit tests and a build.
- **Push to main:** `.tekton/push.yaml` builds and pushes the image to
  `box1-gl-ci`, then `gitlab-gitops-promote` opens a PR in
  `box1-gl-gitops/workloads-proof`. When the required check passes, it squash-merges
  the PR pinned to its head and Argo CD deploys it to `box1-gl-dev`.
