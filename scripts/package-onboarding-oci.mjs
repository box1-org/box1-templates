// Export the canonical plugin with the pinned RHDH CLI and package it as an OCI image.
//
//   npm run package:onboarding-oci -- --export-to <dir>
//   npm run package:onboarding-oci -- --tag <image> --container-tool buildah
//
// Requires `npm ci --prefix tools/rhdh-cli`. The derived package is private and is never
// published to npm. REVISION and BUILD_URL become image metadata.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'plugins/box1-onboarding');
const toolBin = path.join(root, 'tools/rhdh-cli/node_modules/.bin');
const oci = JSON.parse(fs.readFileSync(path.join(source, 'oci-package.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
const RUNTIME_FILES = ['index.cjs', 'workflow.cjs'];

const { values: args } = parseArgs({ options: {
  tag: { type: 'string' },
  'export-to': { type: 'string' },
  'container-tool': { type: 'string', default: 'podman' },
} });
if (Boolean(args.tag) === Boolean(args['export-to'])) throw new Error('Pass exactly one of --tag or --export-to');
if (!fs.existsSync(path.join(toolBin, 'rhdh-cli'))) throw new Error('Run: npm ci --prefix tools/rhdh-cli');
if (pkg.name !== oci.packageName) throw new Error(`Package name ${pkg.name} does not match ${oci.packageName}`);
if (!pkg.private) throw new Error('The onboarding plugin must stay private');

const revision = process.env.REVISION || 'unknown';
const buildUrl = process.env.BUILD_URL || 'local';
if (args.tag && !/^[a-f0-9]{40}$/.test(revision)) throw new Error('--tag requires REVISION to be a full commit SHA');
if (!/^[\w:/.~%-]+$/.test(buildUrl)) throw new Error('BUILD_URL contains unsupported characters');

const env = { ...process.env, PATH: `${toolBin}:${process.env.PATH}` };
const cli = (...cliArgs) => execFileSync(path.join(toolBin, 'rhdh-cli'), cliArgs, { cwd: stage, env, stdio: 'inherit' });

// The CLI always derives `${name}-dynamic` and computes the image path by removing that suffix.
// Staging without the suffix keeps the runtime package name identical to the canonical name.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'box1-onboarding-stage-'));
try {
  const stagedName = oci.pluginPath;
  if (`${stagedName}-dynamic` !== oci.packageName) throw new Error('pluginPath must be packageName without -dynamic');
  fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify({ ...pkg, name: stagedName, scripts: {} }, null, 2)}\n`);
  for (const file of RUNTIME_FILES) fs.copyFileSync(path.join(source, file), path.join(stage, file));
  // There are no private dependencies, so there is nothing to lock or install.
  fs.writeFileSync(path.join(stage, 'yarn.lock'), '');
  // The export writes its generated config schema here, and this plugin has no build output.
  fs.mkdirSync(path.join(stage, 'dist-dynamic/dist'), { recursive: true });

  cli('plugin', 'export', '--no-build', '--no-install');

  const derived = JSON.parse(fs.readFileSync(path.join(stage, 'dist-dynamic/package.json'), 'utf8'));
  if (derived.name !== oci.packageName) throw new Error(`Derived package is ${derived.name}, expected ${oci.packageName}`);
  if (derived.version !== pkg.version) throw new Error(`Derived version is ${derived.version}, expected ${pkg.version}`);
  if (derived.main !== pkg.main) throw new Error(`Derived entry point is ${derived.main}, expected ${pkg.main}`);
  if (JSON.stringify(derived.backstage) !== JSON.stringify(pkg.backstage)) throw new Error('Derived backstage metadata changed');
  for (const file of RUNTIME_FILES) {
    const same = fs.readFileSync(path.join(source, file)).equals(fs.readFileSync(path.join(stage, 'dist-dynamic', file)));
    if (!same) throw new Error(`Derived ${file} differs from the canonical source`);
  }

  if (args['export-to']) {
    cli('plugin', 'package', '--export-to', path.resolve(args['export-to']));
    console.log(`Exported ${oci.packageName} ${pkg.version} to ${args['export-to']}/${oci.pluginPath}`);
  } else {
    const metadata = {
      'org.opencontainers.image.title': 'box1-onboarding-plugin',
      'org.opencontainers.image.source': oci.sourceRepository,
      'org.opencontainers.image.revision': revision,
      'org.opencontainers.image.version': pkg.version,
      'org.opencontainers.image.created': new Date().toISOString(),
      'org.opencontainers.image.url': buildUrl,
      'org.box1.compatibility.rhdh': oci.compatibility.rhdh,
      'org.box1.plugin.package': oci.packageName,
      'org.box1.plugin.path': oci.pluginPath,
    };
    const pairs = Object.entries(metadata).map(([key, value]) => `${key}=${value}`);
    cli('plugin', 'package', '--tag', args.tag, '--container-tool', args['container-tool'],
      '--platform', 'linux/amd64', ...pairs.flatMap(pair => ['--label', pair]), ...pairs.flatMap(pair => ['--annotation', pair]));
    console.log(`Packaged ${oci.packageName} ${pkg.version} as ${args.tag}`);
  }
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
