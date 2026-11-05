// Load an exported plugin directory the way the Hub does and record what it registers.
// Backstage packages are supplied by the Hub image at runtime, so they are stubbed here;
// `node scripts/smoke-onboarding-plugin.cjs <plugin-directory> <oci-package.json>`
const Module = require('node:module');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function smokeLoad(directory, oci) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  assert.equal(manifest.name, oci.packageName, 'package name');
  assert.equal(manifest.backstage.role, 'backend-plugin-module', 'backstage role');
  assert.equal(manifest.backstage.pluginId, oci.pluginId, 'plugin ID');
  assert.equal(manifest.backstage['supported-versions'], oci.compatibility.backstage, 'Backstage compatibility');
  for (const dependency of Object.keys(manifest.dependencies ?? {})) assert.fail(`Unexpected private dependency ${dependency}`);

  const stubs = {
    '@backstage/backend-plugin-api': {
      createBackendModule: options => options,
      coreServices: { rootConfig: 'rootConfig' },
    },
    '@backstage/plugin-scaffolder-node': {
      createTemplateAction: action => action,
      scaffolderActionsExtensionPoint: 'actions',
    },
    '@backstage/integration': {
      DefaultGithubCredentialsProvider: { fromIntegrations: () => ({}) },
      ScmIntegrations: { fromConfig: () => ({}) },
    },
    '@backstage/plugin-catalog-node': { catalogServiceRef: 'catalog' },
    yaml: { parse: () => ({}), stringify: () => '' },
  };
  const load = Module._load;
  Module._load = function stubbed(request, ...rest) {
    if (stubs[request]) return stubs[request];
    assert(request.startsWith('node:') || request.startsWith('./') || path.isAbsolute(request), `Undeclared runtime dependency: ${request}`);
    return load.call(this, request, ...rest);
  };
  try {
    const entry = require(path.resolve(directory, manifest.main));
    const definition = entry.default;
    assert.equal(definition.pluginId, oci.pluginId, 'module pluginId');
    assert.equal(definition.moduleId, oci.moduleId, 'moduleId');
    const registered = [];
    let initialize;
    definition.register({ registerInit: options => { initialize = options.init; } });
    await initialize({ actions: { addActions: (...actions) => registered.push(...actions) }, config: {}, catalog: {} });
    assert.deepEqual(registered.map(action => action.id).sort(), [...oci.actions].sort(), 'registered actions');
    return { manifest, actions: registered.map(action => action.id) };
  } finally {
    Module._load = load;
  }
}
module.exports = { smokeLoad };

if (require.main === module) {
  const [directory, ociFile] = process.argv.slice(2);
  smokeLoad(directory, JSON.parse(fs.readFileSync(ociFile, 'utf8'))).then(({ manifest, actions }) => {
    console.log(`Loaded ${manifest.name} ${manifest.version}: ${actions.length} actions registered`);
  }).catch(error => { console.error(error.message); process.exit(1); });
}
