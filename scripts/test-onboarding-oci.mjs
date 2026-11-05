// Offline tests for the OCI artifact checks. Fixtures are built from the canonical plugin.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspect, layoutSource, registrySource } from './inspect-onboarding-oci.mjs';
import { planRuntimeUpdate, pullRequestBody } from './open-onboarding-gitops-pr.mjs';

const root = path.resolve(import.meta.dirname, '..');
const pluginDir = path.join(root, 'plugins/box1-onboarding');
const oci = JSON.parse(fs.readFileSync(path.join(pluginDir, 'oci-package.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
const revision = 'a'.repeat(40);
const sha256 = bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

function fixture({ mutateManifest = () => {}, mutateConfig = () => {}, mutateFiles = () => {} } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'oci-fixture-'));
  const plugin = path.join(work, 'content', oci.pluginPath);
  fs.mkdirSync(plugin, { recursive: true });
  for (const file of ['package.json', 'index.cjs', 'workflow.cjs']) fs.copyFileSync(path.join(pluginDir, file), path.join(plugin, file));
  mutateFiles(plugin);
  const tarFile = path.join(work, 'layer.tar');
  execFileSync('tar', ['-cf', tarFile, '-C', path.join(work, 'content'), oci.pluginPath]);
  const layer = fs.readFileSync(tarFile);
  const labels = {
    'org.opencontainers.image.source': oci.sourceRepository,
    'org.opencontainers.image.revision': revision,
    'org.opencontainers.image.version': pkg.version,
    'org.opencontainers.image.created': '2026-11-05T00:00:00Z',
    'org.opencontainers.image.url': 'local',
    'org.box1.plugin.path': oci.pluginPath,
    'org.box1.plugin.package': oci.packageName,
  };
  const config = { os: 'linux', architecture: 'amd64', config: { Labels: labels } };
  mutateConfig(config);
  const configBytes = Buffer.from(JSON.stringify(config));
  const annotation = Buffer.from(JSON.stringify([{ [oci.pluginPath]: { name: oci.packageName, version: pkg.version } }])).toString('base64');
  const manifest = {
    schemaVersion: 2,
    config: { digest: sha256(configBytes) },
    layers: [{ digest: sha256(layer) }],
    annotations: { 'io.backstage.dynamic-packages': annotation },
  };
  mutateManifest(manifest);
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const blobs = { [sha256(configBytes)]: configBytes, [sha256(layer)]: layer, [sha256(manifestBytes)]: manifestBytes };
  const layout = path.join(work, 'layout');
  fs.mkdirSync(path.join(layout, 'blobs/sha256'), { recursive: true });
  for (const [digest, bytes] of Object.entries(blobs)) fs.writeFileSync(path.join(layout, 'blobs', ...digest.split(':')), bytes);
  fs.writeFileSync(path.join(layout, 'index.json'), JSON.stringify({ manifests: [{ digest: sha256(manifestBytes) }] }));
  return { layout, blobs, digest: sha256(manifestBytes) };
}

test('a valid artifact passes and reports its identity', async () => {
  const { layout, digest } = fixture();
  const result = await inspect(layoutSource(layout), oci, revision);
  assert.equal(result.digest, digest);
  assert.equal(result.packageName, 'box1-scaffolder-onboarding-dynamic');
  assert.equal(result.pluginPath, 'box1-scaffolder-onboarding');
  assert.deepEqual(result.actions.sort(), [...oci.actions].sort());
});

const failures = [
  ['a revision that is not the one built', {}, /image revision is/, 'b'.repeat(40)],
  ['a missing dynamic-packages annotation', { mutateManifest: m => { delete m.annotations; } }, /dynamic-packages annotation/],
  ['more than one layer', { mutateManifest: m => { m.layers.push(m.layers[0]); } }, /expected one layer/],
  ['the wrong platform', { mutateConfig: c => { c.architecture = 'arm64'; } }, /platform is/],
  ['a missing source label', { mutateConfig: c => { delete c.config.Labels['org.opencontainers.image.source']; } }, /missing label/],
  ['a missing plugin file', { mutateFiles: dir => fs.rmSync(path.join(dir, 'workflow.cjs')) }, /missing box1-scaffolder-onboarding\/workflow.cjs/],
  ['a renamed package', { mutateFiles: dir => {
    const file = path.join(dir, 'package.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), name: 'renamed-dynamic' }));
  } }, /package name/],
  ['a lost action', { mutateFiles: dir => {
    const file = path.join(dir, 'index.cjs');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("action('box1:development:verify','verify',config,credentials),", ''));
  } }, /registered actions/],
  ['a private dependency', { mutateFiles: dir => {
    const file = path.join(dir, 'package.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), dependencies: { lodash: '4' } }));
  } }, /Unexpected private dependency/],
];
for (const [name, change, expected, expectedRevision = revision] of failures) {
  test(`rejects ${name}`, async () => {
    const { layout } = fixture(change);
    await assert.rejects(inspect(layoutSource(layout), oci, expectedRevision), expected);
  });
}

test('rejects a malformed digest', async () => {
  const source = { manifest: async () => ({ digest: 'sha256:abc', bytes: Buffer.from('{}') }), blob: async () => Buffer.alloc(0) };
  await assert.rejects(inspect(source, oci), /malformed digest/);
});

test('rejects registry bytes that do not hash to the requested digest', async () => {
  const { blobs, digest } = fixture();
  const other = 'sha256:' + 'c'.repeat(64);
  const fetchImpl = async () => new Response(blobs[digest]);
  await assert.rejects(inspect(registrySource(oci, other, 'token', fetchImpl), oci), /hash to/);
});

test('rejects an artifact the registry cannot serve', async () => {
  const digest = 'sha256:' + 'c'.repeat(64);
  const fetchImpl = async () => new Response('', { status: 404 });
  await assert.rejects(inspect(registrySource(oci, digest, 'token', fetchImpl), oci), /returned HTTP 404/);
});

test('authenticates with a pull-scoped token and verifies registry content', async () => {
  const { blobs, digest } = fixture();
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push(url);
    if (url.includes('/openshift/token')) {
      assert.match(url, /scope=repository%3Abox1-plugins%2Fbox1-onboarding-plugin%3Apull/);
      return Response.json({ token: 'bearer' });
    }
    if (!options.headers.Authorization) {
      return new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://registry.example/openshift/token",service="registry"' } });
    }
    return new Response(blobs[url.split('/').pop()]);
  };
  const result = await inspect(registrySource(oci, digest, 'token', fetchImpl), oci, revision);
  assert.equal(result.digest, digest);
  assert(seen.some(url => url.includes('/openshift/token')));
});

test('the pinned CLI matches the deployed RHDH compatibility target', () => {
  const tool = JSON.parse(fs.readFileSync(path.join(root, 'tools/rhdh-cli/package.json'), 'utf8'));
  const version = tool.dependencies['@red-hat-developer-hub/cli'];
  assert.equal(version, oci.compatibility.rhdhCli);
  assert.match(version, /^\d+\.\d+\.\d+$/, 'The CLI version must be exact');
  assert.equal(version.split('.').slice(0, 2).join('.'), oci.compatibility.rhdh.split('.').slice(0, 2).join('.'));
  assert.equal(pkg.backstage['supported-versions'], oci.compatibility.backstage);
  assert.equal(pkg.private, true);
});

const digestA = `sha256:${'a'.repeat(64)}`;
const digestB = `sha256:${'b'.repeat(64)}`;
const repository = `${oci.registry}/${oci.repository}`;
const runtimeFiles = (reference = `oci://${repository}@${digestA}!${oci.pluginPath}`, annotationDigest = digestA, revisionValue = 'c'.repeat(40)) => ({
  dynamicPlugins: `plugins:\n      - package: ${reference}\n        disabled: false\n      - package: ./other\n`,
  backstage: `annotations:\n              box1.org/onboarding-plugin-digest: ${annotationDigest}\n              box1.org/onboarding-plugin-revision: ${revisionValue}\n`,
});

test('a release updates only the digest reference and rollout annotation', () => {
  const plan = planRuntimeUpdate(oci, runtimeFiles(), digestB, revision);
  assert.equal(plan.rollbackDigest, digestA);
  assert.equal(plan.unchanged, false);
  assert.equal(plan.dynamicPlugins, runtimeFiles(`oci://${repository}@${digestB}!${oci.pluginPath}`).dynamicPlugins);
  assert.equal(plan.backstage, runtimeFiles(undefined, digestB, revision).backstage);
  assert.equal(planRuntimeUpdate(oci, runtimeFiles(), digestA, revision).unchanged, true);
});

for (const [name, files, digest, expected] of [
  ['a missing source revision annotation', { ...runtimeFiles(), backstage: runtimeFiles().backstage.replace(/.*revision.*\n/, '') }, digestB, /source revision annotation/],
  ['a malformed release digest', runtimeFiles(), 'sha256:abc', /Malformed digest/],
  ['a mutable tag in the current configuration', runtimeFiles(`oci://${repository}:1.1.0!${oci.pluginPath}`), digestB, /not digest-pinned/],
  ['a wrong plugin path', runtimeFiles(`oci://${repository}@${digestA}!elsewhere`), digestB, /plugin path/],
  ['duplicate plugin definitions', (() => {
    const files = runtimeFiles();
    files.dynamicPlugins += `      - package: oci://${repository}@${digestB}!${oci.pluginPath}\n`;
    return files;
  })(), digestB, /found 2/],
  ['no plugin definition', { dynamicPlugins: '- package: ./box1-scaffolder-onboarding-dynamic\n', backstage: '' }, digestB, /found 0/],
  ['a stale rollout annotation', runtimeFiles(undefined, digestB), digestB, /disagree/],
  ['a missing rollout annotation', { ...runtimeFiles(), backstage: '' }, digestB, /one rollout digest annotation/],
]) {
  test(`a release rejects ${name}`, () => assert.throws(() => planRuntimeUpdate(oci, files, digest, revision), expected));
}

test('the GitOps PR records everything needed to review and roll back', () => {
  const body = pullRequestBody(oci, { digest: digestB, version: '1.2.0', revision, buildUrl: 'https://ci.example/run' }, digestA);
  for (const value of ['1.2.0', revision, repository, digestB, oci.pluginPath, 'RHDH 1.9.7', 'Backstage 1.45.3', digestA, 'https://ci.example/run']) {
    assert(body.includes(value), `Missing ${value}`);
  }
});

test('nothing in the release path deploys or publishes to npm', () => {
  const pipelines = fs.readdirSync(path.join(root, '.tekton')).map(file => fs.readFileSync(path.join(root, '.tekton', file), 'utf8'));
  assert(pipelines.length >= 2);
  for (const text of pipelines) {
    assert.doesNotMatch(text, /\b(oc|kubectl)\s+(apply|create|patch|replace|rollout|delete)\b/);
    assert.doesNotMatch(text, /\b(npm|yarn)\s+publish\b/);
  }
});
