// Inspect the onboarding plugin image, from an OCI layout or from the registry, and load it.
//
//   node scripts/inspect-onboarding-oci.mjs --layout <oci-dir> [--revision <sha>]
//   REGISTRY_TOKEN=... node scripts/inspect-onboarding-oci.mjs --digest sha256:... [--revision <sha>]
//
// A registry read recomputes the digest from the returned manifest bytes.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { smokeLoad } = require('./smoke-onboarding-plugin.cjs');

const fail = message => { throw new Error(`Artifact inspection failed: ${message}`); };
const sha256 = bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

export function layoutSource(directory) {
  const blob = async digest => fs.readFileSync(path.join(directory, 'blobs', ...digest.split(':')));
  return {
    async manifest() {
      const index = JSON.parse(fs.readFileSync(path.join(directory, 'index.json'), 'utf8'));
      if (index.manifests?.length !== 1) fail('the layout must contain exactly one manifest');
      const digest = index.manifests[0].digest;
      return { digest, bytes: await blob(digest) };
    },
    blob,
  };
}

export function registrySource(oci, digest, token, fetchImpl = fetch) {
  const base = `https://${oci.registry}/v2/${oci.repository}`;
  let bearer;
  async function get(url, headers = {}) {
    const send = () => fetchImpl(url, { headers: { ...headers, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) } });
    let response = await send();
    if (response.status === 401 && !bearer) {
      const challenge = response.headers.get('www-authenticate') ?? '';
      const realm = challenge.match(/realm="([^"]+)"/)?.[1];
      if (!realm) fail(`no token realm from ${oci.registry}`);
      const query = new URLSearchParams({ service: challenge.match(/service="([^"]+)"/)?.[1] ?? '', scope: `repository:${oci.repository}:pull` });
      const login = await fetchImpl(`${realm}?${query}`, {
        headers: { Authorization: `Basic ${Buffer.from(`serviceaccount:${token}`).toString('base64')}` },
      });
      if (!login.ok) fail(`registry login returned HTTP ${login.status}`);
      bearer = (await login.json()).token;
      response = await send();
    }
    if (!response.ok) fail(`${url} returned HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  return {
    async manifest() {
      const bytes = await get(`${base}/manifests/${digest}`, {
        Accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json',
      });
      return { digest, bytes };
    },
    blob: blobDigest => get(`${base}/blobs/${blobDigest}`),
  };
}

export async function inspect(source, oci, expectedRevision) {
  const { digest, bytes } = await source.manifest();
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) fail(`malformed digest ${digest}`);
  if (sha256(bytes) !== digest) fail(`manifest bytes hash to ${sha256(bytes)}, not ${digest}`);
  const manifest = JSON.parse(bytes);
  // The 1.9 installer extracts only the first layer.
  if (manifest.layers?.length !== 1) fail(`expected one layer, found ${manifest.layers?.length}`);
  const annotation = manifest.annotations?.['io.backstage.dynamic-packages'];
  if (!annotation) fail('missing the io.backstage.dynamic-packages annotation');
  const packages = JSON.parse(Buffer.from(annotation, 'base64').toString());
  const described = packages.find(entry => entry[oci.pluginPath])?.[oci.pluginPath];
  if (!described) fail(`annotation does not list plugin path ${oci.pluginPath}`);
  if (described.name !== oci.packageName) fail(`annotation names ${described.name}, expected ${oci.packageName}`);

  const config = JSON.parse(await source.blob(manifest.config.digest));
  if (config.os !== 'linux' || config.architecture !== 'amd64') fail(`platform is ${config.os}/${config.architecture}`);
  const labels = config.config?.Labels ?? {};
  const required = ['source', 'revision', 'version', 'created', 'url'].map(key => `org.opencontainers.image.${key}`);
  for (const label of required) if (!labels[label]) fail(`missing label ${label}`);
  const revision = labels['org.opencontainers.image.revision'];
  if (expectedRevision && revision !== expectedRevision) fail(`image revision is ${revision}, expected ${expectedRevision}`);
  if (labels['org.box1.plugin.path'] !== oci.pluginPath) fail('plugin path label mismatch');
  if (labels['org.box1.plugin.package'] !== oci.packageName) fail('package name label mismatch');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'box1-onboarding-inspect-'));
  try {
    const layer = await source.blob(manifest.layers[0].digest);
    if (sha256(layer) !== manifest.layers[0].digest) fail('layer bytes do not match the manifest');
    const archive = path.join(work, 'layer.tar');
    fs.writeFileSync(archive, layer);
    const entries = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).split('\n').filter(Boolean);
    for (const file of ['package.json', 'index.cjs', 'workflow.cjs']) {
      const expected = `${oci.pluginPath}/${file}`;
      if (!entries.some(entry => entry.replace(/^\.\//, '') === expected)) fail(`missing ${expected}`);
    }
    const extracted = path.join(work, 'extracted');
    fs.mkdirSync(extracted);
    execFileSync('tar', ['-xf', archive, '-C', extracted]);
    const pluginDirectory = path.join(extracted, oci.pluginPath);
    const manifestVersion = JSON.parse(fs.readFileSync(path.join(pluginDirectory, 'package.json'), 'utf8')).version;
    if (labels['org.opencontainers.image.version'] !== manifestVersion) fail('version label does not match package.json');
    const loaded = await smokeLoad(pluginDirectory, oci);
    return { digest, revision, version: manifestVersion, labels, pluginPath: oci.pluginPath, packageName: loaded.manifest.name, actions: loaded.actions };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === import.meta.filename) {
  const { values: args } = parseArgs({ options: {
    layout: { type: 'string' }, digest: { type: 'string' }, revision: { type: 'string' },
  } });
  const oci = JSON.parse(fs.readFileSync(path.join(root, 'plugins/box1-onboarding/oci-package.json'), 'utf8'));
  if (Boolean(args.layout) === Boolean(args.digest)) fail('pass exactly one of --layout or --digest');
  const source = args.layout ? layoutSource(args.layout) : registrySource(oci, args.digest, process.env.REGISTRY_TOKEN);
  const result = await inspect(source, oci, args.revision);
  console.log(JSON.stringify({ ...result, labels: undefined }, null, 2));
}
