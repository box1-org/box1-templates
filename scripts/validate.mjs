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
  const parameters = { name, description: 'A Quarkus REST service on OpenShift', owner: 'user:default/mike', visibility: 'private', ...integrations };
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
      const postgresPolicy = resources.find(r => r.kind === 'NetworkPolicy' && r.metadata.name === `${name}-postgres`);
      assert.equal(Boolean(postgresPolicy), Boolean(parameters.postgres));
      const runtimeConfig = resources.find(r => r.kind === 'ConfigMap');
      assert.equal(runtimeConfig.data.KAFKA_BOOTSTRAP_SERVERS === 'box1-kafka-kafka-bootstrap.box1-kafka.svc:9092', Boolean(parameters.kafka));
      assert.match(runtimeConfig.data.JAVA_TOOL_OPTIONS, /MaxRAMPercentage=50\.0/);
      assert.equal(Boolean(postgres), Boolean(parameters.postgres));
      assert.equal(Boolean(postgresSecret), Boolean(parameters.postgres));
      assert.equal(Boolean(postgresPvc), Boolean(parameters.postgres));
      assert.equal(kafkaTopics.length, 0, 'Kafka topics are managed outside the service onboarding bundle');
      if (parameters.postgres) {
        assert.equal(postgres.spec.template.spec.containers[0].envFrom[0].secretRef.name, `${name}-postgres`);
        assert.equal(postgresPvc.spec.resources.requests.storage, '5Gi');
        assert.equal(postgresSecret.stringData.POSTGRESQL_PASSWORD, 'replace-before-sync');
        assert.equal(postgres.spec.template.spec.containers[0].resources.limits.memory, '512Mi');
        assert.equal(postgresPolicy.spec.podSelector.matchLabels['app.kubernetes.io/name'], `${name}-postgres`);
        assert.equal(postgresPolicy.spec.ingress[0].from[0].podSelector.matchLabels['app.kubernetes.io/name'], name);
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
    if (file === '.tekton/release.yaml') {
      // box1-docs#42: new services run ACS/TPA checks and block on policy failure.
      assert.equal(run.spec.params.find(p => p.name === 'security-gates')?.value, 'gate', 'release must pass security-gates: gate');
      assert.equal(run.spec.pipelineSpec.params.find(p => p.name === 'security-gates')?.default, 'gate', 'release security-gates default must be gate');
      const security = run.spec.pipelineSpec.tasks.find(t => t.name === 'security');
      assert.equal(security?.params.find(p => p.name === 'enforcement')?.value, '$(params.security-gates)');
      assert.equal(run.spec.pipelineSpec.tasks.find(t => t.name === 'promote')?.runAfter?.includes('security'), true, 'promote must wait for the security gate');
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
  const parameters = { name, description: 'A plain repository', owner: 'user:default/mike', visibility: 'public' };
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
  assert(!checkRepositoryForm({ name, description: 'Invalid name test', owner: 'user:default/mike', visibility: 'public' }), `Accepted unsafe repository name: ${name}`);
}
console.log('PASS github-repository rejected unsafe names');
for (const name of ['../escape', 'Uppercase', 'ab', 'box1-workloads-dev', 'quarkus-reference', 'orders-service', 'default', 'rhdh', 'openshift-gitops', 'kube-system', 'a--b', 'a-', 'a'.repeat(36)]) {
  assert(!checkForm({ name, description: 'Invalid name test', owner: 'user:default/mike', visibility: 'private' }), `Accepted unsafe name: ${name}`);
}
console.log('PASS rejected unsafe/reserved names');
assert(!checkForm({ name: 'orders-api', description: 'Too long', owner: 'user:default/mike', visibility: 'public', techdocsOverview: 'a'.repeat(2001) }), 'Accepted an oversized TechDocs overview');

// ---- templates/rhel-image-vm (virtual-machine onboarding profile, box1-docs#55) ----
{
  const { createRequire } = await import('node:module');
  const { validateVmBundle, filesAt } = createRequire(import.meta.url)('../plugins/box1-onboarding/workflow.cjs');
  const vmSource = path.join(root, 'templates/rhel-image-vm');
  const vmTemplate = YAML.parse(fs.readFileSync(path.join(vmSource, 'template.yaml'), 'utf8'));
  const checkVmForm = ajv.compile(vmTemplate.spec.parameters[0]);
  assert(rootLocation.spec.targets.includes('./templates/rhel-image-vm/template.yaml'), 'rhel-image-vm must be registered in the root Location');
  assert.equal(vmTemplate.spec.type, 'vm');
  const phaseSteps = vmTemplate.spec.steps.filter(s => s.action.startsWith('box1:development:') || s.action === 'box1:repository:ensure');
  assert(phaseSteps.every(s => s.input.profile === 'virtual-machine'), 'Every onboarding step must use the virtual-machine profile');
  const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGoldenPathValidationKeyGoldenPathValidation admin@box1';
  for (const [name, extra] of [['vm-golden-check', {}], ['erp-appliance', { cpuCores: 4, memory: '8Gi', rootDiskSize: '20Gi', extraPackages: 'python3-pip sqlite' }], ['v'.repeat(35), {}]]) {
    const parameters = { name, description: 'A RHEL 10 image mode virtual machine', owner: 'user:default/mike', visibility: 'private', adminSshPublicKey: key, cpuCores: 2, memory: '4Gi', rootDiskSize: '12Gi', extraPackages: '', ...extra };
    assert(checkVmForm(parameters), JSON.stringify(checkVmForm.errors));
    const values = { ...parameters, namespace: name + '-dev', sourceRevision: 'b'.repeat(40) };
    const target = path.join(root, '.validation/rhel-image-vm', name);
    fs.rmSync(target, { recursive: true, force: true });
    renderTree(path.join(vmSource, 'skeleton'), path.join(target, 'application'), values);
    renderTree(path.join(vmSource, 'gitops'), path.join(target, 'gitops'), values);
    // The plugin's bundle check is the same gate the onboarding action applies.
    validateVmBundle(await filesAt(path.join(target, 'gitops')), name);
    const resources = YAML.parseAllDocuments(execFileSync(kubectl, ['kustomize', path.join(target, `gitops/workloads/${name}`)], { encoding: 'utf8' })).map(d => d.toJSON());
    const vm = resources.find(r => r.kind === 'VirtualMachine');
    assert.equal(vm.spec.runStrategy, 'Halted');
    assert.equal(vm.metadata.annotations['box1.org/os-image-digest'], 'sha256:' + '0'.repeat(64));
    assert.equal(vm.metadata.annotations['box1.org/source-revision'], 'b'.repeat(40));
    assert.equal(vm.metadata.labels['backstage.io/kubernetes-id'], name);
    assert.equal(vm.spec.template.spec.domain.cpu.cores, parameters.cpuCores);
    assert.equal(vm.spec.template.spec.domain.memory.guest, parameters.memory);
    assert(!resources.some(r => r.kind === 'DataVolume'), 'Unbuilt VM bundle must not render its DataVolume');
    assert(!resources.some(r => ['Deployment', 'Route', 'Service'].includes(r.kind)));
    assert.equal(resources.find(r => r.kind === 'Namespace').metadata.labels['box1.org/workload-profile'], 'virtual-machine');
    assert.equal(resources.find(r => r.kind === 'Secret' && r.metadata.name === `${name}-admin-ssh`).stringData.key1, key);
    const dv = YAML.parse(fs.readFileSync(path.join(target, `gitops/workloads/${name}/datavolume.yaml`), 'utf8'));
    assert.equal(dv.spec.storage.resources.requests.storage, parameters.rootDiskSize);
    assert.match(fs.readFileSync(path.join(target, `gitops/workloads/${name}/datavolume.yaml`), 'utf8'), new RegExp(`^      url: docker://image-registry\\.openshift-image-registry\\.svc:5000/box1-ci/${name}-disk@sha256:0{64}$`, 'm'), 'Promotion contract: 6-space DataVolume url line');
    assert.match(fs.readFileSync(path.join(target, `gitops/workloads/${name}/kustomization.yaml`), 'utf8'), /^  - virtualmachine\.yaml$/m, 'Promotion contract: kustomization resource line');
    // Skeleton: OS image definition and pipelines.
    const app = path.join(target, 'application');
    const containerfile = fs.readFileSync(path.join(app, 'Containerfile'), 'utf8');
    assert.match(containerfile, /^FROM registry\.redhat\.io\/rhel10\/rhel-bootc:10\.2@sha256:[a-f0-9]{64}$/m);
    for (const required of ['setsebool -P virt_qemu_ga_manage_ssh on', `systemctl set-default ${name}.target`, 'bootc container lint', 'systemctl disable bootc-fetch-apply-updates.timer', 'id=entitlement-cert']) assert(containerfile.includes(required), `Containerfile must include ${required}`);
    assert.match(containerfile, new RegExp(`qemu-guest-agent ${parameters.extraPackages.replace(/[+.]/g, '\\$&')}`));
    for (const file of [`rootfs/usr/lib/systemd/system/${name}.target`, `rootfs/usr/lib/systemd/system/${name}-heartbeat.service`, `rootfs/usr/libexec/${name}/heartbeat`, 'rootfs/usr/libexec/box1/registry-setup', 'rootfs/usr/lib/systemd/system/box1-registry-setup.service', 'build/repos/rhel10-cdn.repo']) assert(fs.existsSync(path.join(app, file)), `Missing skeleton file ${file}`);
    assert(fs.statSync(path.join(app, `rootfs/usr/libexec/${name}/heartbeat`)).mode & 0o100, 'heartbeat must be executable');
    assert(!fs.readFileSync(path.join(app, 'build/repos/rhel10-cdn.repo'), 'utf8').match(/BEGIN|PRIVATE/), 'Repository file must not contain credentials');
    const pr = YAML.parse(fs.readFileSync(path.join(app, '.tekton/pull-request.yaml'), 'utf8'));
    assert.equal(pr.spec.taskRunTemplate.serviceAccountName, 'ci-bootc-check');
    assert.deepEqual(pr.spec.pipelineSpec.tasks.map(t => t.taskRef.params.find(p => p.name === 'name').value), ['box1-bootc-build']);
    assert.equal(pr.spec.pipelineSpec.tasks[0].params.find(p => p.name === 'push-image').value, 'false');
    const release = YAML.parseAllDocuments(fs.readFileSync(path.join(app, '.tekton/release.yaml'), 'utf8')).map(d => d.toJSON()).find(Boolean);
    assert.equal(release.spec.taskRunTemplate.serviceAccountName, 'ci-bootc-release');
    assert.deepEqual(release.spec.pipelineSpec.tasks.map(t => [t.name, t.taskRef.params.find(p => p.name === 'name').value]), [['build', 'box1-bootc-build'], ['security', 'box1-security-gates'], ['disk', 'box1-bootc-disk'], ['promote', 'box1-gitops-promote'], ['channel', 'box1-bootc-channel'], ['smoke', 'box1-vm-smoke']]);
    const taskArgs = Object.fromEntries(release.spec.pipelineSpec.tasks.map(t => [t.name, Object.fromEntries(t.params.map(p => [p.name, p.value]))]));
    assert.equal(taskArgs.promote['workload-profile'], 'virtual-machine');
    assert.equal(taskArgs.promote['disk-digest'], '$(tasks.disk.results.disk-digest)');
    assert.equal(taskArgs.promote.environment, 'development');
    assert.equal(taskArgs.smoke['application-namespace'], name + '-dev');
    for (const gated of ['channel', 'smoke']) assert.equal(release.spec.pipelineSpec.tasks.find(t => t.name === gated).when?.[0]?.input, '$(tasks.promote.results.promoted)', `${gated} must run only after a merged promotion`);
    assert.deepEqual(Object.fromEntries(release.spec.taskRunSpecs.map(s => [s.pipelineTaskName, s.serviceAccountName])), { security: 'ci-build', promote: 'ci-gitops', smoke: 'ci-observe' });
    const entity = YAML.parse(fs.readFileSync(path.join(app, 'catalog-info.yaml'), 'utf8'));
    assert.equal(entity.metadata.name, name);
    assert.equal(entity.spec.type, 'vm');
    assert.equal(entity.metadata.annotations['github.com/project-slug'], `box1-org/${name}`);
    assert.equal(entity.metadata.annotations['backstage.io/kubernetes-id'], name);
    // Step inputs against the installed action schemas, when provided.
    const context = { parameters, steps: { publish: { output: { commitHash: 'b'.repeat(40) } } } };
    for (const step of vmTemplate.spec.steps) {
      const action = actions.find(a => a.id === step.action);
      if (actionsFile) assert(action, `Installed action missing: ${step.action}`);
      if (action?.schema?.input) {
        const input = JSON.parse(env.renderString(JSON.stringify(step.input), context));
        const check = ajv.compile(action.schema.input);
        assert(check(input), `${step.id}: ${JSON.stringify(check.errors)}`);
      }
    }
    console.log(`PASS rhel-image-vm ${name}: render, plugin bundle check, Kustomize, Containerfile, pipeline contract, catalog${actionsFile ? ', installed actions' : ''}`);
  }
  const base = { name: 'vm-golden-check', description: 'A RHEL 10 image mode virtual machine', owner: 'user:default/mike', visibility: 'private', adminSshPublicKey: key };
  for (const adminSshPublicKey of ['', 'not-a-key', key + '\nssh-ed25519 AAAA second', '-----BEGIN OPENSSH PRIVATE KEY-----']) assert(!checkVmForm({ ...base, adminSshPublicKey }), 'Accepted invalid SSH public key');
  for (const extraPackages of ['vim; rm -rf /', '$(id)', 'Vim', 'a  b', ' leading']) assert(!checkVmForm({ ...base, extraPackages }), `Accepted unsafe package list: ${extraPackages}`);
  for (const name of ['box1-vm', 'quarkus-reference', 'Upper', 'a'.repeat(36)]) assert(!checkVmForm({ ...base, name }), `Accepted unsafe VM name: ${name}`);
  for (const rootDiskSize of ['5Gi', '1Ti']) assert(!checkVmForm({ ...base, rootDiskSize }), 'Accepted an unsupported root disk size');
  console.log('PASS rhel-image-vm rejected unsafe keys, packages, names and sizes');
}
