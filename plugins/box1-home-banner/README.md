# Box1 Operations banner (RHDH 2.1 homepage widget)

A New Frontend System plugin (`pluginId: box1-home`) that brings the Box1
Operations banner back to the RHDH 2.1 homepage. RHDH 2.1 replaced
`dynamic-home-page` with the `homepage` plugin, which has no Markdown card, so
the pre-2.1 banner could not be moved over as configuration alone
(box1-org/box1-docs#169).

The widget `box1-operations-banner` attaches to `page:homepage` (input
`widgets`), like the built-in RHDH cards, and renders GitHub-flavoured Markdown
with `MarkdownContent` from `@backstage/core-components`, which the host shares.
The banner text is not in this package. `box1-gitops`
(`platform/developer-hub/app-config.yaml`) supplies it as
`widgetLayout.box1-operations-banner.props.content` on the read-only homepage
layout. The logo arrives separately as `props.logo` (the `${BOX1_ICON_LOGO}` data
URI substituted by the backend) and is rendered as its own image: RHDH 2.1's
`MarkdownContent` sanitizes `data:` URLs out of Markdown images.
`homepage.defaultWidgets` lists the banner first.

## Versions

Pinned to RHDH 2.1.0: Backstage 1.54.9 packages (`frontend-plugin-api`
0.18.0, `plugin-home-react` 0.1.41, `core-components` 0.18.13) and
`@red-hat-developer-hub/cli` 2.1.2. Change them only with the deployed RHDH version.

## Build and publish

```bash
cd plugins/box1-home-banner
npm ci
./node_modules/.bin/tsc -p .
./node_modules/.bin/rhdh-cli plugin export --clean
./node_modules/.bin/rhdh-cli plugin package \
  --tag registry.apps.ocp.box1.org/box1-plugins/box1-home-banner:<version>-<commit>
```

Push to the integrated registry with an `oc` login that can write to
`box1-plugins`, and record the pushed digest in `box1-gitops`:

```text
oci://registry.apps.ocp.box1.org/box1-plugins/box1-home-banner@sha256:<digest>!box1-backstage-plugin-home-banner
```

There is no CI release pipeline for this package yet. Releases are built and
pushed from a workstation, and the digest pin is what keeps them immutable.
