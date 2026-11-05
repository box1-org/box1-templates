// Create or update the box1-gitops PR that points RHDH at a released plugin digest.
// This only proposes a Git change. Argo CD applies it after the PR merges.
//
// Environment: GITHUB_TOKEN, DIGEST, VERSION, REVISION, BUILD_URL
import fs from 'node:fs';
import path from 'node:path';

const DYNAMIC_PLUGINS = 'platform/developer-hub/dynamic-plugins.yaml';
const BACKSTAGE = 'platform/developer-hub/backstage.yaml';
const GITOPS = 'box1-org/box1-gitops';
const DIGEST = /^sha256:[a-f0-9]{64}$/;

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function runtimeReference(oci, digest) {
  if (!DIGEST.test(digest)) throw new Error(`Malformed digest: ${digest}`);
  return `oci://${oci.registry}/${oci.repository}@${digest}!${oci.pluginPath}`;
}

// Returns null when the runtime has not been cut over to an OCI reference yet.
export function planRuntimeUpdate(oci, files, digest) {
  const target = runtimeReference(oci, digest);
  const entry = new RegExp(`^(\\s*- package: )oci://${escapeRegExp(`${oci.registry}/${oci.repository}`)}([@:][^!\\s]+)!(\\S+)[ \\t]*$`, 'gm');
  const matches = [...files.dynamicPlugins.matchAll(entry)];
  if (matches.length === 0) return null;
  if (matches.length > 1) throw new Error('More than one active onboarding plugin definition');
  const [{ 2: version, 3: pluginPath }] = matches;
  if (pluginPath !== oci.pluginPath) throw new Error(`Configured plugin path is ${pluginPath}, expected ${oci.pluginPath}`);
  const rollbackDigest = version.slice(1);
  if (!version.startsWith('@') || !DIGEST.test(rollbackDigest)) throw new Error(`Configured reference is not digest-pinned: ${version}`);

  const annotation = /^(\s*box1\.org\/onboarding-plugin-digest: )(\S+)[ \t]*$/gm;
  const annotations = [...files.backstage.matchAll(annotation)];
  if (annotations.length !== 1) throw new Error(`Expected one rollout digest annotation, found ${annotations.length}`);
  if (annotations[0][2] !== rollbackDigest) throw new Error('The rollout annotation and the configured digest disagree');

  return {
    rollbackDigest,
    unchanged: rollbackDigest === digest,
    dynamicPlugins: files.dynamicPlugins.replace(entry, `$1${target}`),
    backstage: files.backstage.replace(annotation, `$1${digest}`),
  };
}

export function pullRequestBody(oci, artifact, rollbackDigest) {
  const { digest, version, revision, buildUrl } = artifact;
  const image = `${oci.registry}/${oci.repository}`;
  return `Point Developer Hub at onboarding plugin ${version}.

| | |
|---|---|
| Artifact version | \`${version}\` |
| Source commit | [\`${revision}\`](${oci.sourceRepository}/commit/${revision}) |
| Registry image | \`${image}\` |
| Immutable digest | \`${digest}\` |
| Plugin path | \`${oci.pluginPath}\` |
| Compatibility target | RHDH ${oci.compatibility.rhdh}, Backstage ${oci.compatibility.backstage} |
| Rollback digest | \`${rollbackDigest}\` |
| CI build | ${buildUrl} |

CI built and inspected this digest, and made no change to the cluster. After merge, sync the \`developer-hub\` Argo CD Application to roll it out. To roll back, revert this PR and sync again.
`;
}

async function github(token, route, { method = 'GET', body } = {}) {
  const response = await fetch(`https://api.github.com${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'box1-onboarding-plugin-release',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 404 && method === 'GET') return null;
  if (!response.ok) throw new Error(`GitHub ${method} ${route}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

export async function publish(oci, artifact, token) {
  const repo = `/repos/${GITOPS}`;
  const read = async file => {
    const content = await github(token, `${repo}/contents/${file}?ref=main`);
    return Buffer.from(content.content, 'base64').toString();
  };
  const files = { dynamicPlugins: await read(DYNAMIC_PLUGINS), backstage: await read(BACKSTAGE) };
  const plan = planRuntimeUpdate(oci, files, artifact.digest);
  if (!plan) {
    console.log('box1-gitops has no OCI onboarding plugin reference yet; no PR opened.');
    return null;
  }
  if (plan.unchanged) {
    console.log(`box1-gitops already uses ${artifact.digest}; no PR opened.`);
    return null;
  }

  const main = await github(token, `${repo}/git/ref/heads/main`);
  const base = await github(token, `${repo}/git/commits/${main.object.sha}`);
  const tree = await github(token, `${repo}/git/trees`, { method: 'POST', body: {
    base_tree: base.tree.sha,
    tree: [
      { path: DYNAMIC_PLUGINS, mode: '100644', type: 'blob', content: plan.dynamicPlugins },
      { path: BACKSTAGE, mode: '100644', type: 'blob', content: plan.backstage },
    ],
  } });
  const title = `Update the onboarding plugin to ${artifact.version}`;
  const commit = await github(token, `${repo}/git/commits`, { method: 'POST', body: {
    message: `${title}\n\nSource: ${artifact.revision}\nDigest: ${artifact.digest}\nRollback digest: ${plan.rollbackDigest}\n`,
    tree: tree.sha,
    parents: [main.object.sha],
  } });

  const branch = `onboarding-plugin/${artifact.version}`;
  const existingRef = await github(token, `${repo}/git/ref/heads/${branch}`);
  if (existingRef) {
    await github(token, `${repo}/git/refs/heads/${branch}`, { method: 'PATCH', body: { sha: commit.sha, force: true } });
  } else {
    await github(token, `${repo}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
  }

  const body = pullRequestBody(oci, artifact, plan.rollbackDigest);
  const open = await github(token, `${repo}/pulls?state=open&head=box1-org:${encodeURIComponent(branch)}`);
  const pr = open.length
    ? await github(token, `${repo}/pulls/${open[0].number}`, { method: 'PATCH', body: { title, body } })
    : await github(token, `${repo}/pulls`, { method: 'POST', body: { title, body, head: branch, base: 'main' } });
  console.log(`GitOps PR: ${pr.html_url}`);
  return pr;
}

if (process.argv[1] === import.meta.filename) {
  const { GITHUB_TOKEN, DIGEST: digest, VERSION: version, REVISION: revision, BUILD_URL: buildUrl } = process.env;
  for (const [name, value] of Object.entries({ GITHUB_TOKEN, DIGEST: digest, VERSION: version, REVISION: revision, BUILD_URL: buildUrl })) {
    if (!value) throw new Error(`${name} is required`);
  }
  const oci = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../plugins/box1-onboarding/oci-package.json'), 'utf8'));
  await publish(oci, { digest, version, revision, buildUrl }, GITHUB_TOKEN);
}
