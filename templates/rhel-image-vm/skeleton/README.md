# ${{ values.name }}

${{ values.description }}

A **RHEL 10 image mode (bootc)** virtual machine created from the Box1 golden path (`box1-org/box1-templates`, template `rhel-image-vm`). The operating system is a container image built from this repository. Change the OS by committing here, and apply approved releases in the VM.

```
Containerfile          rhel10/rhel-bootc:10.2 (pinned) + packages + rootfs/ + bootc container lint
rootfs/                files layered onto the OS: ${{ values.name }}.target (default boot target),
                       an example service, bootc update plumbing, console kargs, sudoers
build/repos/           RHEL CDN repositories for dnf (no credentials)
.tekton/               Pipelines-as-Code: PR build check, and release
local/                 build and boot an arm64 copy on an Apple Silicon Mac
```

## Make a change

1. Edit the `Containerfile` or `rootfs/`. For example, add a systemd unit with `WantedBy=${{ values.name }}.target`, or add packages to the `dnf install` line.
2. Open a PR. `${{ values.name }}-validate` builds the image and runs `bootc container lint`.
3. Merge it. `${{ values.name }}-release` runs these steps:
   1. builds and pushes `box1-ci/${{ values.name }}@<digest>`;
   2. runs the TPA and ACS scans, in observe mode, and links the reports from the run's results;
   3. builds a new install disk, `box1-ci/${{ values.name }}-disk`;
   4. opens and merges a box1-workloads-dev PR that records the digest on the VirtualMachine as `box1.org/os-image-digest`;
   5. moves `box1-ci/${{ values.name }}:development` to that digest;
   6. checks the VM.
4. Apply the release in the VM:

```sh
virtctl ssh -n ${{ values.namespace }} cloud-user@vm/${{ values.name }}
sudo bootc upgrade --check     # what would change
sudo bootc upgrade --apply     # stage it and reboot
sudo bootc status              # booted / rollback digests (compare with box1.org/os-image-digest)
sudo bootc rollback --apply    # return to the previous image
```

Releases never reboot the VM on their own: `bootc-fetch-apply-updates.timer` is disabled.

## Access

- **SSH:** `cloud-user` (passwordless sudo) accepts the public keys in the GitOps Secret `workloads/${{ values.name }}/admin-access.yaml` in box1-workloads-dev. KubeVirt delivers them through qemu-guest-agent, and changes reach the running VM without a restart.
- **Serial console:** `virtctl console ${{ values.name }} -n ${{ values.namespace }}`, or open the VM in the OpenShift console. No account has a password, so use the console for boot output and use SSH to log in.

## Where things are

| What | Where |
| --- | --- |
| VM, disk and access (desired state) | `box1-org/box1-workloads-dev`: `workloads/${{ values.name }}/`, synced by Argo CD Application `${{ values.name }}` |
| OS images | `box1-ci/${{ values.name }}` (update channel `:development`) and `box1-ci/${{ values.name }}-disk` |
| Registry access for `bootc upgrade` | At boot, `box1-registry-setup.service` installs the service CA and a pull token from two VM disks (`serviceca`, `regtoken`) |
| Shared build tasks | `box1-org/box1-gitops`: `platform/pipelines/tasks/bootc-*.yaml`; see `GOLDEN-PATH.md` |

## Build locally (Apple Silicon)

```sh
REGISTRY_AUTH_FILE=/path/to/auth.json ENTITLEMENT_DIR=/path/to/ent local/build-local.sh
local/run-local.sh
```

You need a `registry.redhat.io` auth file and the cluster's entitlement certificate (`entitlement.pem` and `entitlement-key.pem`), both under `/Users` or `/private`. These are build inputs only; they are never copied into this repository or the image.
