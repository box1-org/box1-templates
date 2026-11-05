import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import nunjucks from 'nunjucks';
import YAML from 'yaml';
import Ajv from 'ajv';
import { resolveKubectl } from './kubectl-tool.mjs';

const root = path.resolve(import.meta.dirname, '..');
const kubectl = await resolveKubectl();
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

const techdocsOverview = 'First line with "quotes" & <b>markup</b>: `code`.\n\nSecond paragraph.';
for (const [name, integrations] of [['orders-api', { postgres: false, kafka: false, techdocsOverview }], ['inventory-service', { postgres: true, kafka: false }], ['quarkus-golden-path-smoke', { postgres: false, kafka: true }], ['a'.repeat(35), { postgres: true, kafka: true }]]) {
  const parameters = { name, description: 'A Quarkus REST service on OpenShift', owner: 'user:default/mike4263', visibility: 'private', ...integrations };
  assert(checkForm(parameters), JSON.stringify(checkForm.errors));
  const values = { ...parameters, namespace: name + '-dev', sourceRevision: 'a'.repeat(40) };
  const target = path.join(root, '.validation', name);
  fs.rmSync(target, { recursive: true, force: true });
  renderTree(path.join(source, 'skeleton'), path.join(target, 'application'), values);
  renderTree(path.join(source, 'gitops'), path.join(target, 'gitops'), values);
  const pom = fs.readFileSync(path.join(target, 'application/pom.xml'), 'utf8');
  assert.equal(pom.includes('quarkus-jdbc-postgresql'), Boolean(parameters.postgres));
  assert.equal(pom.includes('quarkus-messaging-kafka'), Boolean(parameters.kafka));
  for (const folder of [path.join(target, `gitops/workloads/${name}`)]) {
    const resources = YAML.parseAllDocuments(execFileSync(kubectl, ['kustomize', folder], { encoding: 'utf8' })).map(d => d.toJSON());
    const deployment = resources.find(r => r.kind === 'Deployment');
    assert.equal(deployment.metadata.namespace, name + '-dev');
    assert.equal(deployment.metadata.labels['backstage.io/kubernetes-id'], name);
    assert.equal(deployment.spec.template.metadata.labels['backstage.io/kubernetes-id'], name);
    assert.equal(deployment.spec.replicas, 0);
    assert.equal(deployment.spec.template.spec.containers[0].image, `image-registry.openshift-image-registry.svc:5000/box1-ci/${name}@sha256:${'0'.repeat(64)}`);
    if (folder.includes('/gitops/')) {
      const postgres = resources.find(r => r.kind === 'Deployment' && r.metadata.name === `${name}-postgres`);
      const postgresSecret = resources.find(r => r.kind === 'Secret' && r.metadata.name === `${name}-postgres`);
      const postgresPvc = resources.find(r => r.kind === 'PersistentVolumeClaim' && r.metadata.name === `${name}-postgres-data`);
      const kafkaTopics = resources.filter(r => r.kind === 'KafkaTopic');
      assert.equal(Boolean(postgres), Boolean(parameters.postgres));
      assert.equal(Boolean(postgresSecret), Boolean(parameters.postgres));
      assert.equal(Boolean(postgresPvc), Boolean(parameters.postgres));
      assert.equal(kafkaTopics.length, 0, 'Kafka topics are managed outside the service onboarding bundle');
      if (parameters.postgres) {
        assert.equal(postgres.spec.template.spec.containers[0].envFrom[0].secretRef.name, `${name}-postgres`);
        assert.equal(postgresPvc.spec.resources.requests.storage, '5Gi');
        assert.equal(postgresSecret.stringData.POSTGRESQL_PASSWORD, 'replace-before-sync');
      }
    }
    const cm = resources.find(r => r.kind === 'ConfigMap');
    assert.equal(cm.metadata.namespace, name + '-dev');
    assert.equal(deployment.spec.template.spec.containers[0].envFrom[0].configMapRef.name, cm.metadata.name);
    const pac = resources.find(r => r.kind === 'Repository');
    assert.equal(pac.metadata.namespace, 'box1-ci');
    assert.equal(pac.spec.url, `https://github.com/box1-org/${name}`);
    assert.deepEqual(pac.spec.settings.github_app_token_scope_repos, ['box1-org/box1-workloads-dev']);
    assert.equal(resources.find(r => r.kind === 'Role' && r.metadata.namespace === 'openshift-gitops').rules[0].resourceNames[0], name);
    assert(resources.some(r => r.kind === 'Route' && r.spec.host === `${name}-dev.apps.ocp.box1.org`));
    const text = fs.readFileSync(path.join(folder, 'kustomization.yaml'), 'utf8');
    assert.equal((text.match(/^    digest: sha256:[a-f0-9]{64}$/gm) ?? []).length, 1, 'Promotion digest replacement contract');
  }
  const context = { parameters, steps: { publish: { output: { commitHash: 'a'.repeat(40), remoteUrl: `https://github.com/box1-org/${name}`, repoContentsUrl: `https://github.com/box1-org/${name}/blob/main` } }, onboarding: { output: { remoteUrl: 'https://github.com/box1-org/box1-workloads-dev/pull/1' } }, register: { output: { entityRef: `component:default/${name}` } } } };
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
  const catalogEntities = YAML.parseAllDocuments(fs.readFileSync(path.join(app, 'catalog-info.yaml'), 'utf8')).map(d => d.toJSON());
  const catalog = catalogEntities.find(e => e.kind === 'Component');
  const api = catalogEntities.find(e => e.kind === 'API');
  assert.deepEqual(catalog.spec.providesApis, [name + '-api']);
  assert.equal(api.metadata.name, name + '-api');
  assert.equal(api.spec.type, 'openapi');
  assert.equal(api.spec.owner, parameters.owner);
  assert.equal(api.spec.definition.$text, `https://${name}-dev.apps.ocp.box1.org/q/openapi`);
  assert(catalog.metadata.links.some(l => l.url === `https://${name}-dev.apps.ocp.box1.org/q/swagger-ui/`));
  assert(catalog.metadata.links.some(l => l.url === `https://devspaces.apps.ocp.box1.org/#https://github.com/box1-org/${name}`));
  assert.equal(catalog.metadata.annotations['backstage.io/techdocs-ref'], 'dir:.');
  assert.equal(catalog.metadata.annotations['backstage.io/source-location'], `url:https://github.com/box1-org/${name}/`);
  assert(catalog.metadata.links.some(l => l.url === `https://github.com/box1-org/${name}` && l.title === 'Source Repository' && l.icon === 'github'));
  assert.equal(YAML.parse(fs.readFileSync(path.join(app, 'mkdocs.yml'), 'utf8')).site_name, name);
  const docsHome = fs.readFileSync(path.join(app, 'docs/index.md'), 'utf8');
  assert.equal(docsHome.includes('## Overview'), Boolean(parameters.techdocsOverview));
  if (parameters.techdocsOverview) assert(docsHome.includes(parameters.techdocsOverview), 'TechDocs overview was not rendered verbatim');
  assert.equal(catalog.spec.owner, parameters.owner);
  assert.equal(catalog.metadata.name, name);
  assert.equal(catalog.metadata.annotations['backstage.io/kubernetes-id'], name);
  assert.equal(catalog.metadata.annotations['janus-idp.io/tekton'], name);
  assert.equal(catalog.metadata.annotations['argocd/app-selector'], `backstage.io/kubernetes-id=${name}`);
  assert.equal(catalog.metadata.annotations['argocd/instance-name'], 'openshift-gitops');
  assert(!catalog.metadata.annotations['backstage.io/kubernetes-namespace']);
  const argo = YAML.parse(fs.readFileSync(path.join(target, `gitops/applications/${name}.yaml`), 'utf8'));
  assert.equal(argo.metadata.labels['backstage.io/kubernetes-id'], name);
  for (const file of ['.tekton/pull-request.yaml', '.tekton/release.yaml']) {
    const run = YAML.parse(fs.readFileSync(path.join(app, file), 'utf8'));
    assert.equal(run.metadata.labels['backstage.io/kubernetes-id'], name);
    for (const task of run.spec.pipelineSpec.tasks) {
      assert.equal(task.taskRef.resolver, 'cluster');
      assert(run.metadata.generateName.length + 5 + 1 + task.name.length + 4 <= 63, 'Generated TaskRun/Pod name exceeds DNS label limit');
      const args = Object.fromEntries(task.params.map(p => [p.name, p.value]));
      if (['build', 'validate'].includes(task.name)) {
        assert.equal(args['source-repo'], `box1-org/${name}`);
        assert.equal(args['image-name'], name);
      } else {
        assert.equal(args['application-name'], name);
        if (task.name === 'smoke') assert.equal(args['application-namespace'], name + '-dev');
      }
    }
  }
  console.log(`PASS ${name}: render, ownership, pipeline contract, namespaces, Kustomize${actionsFile ? ', installed actions' : ''}`);
}
const repositorySource = path.join(root, 'templates/github-repository');
const repositoryTemplate = YAML.parse(fs.readFileSync(path.join(repositorySource, 'template.yaml'), 'utf8'));
const checkRepositoryForm = ajv.compile(repositoryTemplate.spec.parameters[0]);
const rootEntities = YAML.parseAllDocuments(fs.readFileSync(path.join(root, 'catalog-info.yaml'), 'utf8')).map(d => d.toJSON());
const rootLocation = rootEntities.find(e => e.kind === 'Location');
for (const target of rootLocation.spec.targets) assert(fs.existsSync(path.join(root, target)), `Missing Location target: ${target}`);
assert(rootLocation.spec.targets.includes('./templates/github-repository/template.yaml'));
const rootComponent = rootEntities.find(e => e.kind === 'Component');
assert.equal(rootComponent.metadata.name, 'box1-templates');
assert.equal(rootComponent.metadata.annotations['github.com/project-slug'], 'box1-org/box1-templates');
assert.equal(repositoryTemplate.spec.parameters[0].properties.visibility.default, 'public');
assert.deepEqual(repositoryTemplate.spec.steps.map(step => step.action), ['fetch:template', 'publish:github', 'catalog:register']);
for (const name of ['team-notes', 'box1-example-docs', 'a'.repeat(63)]) {
  const parameters = { name, description: 'A plain repository', owner: 'user:default/mike4263', visibility: 'public' };
  assert(checkRepositoryForm(parameters), JSON.stringify(checkRepositoryForm.errors));
  const target = path.join(root, '.validation/github-repository', name);
  fs.rmSync(target, { recursive: true, force: true });
  renderTree(path.join(repositorySource, 'skeleton'), target, parameters);
  assert.deepEqual(fs.readdirSync(target).sort(), ['README.md', 'catalog-info.yaml']);
  const entity = YAML.parse(fs.readFileSync(path.join(target, 'catalog-info.yaml'), 'utf8'));
  assert.equal(entity.metadata.name, name);
  assert.equal(entity.metadata.annotations['github.com/project-slug'], `box1-org/${name}`);
  assert.equal(entity.spec.owner, parameters.owner);
  const context = { parameters, steps: { publish: { output: { repoContentsUrl: `https://github.com/box1-org/${name}/blob/main`, remoteUrl: `https://github.com/box1-org/${name}` } } } };
  for (const step of repositoryTemplate.spec.steps) {
    const action = actions.find(a => a.id === step.action);
    if (actionsFile) assert(action, `Installed action missing: ${step.action}`);
    if (action?.schema?.input) {
      const input = JSON.parse(env.renderString(JSON.stringify(step.input), context));
      const check = ajv.compile(action.schema.input);
      assert(check(input), `${step.id}: ${JSON.stringify(check.errors)}`);
    }
  }
  console.log(`PASS github-repository ${name}: render, ownership, no build or deployment files`);
}
for (const name of ['../escape', 'Uppercase', 'ab', 'a--b', 'a-', 'a'.repeat(64)]) {
  assert(!checkRepositoryForm({ name, description: 'Invalid name test', owner: 'user:default/mike4263', visibility: 'public' }), `Accepted unsafe repository name: ${name}`);
}
console.log('PASS github-repository rejected unsafe names');
for (const name of ['../escape', 'Uppercase', 'ab', 'box1-workloads-dev', 'quarkus-reference', 'orders-service', 'default', 'rhdh', 'openshift-gitops', 'kube-system', 'a--b', 'a-', 'a'.repeat(36)]) {
  assert(!checkForm({ name, description: 'Invalid name test', owner: 'user:default/mike4263', visibility: 'private' }), `Accepted unsafe name: ${name}`);
}
console.log('PASS rejected unsafe/reserved names');
assert(!checkForm({ name: 'orders-api', description: 'Too long', owner: 'user:default/mike4263', visibility: 'public', techdocsOverview: 'a'.repeat(2001) }), 'Accepted an oversized TechDocs overview');
