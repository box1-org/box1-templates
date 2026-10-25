import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import nunjucks from 'nunjucks';
import YAML from 'yaml';
import Ajv from 'ajv';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'templates/quarkus-rest-service');
const env = new nunjucks.Environment(null, {
  autoescape: false, throwOnUndefined: true,
  tags: { variableStart: '${{', variableEnd: '}}' },
});
const ajv = new Ajv({ strict: false });
const template = YAML.parse(fs.readFileSync(path.join(source, 'template.yaml'), 'utf8'));
const checkForm = ajv.compile(template.spec.parameters[0]);
const actionsFile = process.env.ACTION_SCHEMAS;
const actions = actionsFile ? JSON.parse(fs.readFileSync(actionsFile, 'utf8')) : [];

function renderTree(from, to, values) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, env.renderString(entry.name, { values }));
    if (entry.isDirectory()) renderTree(src, dest, values);
    else {
      const text = env.renderString(fs.readFileSync(src, 'utf8'), { values });
      assert(!text.includes('${{'), `Unrendered variable in ${dest}`);
      fs.writeFileSync(dest, text, { mode: fs.statSync(src).mode });
      if (/\.ya?ml$/.test(dest)) YAML.parseAllDocuments(text).forEach(doc => assert.equal(doc.errors.length, 0, dest));
    }
  }
}

for (const name of ['orders-api', 'inventory-service', 'quarkus-golden-path-smoke']) {
  const parameters = { name, description: 'A Quarkus REST service on OpenShift', owner: 'user:default/mike4263', visibility: 'private' };
  assert(checkForm(parameters), JSON.stringify(checkForm.errors));
  const values = { ...parameters, sourceRevision: 'a'.repeat(40) };
  const target = path.join(root, '.validation', name);
  fs.rmSync(target, { recursive: true, force: true });
  renderTree(path.join(source, 'skeleton'), path.join(target, 'application'), values);
  renderTree(path.join(source, 'gitops'), path.join(target, 'gitops'), values);
  for (const folder of [path.join(target, 'application/deploy'), path.join(target, `gitops/workloads/${name}`)]) {
    const resources = YAML.parseAllDocuments(execFileSync('kubectl', ['kustomize', folder], { encoding: 'utf8' })).map(d => d.toJSON());
    const deployment = resources.find(r => r.kind === 'Deployment');
    assert.equal(deployment.metadata.namespace, name);
    assert.equal(deployment.spec.replicas, 0);
    assert.equal(deployment.spec.template.spec.containers[0].image, `image-registry.openshift-image-registry.svc:5000/box1-ci/${name}@sha256:${'0'.repeat(64)}`);
    const cm = resources.find(r => r.kind === 'ConfigMap');
    assert.equal(cm.metadata.namespace, name);
    assert.equal(deployment.spec.template.spec.containers[0].envFrom[0].configMapRef.name, cm.metadata.name);
    const pac = resources.find(r => r.kind === 'Repository');
    assert.equal(pac.metadata.namespace, 'box1-ci');
    assert.equal(pac.spec.url, `https://github.com/box1-org/${name}`);
    assert.deepEqual(pac.spec.settings.github_app_token_scope_repos, ['box1-org/box1-gitops']);
    assert.equal(resources.find(r => r.kind === 'Role' && r.metadata.namespace === 'openshift-gitops').rules[0].resourceNames[0], name);
    assert(resources.some(r => r.kind === 'Route' && r.spec.host === `${name}.apps.ocp.box1.org`));
    const text = fs.readFileSync(path.join(folder, 'kustomization.yaml'), 'utf8');
    assert.equal((text.match(/^    digest: sha256:[a-f0-9]{64}$/gm) ?? []).length, 1, 'Promotion digest replacement contract');
  }
  const context = { parameters, steps: { publish: { output: { commitHash: 'a'.repeat(40), remoteUrl: `https://github.com/box1-org/${name}`, repoContentsUrl: `https://github.com/box1-org/${name}/blob/main` } }, onboarding: { output: { remoteUrl: 'https://github.com/box1-org/box1-gitops/pull/1' } }, register: { output: { entityRef: `component:default/${name}` } } } };
  for (const step of template.spec.steps) {
    const action = actions.find(a => a.id === step.action);
    if (actionsFile) assert(action, `Installed action missing: ${step.action}`);
    if (action?.schema?.input) {
      const input = JSON.parse(env.renderString(JSON.stringify(step.input), context));
      const check = ajv.compile(action.schema.input);
      assert(check(input), `${step.id}: ${JSON.stringify(check.errors)}`);
    }
  }
  const app = path.join(target, 'application');
  const catalog = YAML.parse(fs.readFileSync(path.join(app, 'catalog-info.yaml'), 'utf8'));
  assert.equal(catalog.spec.owner, parameters.owner);
  assert.equal(catalog.metadata.name, name);
  for (const file of ['.tekton/pull-request.yaml', '.tekton/release.yaml']) {
    const run = YAML.parse(fs.readFileSync(path.join(app, file), 'utf8'));
    for (const task of run.spec.pipelineSpec.tasks) {
      assert.equal(task.taskRef.resolver, 'cluster');
      const args = Object.fromEntries(task.params.map(p => [p.name, p.value]));
      if (['build', 'validate'].includes(task.name)) {
        assert.equal(args['source-repo'], `box1-org/${name}`);
        assert.equal(args['image-name'], name);
      } else assert.equal(args['application-name'], name);
    }
  }
  console.log(`PASS ${name}: render, ownership, pipeline contract, namespaces, Kustomize${actionsFile ? ', installed actions' : ''}`);
}
for (const name of ['../escape', 'Uppercase', 'ab', 'box1-gitops', 'quarkus-reference', 'default', 'rhdh', 'openshift-gitops', 'kube-system', 'a--b', 'a-', 'a'.repeat(41)]) {
  assert(!checkForm({ name, description: 'Invalid name test', owner: 'user:default/mike4263', visibility: 'private' }), `Accepted unsafe name: ${name}`);
}
console.log('PASS rejected unsafe/reserved names');
