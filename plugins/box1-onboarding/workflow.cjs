'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { setTimeout: pause } = require('node:timers/promises');
const YAML = require('yaml');
const ORG = 'box1-org';
const REPO = '/repos/box1-org/box1-workloads-dev';
const ROOT = '/api/v1/namespaces/rhdh';
const CI = '/api/v1/namespaces/box1-ci';
const APPS = '/apis/argoproj.io/v1alpha1/namespaces/openshift-gitops/applications';
const WORKLOADS_APP = 'box1-workloads-dev';
const WORKLOADS_REPO = 'https://github.com/box1-org/box1-workloads-dev';
const LEASES = '/apis/coordination.k8s.io/v1/namespaces/rhdh/leases';
const DELIVERY_PHASES = ['provision','platform','buildPhase','promote','verify'];
// Outputs of box1:development:resolve-source.
const RESOLVE_OUTPUTS = ['sourceRevision','sourceUrl','imageDigest','diskDigest'];
const NAME = /^(?!quarkus-reference$)(?!orders-service$)(?!rhdh$)(?!default$)(?!box1-)(?!openshift-)(?!kube-)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
function check(ok, message) { if (!ok) throw new Error(message); }
const ZERO='sha256:'+'0'.repeat(64);
// ---- Onboarding profiles: the dispatch table -------------------------------------
// Every profile-specific behaviour lives in its entry here. Workflow phases call these
// handlers and never test the profile name, so adding a profile is one entry plus its
// handlers (plugins/box1-onboarding/README.md, "Adding an onboarding profile").
//
// 'service' is the original Quarkus path and must stay byte-for-byte compatible with
// records and markers written by earlier releases: it adds no `profile` key.
//
// Entry contract. `w` is the Workflow: w.name, w.ns, w.key, w.profile, w.data (the state
// record), w.kube, w.wait(label,seconds,observe), w.content(repo,file), w.save(phase,extra),
// w.github(path,method,body), w.checkpoint(), w.ctx.output(key,value). A handler set to null
// declares the phase absent.
//
//   templateVersion   string. Stored in the record and the repository marker.
//   commitMessage     string, or null with sourceRepository:false. Skeleton commit message.
//   sourceRepository  boolean, default true. false: the profile has no source
//                     repository and box1:repository:ensure is refused.
//   initialRecord(w)  async -> object | null. Only for sourceRepository:false. When no
//                     record exists, box1:development:provision creates the REQUESTED
//                     record from these fields (it must include sourceRevision).
//   recordFields(w)   -> object. Keys added to the REQUESTED record after templateVersion.
//   markerFields(w)   -> object. Keys appended to .box1/onboarding.json.
//   validateBundle(files,name) -> files | null. Checks the rendered GitOps bundle and
//                     returns it. null: no GitOps bundle, so the onboarding PR, the
//                     Application sync and the promotion are skipped.
//   buildBarrier(w)   async | null. Build prerequisites, waited for by box1:development:platform.
//   platformChecks(w) -> {condition: async () => true | 'pending reason'} | null.
//                     Readiness set observed alongside the build; null: none.
//   buildSpec(w,secretName) -> PipelineRun spec | null. The first build. null: no
//                     PipelineRun and no build credential.
//   buildResults(w,run) -> object. Fields stored with IMAGE_BUILT. Must include imageDigest:
//                     platform, buildPhase and resume treat imageDigest as "build done".
//                     Throws to reject the results. `run` is the succeeded PipelineRun, or
//                     null when buildSpec is null (the handler may then be async, for
//                     example to adopt already approved digests). Both buildSpec and
//                     buildResults null: the profile has no build at all.
//   promotionUpdates(w,files) async -> files | null. Contents of the first-release
//                     promotion PR in box1-workloads-dev. null: no promotion PR or sync.
//   verify(w)         async | null. Waits for the delivered state, saves DEPLOYMENT_READY
//                     (or the profile's equivalent) and sets the task outputs.
//   catalogComplete(data) -> boolean. Precondition of box1:catalog:ensure, evaluated
//                     against the stored record of the profile it names.
//
// Optional keys (1.4.0, box1-docs#137). Absent means the 1.3.0 behaviour, so the
// service and virtual-machine entries do not declare them:
//   gitopsApplication(w) -> string. The Argo Application the onboarding PR creates,
//                     which platform syncs and awaits and promote syncs. Default: w.name.
//   buildCredential(w) -> {repositories, permissions}. The GitHub App installation token
//                     request for the first build's credential Secret. Default: the source
//                     repository with contents:read.
//
// Optional keys (1.5.0, box1-docs#138), absent from the earlier entries:
//   resolveSource(w, source) async -> {sourceRevision, ...}. Backs
//                     box1:development:resolve-source, which a template without
//                     box1:repository:ensure runs first to learn the sourceRevision it
//                     renders and passes to every later step. Absent: the action is refused.
//   catalogEntity(w)  -> {ref, target, owns(entity)}. The entity box1:catalog:* registers,
//                     the Location URL that defines it, and the ownership test for an
//                     existing entity. Default: component:default/<name> from
//                     github.com/box1-org/<name>, owned when github.com/project-slug matches.
//                     Like catalogComplete, it is taken from the profile the record names.
const PROFILES={
  service:{
    templateVersion:'1.1.0',commitMessage:'Create Quarkus service from the Box1 golden path',
    recordFields:()=>({}),markerFields:()=>({}),
    validateBundle,buildBarrier:serviceBuildBarrier,platformChecks:servicePlatformChecks,
    buildSpec:serviceBuildSpec,buildResults:serviceBuildResults,
    promotionUpdates:servicePromotionUpdates,verify:serviceVerify,catalogComplete:deploymentComplete,
  },
  'virtual-machine':{
    templateVersion:'1.0.0',commitMessage:'Create RHEL image mode VM from the Box1 golden path',
    recordFields:w=>({profile:w.profile}),markerFields:w=>({profile:w.profile}),
    validateBundle:validateVmBundle,buildBarrier:vmBuildBarrier,platformChecks:vmPlatformChecks,
    buildSpec:vmBuildSpec,buildResults:vmBuildResults,
    promotionUpdates:vmPromotionUpdates,verify:vmVerify,catalogComplete:deploymentComplete,
  },
  // Code-only multi-module Maven repository (box1-docs#137): no namespace, workload or
  // workload Application. Publishes box1-ci/<name>-bundle and proposes it to a consumer.
  artifact:{
    templateVersion:'1.0.0',commitMessage:'Create Quarkus multi-module repository from the Box1 golden path',
    recordFields:w=>({profile:w.profile}),markerFields:w=>({profile:w.profile}),
    validateBundle:validateArtifactBundle,buildBarrier:artifactBuildBarrier,platformChecks:artifactPlatformChecks,
    buildSpec:artifactBuildSpec,buildResults:artifactBuildResults,
    promotionUpdates:null,verify:artifactVerify,catalogComplete:artifactComplete,
    gitopsApplication:artifactCiApplication,buildCredential:artifactBuildCredential,
  },
  // One more VM of an approved bootc OS image (box1-docs#138): no source repository and
  // no build. Adopts the source's approved digests, then pins its own.
  'vm-instance':{
    templateVersion:'1.0.0',commitMessage:null,sourceRepository:false,initialRecord:vmInstanceInitialRecord,
    recordFields:w=>({profile:w.profile}),markerFields:w=>({profile:w.profile}),
    validateBundle:validateVmInstanceBundle,buildBarrier:null,platformChecks:vmInstancePlatformChecks,
    buildSpec:null,buildResults:vmInstanceBuildResults,
    promotionUpdates:vmInstancePromotionUpdates,verify:vmInstanceVerify,catalogComplete:vmInstanceComplete,
    resolveSource:vmInstanceResolveSource,catalogEntity:vmInstanceCatalogEntity,
    // Profile-internal: the booted-digest mechanism used by verify (see vmInstanceBootedDigest).
    bootedDigest:vmInstanceBootedDigest,
  },
};
function validateProfile(profile) { check(Object.hasOwn(PROFILES,profile),'Unsupported onboarding profile'); return profile; }
// The `profile` input of the onboarding actions. Its enum is the dispatch table.
function profileInputSchema() { return {type:'string',enum:Object.keys(PROFILES),default:'service',description:'Onboarding profile; must match the profile recorded when the repository was created'}; }
function validateName(name) { check(typeof name === 'string' && name.length >= 3 && name.length <= 35 && NAME.test(name), 'Only new, non-reserved development service names are allowed'); return name; }
function blobSha(content) { return crypto.createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex'); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function normalizeRepo(value) { return (value||'').replace(/\/$/,'').replace(/\.git$/,''); }
function workloadSource(app) { return app?.spec?.source||(app?.spec?.sources||[]).find(s=>normalizeRepo(s.repoURL)===WORKLOADS_REPO); }
function syncedAt(app, revision) {
  const source=workloadSource(app),status=app?.status,observed=status?.sync?.revision||status?.sync?.revisions;
  if(normalizeRepo(source?.repoURL)!==WORKLOADS_REPO||status?.sync?.status!=='Synced'||status?.health?.status!=='Healthy')return false;
  return Array.isArray(observed)?observed.includes(revision):observed===revision;
}
function syncDetails(app, name, revision) {
  const status=app?.status||{},operation=status.operationState||{},sync=status.sync||{},health=status.health||{};
  const messages=[...(status.conditions||[]).map(c=>c.message).filter(Boolean),operation.message].filter(Boolean);
  return `Argo ${name} sync did not complete: expected revision ${revision}, observed ${sync.revision||JSON.stringify(sync.revisions)||'none'}, sync ${sync.status||'unknown'}, health ${health.status||'unknown'}, operation ${operation.phase||'none'}${messages.length?`, ${messages.join('; ')}`:''}`;
}
async function filesAt(root, prefix = '') {
  const result = {};
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    check(!entry.isSymbolicLink() && entry.name !== '.git', 'Symlinks and .git are forbidden in generated files');
    const key = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(result, await filesAt(path.join(root, entry.name), key + '/'));
    else { const file = path.join(root, entry.name); result[key] = { content: await fs.readFile(file, 'utf8'), mode: (await fs.stat(file)).mode & 0o111 ? '100755' : '100644' }; }
  }
  return result;
}
function validateBundle(files, name) {
  validateName(name);
  const ns = name + '-dev';
  const base = ['namespace','serviceaccount','deployment','service','route','onboarding','kustomization'];
  const postgresFile = files[`workloads/${name}/postgres.yaml`];
  const hasPostgres = Boolean(postgresFile?.content.trim());
  const expected = [`applications/${name}.yaml`, ...base.map(f => `workloads/${name}/${f}.yaml`), ...(postgresFile ? [`workloads/${name}/postgres.yaml`] : [])];
  check(same(Object.keys(files).sort(), expected.sort()), 'Onboarding must add one Application and the scoped development workload files');
  const objects = Object.entries(files).filter(([p]) => !p.endsWith('kustomization.yaml')).flatMap(([,f]) => YAML.parseAllDocuments(f.content).map(d => d.toJSON()));
  for (const obj of objects) {
    const m = obj.metadata;
    check(m && !m.generateName && !m.ownerReferences && !m.finalizers, 'Invalid generated metadata');
    if (obj.kind === 'Application') {
      check(m.name === name && m.namespace === 'openshift-gitops' && obj.spec.project === 'default' && obj.spec.destination.namespace === ns && obj.spec.destination.server === 'https://kubernetes.default.svc' && obj.spec.source.repoURL === 'https://github.com/box1-org/box1-workloads-dev.git' && obj.spec.source.path === `workloads/${name}` && obj.spec.source.targetRevision === 'main', 'Application must target its own development namespace');
    } else if (obj.kind === 'Namespace') check(m.name === ns, 'Only the development Namespace may be created');
    else if (obj.kind === 'Repository') check(m.name === name && m.namespace === 'box1-ci' && obj.spec.url === `https://github.com/${ORG}/${name}` && same(obj.spec.settings.github_app_token_scope_repos, [ORG + '/box1-workloads-dev']), 'Invalid PAC Repository');
    else if (obj.kind === 'Role') {
      check(m.name === name + '-release-observer' && [ns,'openshift-gitops'].includes(m.namespace), 'Invalid observer Role');
      for (const rule of obj.rules) {
        check(rule.verbs.every(v => ['get','list'].includes(v)), 'Observer roles must be read-only');
        if (m.namespace === 'openshift-gitops') check(same(rule.apiGroups,['argoproj.io']) && same(rule.resources,['applications']) && same(rule.resourceNames,[name]), 'Argo observation must be scoped to this Application');
        else check((same(rule.apiGroups,['apps']) && same(rule.resources,['deployments']) && same(rule.resourceNames,[name])) || (same(rule.apiGroups,['']) && same(rule.resources,['pods'])), 'Invalid workload observation rule');
      }
    } else if (obj.kind === 'RoleBinding') {
      const puller = m.name === name + '-image-puller';
      check(puller ? m.namespace === 'box1-ci' && obj.roleRef.name === 'system:image-puller' && obj.roleRef.kind === 'ClusterRole' : m.name === name + '-release-observer' && [ns,'openshift-gitops'].includes(m.namespace) && obj.roleRef.name === name + '-release-observer' && obj.roleRef.kind === 'Role', 'Invalid binding');
      check(same(obj.subjects, [{ kind:'ServiceAccount', name:puller ? name : 'ci-observe', namespace:puller ? ns : 'box1-ci' }]), 'Invalid binding subject');
    } else if (obj.kind === 'Deployment' && m.name === name + '-postgres') {
      check(m.namespace === ns && obj.spec.replicas === 1 && obj.spec.selector.matchLabels['app.kubernetes.io/name'] === name + '-postgres', 'Invalid PostgreSQL Deployment');
    } else if (obj.kind === 'Service' && m.name === name + '-postgres') {
      check(m.namespace === ns && obj.spec.selector['app.kubernetes.io/name'] === name + '-postgres', 'Invalid PostgreSQL Service');
    } else if (obj.kind === 'PersistentVolumeClaim' && m.name === name + '-postgres-data') {
      check(m.namespace === ns && obj.spec.resources.requests.storage === '5Gi' && same(obj.spec.accessModes,['ReadWriteOnce']), 'Invalid PostgreSQL PVC');
    } else if (obj.kind === 'Secret' && m.name === name + '-postgres') {
      check(m.namespace === ns && obj.type === 'Opaque' && obj.stringData?.POSTGRESQL_PASSWORD === 'replace-before-sync', 'Invalid PostgreSQL Secret placeholder');
    } else if (obj.kind === 'NetworkPolicy' && m.name === name + '-postgres') {
      const ingress = obj.spec?.ingress ?? [];
      check(hasPostgres && m.namespace === ns && obj.spec.podSelector?.matchLabels?.['app.kubernetes.io/name'] === name + '-postgres' && same(obj.spec.policyTypes,['Ingress']) && ingress.length === 1 && ingress[0].from?.length === 1 && ingress[0].from[0].podSelector?.matchLabels?.['app.kubernetes.io/name'] === name && !ingress[0].from[0].namespaceSelector && !ingress[0].from[0].ipBlock, 'Invalid PostgreSQL NetworkPolicy');
    } else if (obj.kind === 'KafkaTopic') {
      throw new Error('KafkaTopic resources are not allowed in service onboarding');
    } else {
      check(['ServiceAccount','Deployment','Service','Route'].includes(obj.kind) && m.name === name && m.namespace === ns, 'Unexpected generated resource');
      if (obj.kind === 'Deployment') check(obj.spec.replicas === 0 && obj.spec.template.spec.serviceAccountName === name && obj.spec.template.spec.containers.length === 1 && obj.spec.template.spec.containers[0].image === name, 'Unbuilt Deployment must remain inactive');
      if (obj.kind === 'Route') check(obj.spec.host === ns + '.apps.ocp.box1.org' && obj.spec.to.name === name && obj.spec.tls.termination === 'edge', 'Invalid development Route');
    }
  }
  const k = YAML.parse(files[`workloads/${name}/kustomization.yaml`].content);
  const expectedResources = ['namespace.yaml','serviceaccount.yaml','deployment.yaml','service.yaml','route.yaml','onboarding.yaml', ...(hasPostgres ? ['postgres.yaml'] : [])];
  check(same(k.resources, expectedResources) && k.configMapGenerator?.length === 1 && k.configMapGenerator[0].namespace === ns && k.configMapGenerator[0].name === name + '-config' && !k.bases && !k.components && !k.patches && !k.generators && !k.transformers && k.images?.length === 1 && k.images[0].newName === `image-registry.openshift-image-registry.svc:5000/box1-ci/${name}` && k.images[0].digest === 'sha256:' + '0'.repeat(64), 'Invalid initial Kustomization');
  return files;
}
const SSH_KEY=/^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa) [A-Za-z0-9+/=]+( [A-Za-z0-9@._-]{1,64})?$/;
// virtual-machine profile: mirrors box1-gitops-validate's virtual-machine rules for an
// unbuilt bundle (Halted VM, zero digests, DataVolume generated but not yet listed).
function validateVmBundle(files, name) {
  validateName(name);
  const ns = name + '-dev';
  const base = ['namespace','updater','admin-access','virtualmachine','datavolume','onboarding','kustomization'];
  check(same(Object.keys(files).sort(), [`applications/${name}.yaml`, ...base.map(f => `workloads/${name}/${f}.yaml`)].sort()), 'VM onboarding must add one Application and the scoped development VM files');
  const objects = Object.entries(files).filter(([p]) => !p.endsWith('kustomization.yaml')).flatMap(([p,f]) => YAML.parseAllDocuments(f.content).map(d => ({ file:p, obj:d.toJSON() }))).filter(({obj}) => obj);
  const seen = {};
  for (const { file, obj } of objects) {
    const m = obj.metadata;
    check(m && !m.generateName && !m.ownerReferences && !m.finalizers, 'Invalid generated metadata');
    seen[obj.kind] = (seen[obj.kind] || 0) + 1;
    if (obj.kind === 'Application') {
      check(m.name === name && m.namespace === 'openshift-gitops' && obj.spec.project === 'default' && obj.spec.destination.namespace === ns && obj.spec.destination.server === 'https://kubernetes.default.svc' && obj.spec.source.repoURL === 'https://github.com/box1-org/box1-workloads-dev.git' && obj.spec.source.path === `workloads/${name}` && obj.spec.source.targetRevision === 'main', 'Application must target its own development namespace');
    } else if (obj.kind === 'Namespace') {
      check(m.name === ns && m.labels?.['box1.org/workload-profile'] === 'virtual-machine' && m.labels?.['argocd.argoproj.io/managed-by'] === 'openshift-gitops', 'VM Namespace must be the managed development namespace with the virtual-machine profile');
    } else if (obj.kind === 'Repository') {
      check(m.name === name && m.namespace === 'box1-ci' && obj.spec.url === `https://github.com/${ORG}/${name}` && same(obj.spec.settings.github_app_token_scope_repos, [ORG + '/box1-workloads-dev']), 'Invalid PAC Repository');
    } else if (obj.kind === 'Role') {
      check(m.name === name + '-release-observer' && [ns,'openshift-gitops'].includes(m.namespace), 'Invalid observer Role');
      for (const rule of obj.rules) {
        check(same(rule.verbs,['get']), 'Observer roles must be get-only');
        if (m.namespace === 'openshift-gitops') check(same(rule.apiGroups,['argoproj.io']) && same(rule.resources,['applications']) && same(rule.resourceNames,[name]), 'Argo observation must be scoped to this Application');
        else check((same(rule.apiGroups,['kubevirt.io']) && same(rule.resources,['virtualmachines','virtualmachineinstances']) && same(rule.resourceNames,[name])) || (same(rule.apiGroups,['cdi.kubevirt.io']) && same(rule.resources,['datavolumes']) && same(rule.resourceNames,[name + '-root'])), 'Invalid VM observation rule');
      }
    } else if (obj.kind === 'RoleBinding') {
      if (m.name === name + '-image-puller') {
        check(m.namespace === 'box1-ci' && obj.roleRef.name === 'system:image-puller' && obj.roleRef.kind === 'ClusterRole' && same(obj.subjects, [{ apiGroup:'rbac.authorization.k8s.io', kind:'Group', name:'system:serviceaccounts:' + ns }]), 'Invalid VM registry pull binding');
      } else {
        check(m.name === name + '-release-observer' && [ns,'openshift-gitops'].includes(m.namespace) && obj.roleRef.name === name + '-release-observer' && obj.roleRef.kind === 'Role' && same(obj.subjects, [{ kind:'ServiceAccount', name:'ci-observe', namespace:'box1-ci' }]), 'Invalid binding');
      }
    } else if (obj.kind === 'ServiceAccount') {
      check(m.name === name + '-updater' && m.namespace === ns && obj.automountServiceAccountToken === false, 'Only the non-mounted updater ServiceAccount may be created');
    } else if (obj.kind === 'Secret' && obj.type === 'kubernetes.io/service-account-token') {
      check(m.name === name + '-updater-token' && m.namespace === ns && m.annotations?.['kubernetes.io/service-account.name'] === name + '-updater' && !obj.data && !obj.stringData, 'Updater token Secret must carry no data in Git');
    } else if (obj.kind === 'Secret') {
      const keys = Object.values(obj.stringData || {});
      check(m.name === name + '-admin-ssh' && m.namespace === ns && obj.type === 'Opaque' && !obj.data && keys.length >= 1 && keys.every(k => typeof k === 'string' && SSH_KEY.test(k)), 'Only SSH public keys may be stored, in the admin-ssh Secret');
    } else if (obj.kind === 'VirtualMachine') {
      const a = m.annotations || {}, spec = obj.spec, t = spec.template.spec;
      check(m.name === name && m.namespace === ns, 'VirtualMachine must be named after the workload');
      check(spec.runStrategy === 'Halted' && !spec.dataVolumeTemplates && a['box1.org/os-image-digest'] === ZERO && /^[a-f0-9]{40}$/.test(a['box1.org/source-revision']||'') && a['box1.org/build-pipelinerun'] === 'awaiting-first-release', 'Unbuilt VirtualMachine must be Halted with zero digests and no dataVolumeTemplates');
      const volumes = Object.fromEntries((t.volumes||[]).map(v => [v.name, v]));
      check(same(Object.keys(volumes).sort(), ['regtoken','root','serviceca']) && volumes.root.dataVolume?.name === name + '-root' && volumes.serviceca.configMap?.name === 'openshift-service-ca.crt' && volumes.regtoken.secret?.secretName === name + '-updater-token', 'VirtualMachine volumes must be the root DataVolume and the bootc update disks');
      const disks = Object.fromEntries((t.domain.devices.disks||[]).map(d => [d.name, d]));
      check(disks.serviceca?.serial === 'serviceca' && disks.regtoken?.serial === 'regtoken' && disks.root, 'VirtualMachine must expose the bootc update disks by serial');
      check(same(t.accessCredentials, [{ sshPublicKey:{ source:{ secret:{ secretName:name + '-admin-ssh' } }, propagationMethod:{ qemuGuestAgent:{ users:['cloud-user'] } } } }]), 'Admin SSH keys must come from the admin-ssh Secret through the guest agent');
    } else if (obj.kind === 'DataVolume') {
      check(file === `workloads/${name}/datavolume.yaml` && m.name === name + '-root' && m.namespace === ns && obj.spec.source?.registry?.url === `docker://image-registry.openshift-image-registry.svc:5000/box1-ci/${name}-disk@${ZERO}` && obj.spec.source.registry.pullMethod === 'node' && obj.spec.storage?.storageClassName === 'lvms-vg1', 'Unbuilt root DataVolume must reference the zero disk digest');
    } else {
      throw new Error('Unexpected generated resource for a VM workload: ' + obj.kind);
    }
  }
  for (const kind of ['Application','Namespace','Repository','ServiceAccount','VirtualMachine','DataVolume']) check(seen[kind] === 1, 'VM onboarding needs exactly one ' + kind);
  check(seen.Secret === 2, 'VM onboarding needs the updater token and admin-ssh Secrets');
  const k = YAML.parse(files[`workloads/${name}/kustomization.yaml`].content);
  check(same(k.resources, ['namespace.yaml','updater.yaml','admin-access.yaml','virtualmachine.yaml','onboarding.yaml']) && !k.bases && !k.components && !k.patches && !k.generators && !k.transformers && !k.images && !k.configMapGenerator && !k.secretGenerator, 'Invalid initial VM Kustomization: the DataVolume is listed only by the first promotion');
  return files;
}
// ---- profile handlers --------------------------------------------------------------
// Each handler receives the Workflow `w`; see the PROFILES contract above.
function requireImageDigest(w) { check(w.data?.imageDigest,'Cannot verify deployment without an image digest'); }
function imageDigestResult(run) {
  const digest=(run.status.results||[]).find(r=>r.name==='image-digest')?.value;
  check(/^sha256:[a-f0-9]{64}$/.test(digest),'Initial CI did not return an immutable image digest');
  return digest;
}
// A verified development deployment with both PRs merged.
function deploymentComplete(data) { return Boolean(data?.deploymentImage && data.onboardingPR?.merged && data.promotionPR?.merged); }
// service profile ---------------------------------------------------------------------
async function serviceBuildBarrier(w) {
  await w.wait('initial build prerequisites',300,async()=>{
    const [namespace,serviceAccount,push]=await Promise.all([
      w.kube.get('/api/v1/namespaces/'+w.ns),
      w.kube.get('/api/v1/namespaces/box1-ci/serviceaccounts/ci-build'),
      w.kube.get('/apis/rbac.authorization.k8s.io/v1/namespaces/box1-ci/rolebindings/ci-build-image-builder'),
    ]);
    if(namespace?.status?.phase!=='Active')return w.ns+' Namespace Active';
    if(!serviceAccount)return 'box1-ci/ci-build ServiceAccount';
    if(push?.roleRef?.name!=='system:image-builder'||!push.subjects?.some(s=>s.name==='ci-build'&&s.namespace==='box1-ci'))return 'CI registry push permission';
    return true;
  });
}
function servicePlatformChecks(w) {
  return {
    namespace:async()=>{const v=await w.kube.get('/api/v1/namespaces/'+w.ns);return v?.status?.phase==='Active'||w.ns+' Namespace Active';},
    serviceaccounts:async()=>{const values=await Promise.all([[w.ns,w.name],['box1-ci','ci-build'],['box1-ci','ci-gitops'],['box1-ci','ci-observe']].map(async([ns,name])=>[ns,name,await w.kube.get(`/api/v1/namespaces/${ns}/serviceaccounts/${name}`)]));const missing=values.find(([, ,v])=>!v);return missing?missing[0]+'/'+missing[1]+' ServiceAccount':true;},
    registry_pull:async()=>{const v=await w.kube.get(`/apis/rbac.authorization.k8s.io/v1/namespaces/box1-ci/rolebindings/${w.name}-image-puller`);return v?.roleRef?.name==='system:image-puller'&&v.subjects?.some(s=>s.name===w.name&&s.namespace===w.ns)||'service registry pull permission';},
    registry_push:async()=>{const v=await w.kube.get('/apis/rbac.authorization.k8s.io/v1/namespaces/box1-ci/rolebindings/ci-build-image-builder');return v?.roleRef?.name==='system:image-builder'&&v.subjects?.some(s=>s.name==='ci-build'&&s.namespace==='box1-ci')||'CI registry push permission';},
    observer_rbac:async()=>{const values=await Promise.all([w.ns,'openshift-gitops'].map(async ns=>[ns,await w.kube.get(`/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/roles/${w.name}-release-observer`),await w.kube.get(`/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings/${w.name}-release-observer`)]));const missing=values.find(([ns,role,binding])=>!role||binding?.roleRef?.name!==role.metadata.name||!binding.subjects?.some(s=>s.name==='ci-observe'&&s.namespace==='box1-ci'));return missing?missing[0]+' release observer permissions':true;},
    pac_repository:async()=>{const v=await w.kube.get('/apis/pipelinesascode.tekton.dev/v1alpha1/namespaces/box1-ci/repositories/'+w.name);return v?.spec?.url===`https://github.com/${ORG}/${w.name}`||'PAC Repository registration';},
    argo_application:async()=>{const v=await w.kube.get(APPS+'/'+w.name);return v?.spec?.destination?.namespace===w.ns&&v.status?.sync?.status==='Synced'||'Argo CD Application Synced in '+w.ns;},
    deployment:async()=>await w.kube.get(`/apis/apps/v1/namespaces/${w.ns}/deployments/${w.name}`)?true:'initial Deployment',
  };
}
function serviceBuildSpec(w, secretName) {
  return {taskRunTemplate:{serviceAccountName:'ci-build'},timeouts:{pipeline:'45m'},pipelineSpec:{tasks:[{name:'build',taskRef:{resolver:'cluster',params:[{name:'kind',value:'task'},{name:'name',value:'box1-quarkus-maven'},{name:'namespace',value:'box1-ci'}]},params:[{name:'revision',value:w.data.sourceRevision},{name:'source-repo',value:ORG+'/'+w.name},{name:'git-auth-secret',value:secretName},{name:'push-image',value:'true'},{name:'image-name',value:w.name}]}],results:[{name:'image-digest',value:'$(tasks.build.results.image-digest)'}]}};
}
function serviceBuildResults(w, run) { return {imageDigest:imageDigestResult(run)}; }
async function servicePromotionUpdates(w, files) {
  const paths=[`workloads/${w.name}/kustomization.yaml`,`workloads/${w.name}/deployment.yaml`];const updates={};
  for(const file of paths) updates[file]={...files[file]};
  check(updates[paths[0]].content.includes('digest: sha256:'+'0'.repeat(64)),'First release requires the unbuilt development image');
  updates[paths[0]].content=updates[paths[0]].content.replace('digest: sha256:'+'0'.repeat(64),'digest: '+w.data.imageDigest);
  updates[paths[1]].content=updates[paths[1]].content.replace(/^  replicas: 0$/m,'  replicas: 1').replace(/^    box1\.org\/build-pipelinerun: .+$/m,'    box1.org/build-pipelinerun: box1-ci/'+w.data.pipelineName);
  check(updates[paths[1]].content.includes('box1.org/source-revision: '+w.data.sourceRevision),'Initial source revision drifted');
  for(const file of paths) {
    const live=await w.content('box1-workloads-dev',file);
    check(live===files[file].content||live===updates[file].content,'First-release GitOps content drifted: '+file);
  }
  return updates;
}
async function serviceVerify(w) {
  requireImageDigest(w);
  const image=`image-registry.openshift-image-registry.svc:5000/box1-ci/${w.name}@${w.data.imageDigest}`;
  await w.wait('first deployment and public endpoint',900,async()=>{
    const app=await w.kube.get(APPS+'/'+w.name);const dep=await w.kube.get(`/apis/apps/v1/namespaces/${w.ns}/deployments/${w.name}`);
    const sync=w.data.promotionSync,operation=app?.status?.operationState;
    if(sync?.requestedAt&&['Error','Failed'].includes(operation?.phase)&&Date.parse(operation.startedAt)>=Date.parse(sync.requestedAt)-5000)throw new Error(syncDetails(app,w.name,sync.revision));
    if(app?.status?.sync?.status!=='Synced'||app?.status?.health?.status!=='Healthy')return 'Argo CD Synced and Healthy';
    if(dep?.spec?.template?.spec?.containers[0].image!==image||dep.status?.observedGeneration!==dep.metadata.generation||!dep.status?.availableReplicas)return 'digest-pinned Deployment Available';
    try{
      const response=await fetch('https://'+w.ns+'.apps.ocp.box1.org/api/info',{signal:AbortSignal.timeout(10000)});
      if(!response.ok)return 'public Route HTTP '+response.status;
      const info=await response.json();check(info.name===w.name&&info.gitRef===w.data.sourceRevision,'Deployed source identity mismatch');
      const health=await fetch('https://'+w.ns+'.apps.ocp.box1.org/q/health/ready',{signal:AbortSignal.timeout(10000)});
      if(!health.ok||(await health.json()).status!=='UP')return 'public readiness UP';
      return true;
    }catch(e){if(e.message==='Deployed source identity mismatch')throw e;return 'public Route reachable';}
  });
  await w.save('DEPLOYMENT_READY',{deploymentImage:image,deploymentReadyAt:new Date().toISOString()});
  const links={sourceUrl:w.data.sourceUrl,catalogUrl:`https://developer-hub.apps.ocp.box1.org/catalog/default/component/${w.name}`,pipelineUrl:`https://console-openshift-console.apps.ocp.box1.org/k8s/ns/box1-ci/tekton.dev~v1~PipelineRun/${w.data.pipelineName}`,deploymentUrl:'https://'+w.ns+'.apps.ocp.box1.org',argoUrl:`https://openshift-gitops-server-openshift-gitops.apps.ocp.box1.org/applications/openshift-gitops/${w.name}`,onboardingUrl:w.data.onboardingPR.url,statusRecord:'rhdh/'+w.key,imageDigest:w.data.imageDigest};
  for(const [key,value] of Object.entries(links))w.ctx.output(key,value);
}
// virtual-machine profile ---------------------------------------------------------------
async function vmBuildBarrier(w) {
  await w.wait('initial VM build prerequisites',300,async()=>{
    const [namespace,serviceAccount,push,privileged]=await Promise.all([
      w.kube.get('/api/v1/namespaces/'+w.ns),
      w.kube.get('/api/v1/namespaces/box1-ci/serviceaccounts/ci-bootc-release'),
      w.kube.get('/apis/rbac.authorization.k8s.io/v1/namespaces/box1-ci/rolebindings/ci-bootc-release-image-builder'),
      w.kube.get('/apis/rbac.authorization.k8s.io/v1/namespaces/box1-ci/rolebindings/ci-bootc-privileged-scc'),
    ]);
    if(namespace?.status?.phase!=='Active')return w.ns+' Namespace Active';
    if(!serviceAccount)return 'box1-ci/ci-bootc-release ServiceAccount';
    if(push?.roleRef?.name!=='system:image-builder'||!push.subjects?.some(s=>s.name==='ci-bootc-release'&&s.namespace==='box1-ci'))return 'bootc registry push permission';
    if(privileged?.roleRef?.name!=='system:openshift:scc:privileged'||!privileged.subjects?.some(s=>s.name==='ci-bootc-release'&&s.namespace==='box1-ci'))return 'bootc privileged build permission';
    return true;
  });
}
function vmPlatformChecks(w) {
  return {
    namespace:async()=>{const v=await w.kube.get('/api/v1/namespaces/'+w.ns);return v?.status?.phase==='Active'||w.ns+' Namespace Active';},
    serviceaccounts:async()=>{const values=await Promise.all([[w.ns,w.name+'-updater'],['box1-ci','ci-bootc-release'],['box1-ci','ci-gitops'],['box1-ci','ci-observe']].map(async([ns,name])=>[ns,name,await w.kube.get(`/api/v1/namespaces/${ns}/serviceaccounts/${name}`)]));const missing=values.find(([, ,v])=>!v);return missing?missing[0]+'/'+missing[1]+' ServiceAccount':true;},
    registry_pull:async()=>{const v=await w.kube.get(`/apis/rbac.authorization.k8s.io/v1/namespaces/box1-ci/rolebindings/${w.name}-image-puller`);return v?.roleRef?.name==='system:image-puller'&&v.subjects?.some(s=>s.kind==='Group'&&s.name==='system:serviceaccounts:'+w.ns)||'VM namespace registry pull permission';},
    registry_push:async()=>{const v=await w.kube.get('/apis/rbac.authorization.k8s.io/v1/namespaces/box1-ci/rolebindings/ci-bootc-release-image-builder');return v?.roleRef?.name==='system:image-builder'&&v.subjects?.some(s=>s.name==='ci-bootc-release'&&s.namespace==='box1-ci')||'bootc registry push permission';},
    observer_rbac:async()=>{const values=await Promise.all([w.ns,'openshift-gitops'].map(async ns=>[ns,await w.kube.get(`/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/roles/${w.name}-release-observer`),await w.kube.get(`/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings/${w.name}-release-observer`)]));const missing=values.find(([ns,role,binding])=>!role||binding?.roleRef?.name!==role.metadata.name||!binding.subjects?.some(s=>s.name==='ci-observe'&&s.namespace==='box1-ci'));return missing?missing[0]+' release observer permissions':true;},
    pac_repository:async()=>{const v=await w.kube.get('/apis/pipelinesascode.tekton.dev/v1alpha1/namespaces/box1-ci/repositories/'+w.name);return v?.spec?.url===`https://github.com/${ORG}/${w.name}`||'PAC Repository registration';},
    argo_application:async()=>{const v=await w.kube.get(APPS+'/'+w.name);return v?.spec?.destination?.namespace===w.ns&&v.status?.sync?.status==='Synced'||'Argo CD Application Synced in '+w.ns;},
    virtual_machine:async()=>await w.kube.get(`/apis/kubevirt.io/v1/namespaces/${w.ns}/virtualmachines/${w.name}`)?true:'initial VirtualMachine',
  };
}
// First release: OS image, install disk, and the :development update channel. The
// VM boots exactly this image from its disk, so pointing the channel at it before
// the promotion merges cannot offer the guest anything unapproved.
function vmBuildSpec(w, secretName) {
  const task=(name,taskName,params,runAfter)=>({name,...(runAfter?{runAfter:[runAfter]}:{}),taskRef:{resolver:'cluster',params:[{name:'kind',value:'task'},{name:'name',value:taskName},{name:'namespace',value:'box1-ci'}]},params:Object.entries(params).map(([n,v])=>({name:n,value:v}))});
  const digest='$(tasks.build.results.image-digest)';
  return {taskRunTemplate:{serviceAccountName:'ci-bootc-release'},timeouts:{pipeline:'45m'},pipelineSpec:{tasks:[
    task('build','box1-bootc-build',{revision:w.data.sourceRevision,'source-repo':ORG+'/'+w.name,'git-auth-secret':secretName,'push-image':'true','image-name':w.name}),
    task('disk','box1-bootc-disk',{revision:w.data.sourceRevision,'image-name':w.name,'image-digest':digest,channel:'development'},'build'),
    task('channel','box1-bootc-channel',{'image-name':w.name,'image-digest':digest,channel:'development'},'disk'),
  ],results:[{name:'image-digest',value:digest},{name:'disk-digest',value:'$(tasks.disk.results.disk-digest)'}]}};
}
// Mirrors box1-gitops-promote's virtual-machine first promotion: record the OS image,
// pin and list the root DataVolume, and start the VM.
async function vmPromotionUpdates(w, files) {
  check(/^sha256:[a-f0-9]{64}$/.test(w.data.imageDigest||'')&&/^sha256:[a-f0-9]{64}$/.test(w.data.diskDigest||'')&&w.data.diskDigest!==ZERO,'First VM release requires the image and disk digests');
  const base=`workloads/${w.name}/`,v=base+'virtualmachine.yaml',dv=base+'datavolume.yaml',k=base+'kustomization.yaml';
  const updates={[v]:{...files[v]},[dv]:{...files[dv]},[k]:{...files[k]}};
  const replaceOnce=(content,pattern,value,message)=>{const matches=content.match(new RegExp(pattern.source,'gm'));check(matches?.length===1,message);return content.replace(new RegExp(pattern.source,'m'),value);};
  check(updates[v].content.includes('    box1.org/source-revision: '+w.data.sourceRevision),'Initial source revision drifted');
  updates[v].content=replaceOnce(updates[v].content,/^    box1\.org\/os-image-digest: sha256:0{64}$/,'    box1.org/os-image-digest: '+w.data.imageDigest,'First release requires the unbuilt VM OS digest');
  updates[v].content=replaceOnce(updates[v].content,/^    box1\.org\/build-pipelinerun: .+$/,'    box1.org/build-pipelinerun: box1-ci/'+w.data.pipelineName,'Build annotation missing');
  updates[v].content=replaceOnce(updates[v].content,/^  runStrategy: Halted$/,'  runStrategy: Always','Unbuilt VirtualMachine must be Halted');
  updates[dv].content=replaceOnce(updates[dv].content,new RegExp('^(      url: docker://image-registry\\.openshift-image-registry\\.svc:5000/box1-ci/'+w.name+'-disk@)sha256:0{64}$'),'$1'+w.data.diskDigest,'Unbuilt root DataVolume must reference the zero disk digest');
  check(!/^  - datavolume\.yaml$/m.test(updates[k].content),'Unbuilt VM must not list its DataVolume');
  updates[k].content=replaceOnce(updates[k].content,/^  - virtualmachine\.yaml$/,'  - virtualmachine.yaml\n  - datavolume.yaml','Kustomization must list virtualmachine.yaml once');
  for(const file of [v,dv,k]) {
    const live=await w.content('box1-workloads-dev',file);
    check(live===files[file].content||live===updates[file].content,'First-release GitOps content drifted: '+file);
  }
  return updates;
}
async function vmVerify(w) {
  requireImageDigest(w);
  const vmPath=`/apis/kubevirt.io/v1/namespaces/${w.ns}/virtualmachines/${w.name}`;
  await w.wait('first VM boot with guest agent',1500,async()=>{
    const app=await w.kube.get(APPS+'/'+w.name);
    const sync=w.data.promotionSync,operation=app?.status?.operationState;
    if(sync?.requestedAt&&['Error','Failed'].includes(operation?.phase)&&Date.parse(operation.startedAt)>=Date.parse(sync.requestedAt)-5000)throw new Error(syncDetails(app,w.name,sync.revision));
    const vm=await w.kube.get(vmPath);
    if(vm?.metadata?.annotations?.['box1.org/os-image-digest']!==w.data.imageDigest)return 'VirtualMachine records the promoted OS digest';
    const dv=await w.kube.get(`/apis/cdi.kubevirt.io/v1beta1/namespaces/${w.ns}/datavolumes/${w.name}-root`);
    if(dv?.status?.phase==='Failed')throw new Error('Root disk import failed: '+(dv.status.conditions||[]).map(c=>c.message).filter(Boolean).join('; '));
    if(dv?.status?.phase!=='Succeeded')return 'root disk imported ('+(dv?.status?.phase||'pending')+(dv?.status?.progress?' '+dv.status.progress:'')+')';
    if(!vm.status?.conditions?.some(c=>c.type==='Ready'&&c.status==='True'))return 'VirtualMachine Ready';
    const vmi=await w.kube.get(`/apis/kubevirt.io/v1/namespaces/${w.ns}/virtualmachineinstances/${w.name}`);
    if(!vmi?.status?.conditions?.some(c=>c.type==='AgentConnected'&&c.status==='True'))return 'guest agent connected';
    if(app?.status?.sync?.status!=='Synced'||app?.status?.health?.status!=='Healthy')return 'Argo CD Synced and Healthy';
    return true;
  });
  const image=`image-registry.openshift-image-registry.svc:5000/box1-ci/${w.name}@${w.data.imageDigest}`;
  await w.save('DEPLOYMENT_READY',{deploymentImage:image,deploymentReadyAt:new Date().toISOString()});
  const links={sourceUrl:w.data.sourceUrl,catalogUrl:`https://developer-hub.apps.ocp.box1.org/catalog/default/component/${w.name}`,pipelineUrl:`https://console-openshift-console.apps.ocp.box1.org/k8s/ns/box1-ci/tekton.dev~v1~PipelineRun/${w.data.pipelineName}`,deploymentUrl:`https://console-openshift-console.apps.ocp.box1.org/k8s/ns/${w.ns}/kubevirt.io~v1~VirtualMachine/${w.name}`,argoUrl:`https://openshift-gitops-server-openshift-gitops.apps.ocp.box1.org/applications/openshift-gitops/${w.name}`,onboardingUrl:w.data.onboardingPR.url,statusRecord:'rhdh/'+w.key,imageDigest:w.data.imageDigest};
  for(const [key,value] of Object.entries(links))w.ctx.output(key,value);
}
function vmBuildResults(w, run) {
  const imageDigest=imageDigestResult(run);
  const diskDigest=(run.status.results||[]).find(r=>r.name==='disk-digest')?.value;
  check(/^sha256:[a-f0-9]{64}$/.test(diskDigest)&&diskDigest!==ZERO,'Initial CI did not return an immutable VM disk digest');
  return {imageDigest,diskDigest};
}
// artifact profile (box1-docs#137) ------------------------------------------------------
// The onboarding PR adds ci/<name>/ (PaC Repository, release ServiceAccount, ImageStream
// <name>-bundle and its push Role and RoleBinding, all in box1-ci) and the Application
// applications/<name>-ci.yaml. The first build is the release Pipeline itself:
// box1-maven-bundle -> box1-security-gates (gate) -> box1-bundle-consumer-pr. There is no
// promotion in box1-workloads-dev; the consumer digest-bump PR takes its place.
const REGISTRY='image-registry.openshift-image-registry.svc:5000';
const ARTIFACT_CONSUMER=/^(?!box1-gitops$)(?!box1-workloads-dev$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ARTIFACT_CONSUMER_PATH=/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._\/-]{1,200}$/;
const ARTIFACT_PUSH_RULES=name=>[{apiGroups:['','image.openshift.io'],resources:['imagestreams/layers'],resourceNames:[name+'-bundle'],verbs:['get','update']}];
function artifactCiApplication(w) { return w.name+'-ci'; }
// The consumer named by a ci/<name>/ PaC Repository: its only token scope.
function artifactScopeConsumer(repository, name) {
  const scope=repository?.spec?.settings?.github_app_token_scope_repos;
  check(Array.isArray(scope)&&scope.length===1&&typeof scope[0]==='string'&&scope[0].startsWith(ORG+'/'),'The PaC Repository must scope its token to exactly one box1-org consumer repository');
  const consumer=scope[0].slice(ORG.length+1);
  check(ARTIFACT_CONSUMER.test(consumer)&&consumer!==name,'The consumer must be another box1-org repository, never box1-gitops or box1-workloads-dev');
  return consumer;
}
// Mirrors the ci/<repo>/ rule of box1-gitops-validate (box1-docs#139), narrowed to the
// exact resources this profile generates.
function validateArtifactBundle(files, name) {
  validateName(name);
  const base=`ci/${name}/`,app=`applications/${name}-ci.yaml`;
  check(same(Object.keys(files).sort(),[app,base+'kustomization.yaml',base+'release.yaml',base+'repository.yaml'].sort()),'Artifact onboarding must add only applications/<name>-ci.yaml and ci/<name>/{kustomization,repository,release}.yaml');
  const k=YAML.parse(files[base+'kustomization.yaml'].content);
  check(same(k.resources,['repository.yaml','release.yaml'])&&Object.keys(k).every(key=>['apiVersion','kind','resources'].includes(key)),'Invalid ci/<name> Kustomization: only repository.yaml and release.yaml, no namespace, patches or generators');
  const objects=[app,base+'repository.yaml',base+'release.yaml'].flatMap(file=>YAML.parseAllDocuments(files[file].content).map(d=>({file,obj:d.toJSON()}))).filter(({obj})=>obj);
  const seen={};
  for(const {file,obj} of objects) {
    const m=obj.metadata;
    check(m&&!m.generateName&&!m.ownerReferences&&!m.finalizers,'Invalid generated metadata');
    seen[obj.kind]=(seen[obj.kind]||0)+1;
    if(obj.kind==='Application') {
      const sync=obj.spec?.syncPolicy;
      check(file===app&&obj.apiVersion==='argoproj.io/v1alpha1'&&m.name===name+'-ci'&&m.namespace==='openshift-gitops'&&obj.spec.project==='default'&&!obj.spec.sources&&obj.spec.destination?.namespace==='box1-ci'&&obj.spec.destination.server==='https://kubernetes.default.svc'&&obj.spec.source?.repoURL==='https://github.com/box1-org/box1-workloads-dev.git'&&obj.spec.source.path===`ci/${name}`&&obj.spec.source.targetRevision==='main'&&!sync?.automated?.prune,'The CI Application must be <name>-ci, track ci/<name> on main and target box1-ci without pruning');
      continue;
    }
    check(file!==app&&m.namespace==='box1-ci','CI bundle resources must be in box1-ci');
    if(obj.kind==='Repository') {
      check(obj.apiVersion==='pipelinesascode.tekton.dev/v1alpha1'&&m.name===name&&obj.spec?.url===`https://github.com/${ORG}/${name}`&&Object.keys(obj.spec).every(key=>['url','concurrency_limit','settings'].includes(key))&&Object.keys(obj.spec.settings||{}).every(key=>['pipelinerun_provenance','github_app_token_scope_repos'].includes(key))&&obj.spec.settings.pipelinerun_provenance==='default_branch','Invalid PAC Repository: url, concurrency_limit and settings (default_branch provenance, token scope) only');
      artifactScopeConsumer(obj,name);
    } else if(obj.kind==='ServiceAccount') check(obj.apiVersion==='v1'&&m.name===name+'-release','Only the <name>-release ServiceAccount may be created');
    else if(obj.kind==='ImageStream') check(obj.apiVersion==='image.openshift.io/v1'&&m.name===name+'-bundle','Only the <name>-bundle ImageStream may be created');
    else if(obj.kind==='Role') check(obj.apiVersion==='rbac.authorization.k8s.io/v1'&&m.name===name+'-bundle-push'&&same(obj.rules,ARTIFACT_PUSH_RULES(name)),'The push Role may only get and update imagestreams/layers of <name>-bundle');
    else if(obj.kind==='RoleBinding') check(obj.apiVersion==='rbac.authorization.k8s.io/v1'&&m.name===name+'-bundle-push'&&same(obj.roleRef,{apiGroup:'rbac.authorization.k8s.io',kind:'Role',name:name+'-bundle-push'})&&same(obj.subjects,[{kind:'ServiceAccount',name:name+'-release',namespace:'box1-ci'}]),'The push RoleBinding must bind <name>-bundle-push to <name>-release only');
    else throw new Error('Unexpected generated resource for an artifact repository: '+obj.kind);
  }
  for(const kind of ['Application','Repository','ServiceAccount','ImageStream','Role','RoleBinding']) check(seen[kind]===1,'Artifact onboarding needs exactly one '+kind);
  return files;
}
// The consumer is declared in the source repository's .tekton/release.yaml (params
// consumer-repository and consumer-path), and the merged ci/<name> Repository must scope
// its token to exactly that repository. Stored once in the record as `consumer`.
async function artifactConsumer(w) {
  if(w.data.consumer) return w.data.consumer;
  const release=await w.content(w.name,'.tekton/release.yaml',w.data.sourceRevision);
  check(release,'The source revision has no .tekton/release.yaml');
  const run=YAML.parseAllDocuments(release).map(d=>d.toJSON()).find(d=>d?.kind==='PipelineRun');
  const params=Object.fromEntries((run?.spec?.params||[]).map(p=>[p.name,p.value]));
  const consumer={repository:params['consumer-repository'],path:params['consumer-path']};
  check(typeof consumer.repository==='string'&&ARTIFACT_CONSUMER.test(consumer.repository)&&consumer.repository!==w.name&&typeof consumer.path==='string'&&ARTIFACT_CONSUMER_PATH.test(consumer.path),'.tekton/release.yaml must declare a consumer-repository (another box1-org repository) and a relative consumer-path');
  const merged=await w.content('box1-workloads-dev',`ci/${w.name}/repository.yaml`,w.data.onboardingPR?.mergeCommit||'main');
  check(merged,`ci/${w.name}/repository.yaml is not in box1-workloads-dev`);
  const repository=YAML.parseAllDocuments(merged).map(d=>d.toJSON()).find(d=>d?.kind==='Repository');
  check(artifactScopeConsumer(repository,w.name)===consumer.repository,'The PaC Repository token scope must be the consumer declared in .tekton/release.yaml');
  await w.save(null,{consumer});
  return consumer;
}
function artifactBuildCredential(w) {
  check(w.data?.consumer?.repository,'The consumer repository is not recorded; run box1:development:platform first');
  // The consumer PR task creates a branch, a commit and a PR in the consumer only.
  return {repositories:[w.name,w.data.consumer.repository],permissions:{contents:'write',pull_requests:'write'}};
}
async function artifactBuildBarrier(w) {
  await artifactConsumer(w);
  const rbac='/apis/rbac.authorization.k8s.io/v1/namespaces/box1-ci';
  await w.wait('initial bundle build prerequisites',300,async()=>{
    const [serviceAccount,push,stream]=await Promise.all([
      w.kube.get(`/api/v1/namespaces/box1-ci/serviceaccounts/${w.name}-release`),
      w.kube.get(`${rbac}/rolebindings/${w.name}-bundle-push`),
      w.kube.get(`/apis/image.openshift.io/v1/namespaces/box1-ci/imagestreams/${w.name}-bundle`),
    ]);
    if(!serviceAccount)return `box1-ci/${w.name}-release ServiceAccount`;
    if(push?.roleRef?.kind!=='Role'||push.roleRef.name!==w.name+'-bundle-push'||!push.subjects?.some(s=>s.kind==='ServiceAccount'&&s.name===w.name+'-release'&&s.namespace==='box1-ci'))return 'bundle registry push permission';
    if(!stream)return `box1-ci/${w.name}-bundle ImageStream`;
    return true;
  });
}
function artifactPlatformChecks(w) {
  const rbac='/apis/rbac.authorization.k8s.io/v1/namespaces/box1-ci';
  return {
    release_identity:async()=>await w.kube.get(`/api/v1/namespaces/box1-ci/serviceaccounts/${w.name}-release`)?true:`box1-ci/${w.name}-release ServiceAccount`,
    registry_push:async()=>{const [role,binding]=await Promise.all([w.kube.get(`${rbac}/roles/${w.name}-bundle-push`),w.kube.get(`${rbac}/rolebindings/${w.name}-bundle-push`)]);return role&&binding?.roleRef?.name===role.metadata.name&&binding.subjects?.some(s=>s.name===w.name+'-release'&&s.namespace==='box1-ci')||'bundle registry push permission';},
    bundle_imagestream:async()=>await w.kube.get(`/apis/image.openshift.io/v1/namespaces/box1-ci/imagestreams/${w.name}-bundle`)?true:`box1-ci/${w.name}-bundle ImageStream`,
    pac_repository:async()=>{const v=await w.kube.get('/apis/pipelinesascode.tekton.dev/v1alpha1/namespaces/box1-ci/repositories/'+w.name);return v?.spec?.url===`https://github.com/${ORG}/${w.name}`&&same(v.spec.settings?.github_app_token_scope_repos,[ORG+'/'+w.data.consumer?.repository])||'PAC Repository registration scoped to the consumer';},
    argo_application:async()=>{const v=await w.kube.get(APPS+'/'+artifactCiApplication(w));return v?.spec?.destination?.namespace==='box1-ci'&&v.status?.sync?.status==='Synced'||`Argo CD Application ${artifactCiApplication(w)} Synced in box1-ci`;},
  };
}
// The same three Tasks as the generated .tekton/release.yaml, run as <name>-release.
function artifactBuildSpec(w, secretName) {
  const consumer=w.data.consumer;
  check(consumer?.repository&&consumer.path,'The consumer is not recorded; run box1:development:platform first');
  const task=(name,taskName,params,runAfter)=>({name,...(runAfter?{runAfter:[runAfter]}:{}),taskRef:{resolver:'cluster',params:[{name:'kind',value:'task'},{name:'name',value:taskName},{name:'namespace',value:'box1-ci'}]},params:Object.entries(params).map(([n,v])=>({name:n,value:v}))});
  const digest='$(tasks.build.results.image-digest)',revision=w.data.sourceRevision,source=ORG+'/'+w.name;
  return {taskRunTemplate:{serviceAccountName:w.name+'-release'},timeouts:{pipeline:'45m'},pipelineSpec:{tasks:[
    task('build','box1-maven-bundle',{revision,'source-repo':source,'git-auth-secret':secretName,'push-image':'true','image-name':w.name+'-bundle'}),
    task('security','box1-security-gates',{'image-reference':`${REGISTRY}/box1-ci/${w.name}-bundle@${digest}`,'image-digest':digest,'source-revision':revision,'source-repository':source,'application-name':w.name,'pipeline-run':'$(context.pipelineRun.name)',enforcement:'gate','rhtpa-secret':'rhtpa-ci','rhacs-secret':'rhacs-ci'},'build'),
    task('consumer','box1-bundle-consumer-pr',{revision,'image-digest':digest,'bundle-name':w.name+'-bundle','source-repository':source,'consumer-repository':consumer.repository,'consumer-path':consumer.path,'gate-policy':'$(tasks.security.results.policy)','git-auth-secret':secretName,'pipeline-run':'$(context.pipelineRun.name)'},'security'),
  ],results:[{name:'image-digest',value:digest},{name:'gate-policy',value:'$(tasks.security.results.policy)'},{name:'gate-findings',value:'$(tasks.security.results.findings)'},{name:'consumer-pr',value:'$(tasks.consumer.results.pr-url)'},{name:'consumer-outcome',value:'$(tasks.consumer.results.outcome)'}]}};
}
function artifactBuildResults(w, run) {
  const results=Object.fromEntries((run.status.results||[]).map(r=>[r.name,r.value]));
  const imageDigest=imageDigestResult(run);
  check(results['gate-policy']==='pass','The bundle did not pass the security gate in gate mode; it was not proposed');
  const outcome=results['consumer-outcome'],url=results['consumer-pr'];
  check(['opened','updated','unchanged','current'].includes(outcome),'The bundle was not proposed to its consumer (outcome '+(outcome||'missing')+'); inspect PipelineRun box1-ci/'+run.metadata.name);
  check(outcome==='current'||new RegExp(`^https://github\\.com/${ORG}/${w.data.consumer.repository}/pull/[0-9]+$`).test(url||''),'The consumer PR URL is not a PR in the declared consumer');
  return {imageDigest,gate:{enforcement:'gate',policy:'pass',findings:results['gate-findings']||'unavailable',pipelineRun:run.metadata.name},consumerPR:{outcome,url:outcome==='current'?null:url}};
}
async function artifactVerify(w) {
  requireImageDigest(w);
  const {consumer,consumerPR:pr,gate}=w.data,digest=w.data.imageDigest,bundle=`box1-ci/${w.name}-bundle`;
  check(gate?.enforcement==='gate'&&gate.policy==='pass','The security gate result is not recorded as a pass in gate mode');
  check(consumer?.repository&&pr?.outcome,'The consumer PR result is not recorded');
  let state,branch='main';
  await w.wait('bundle digest and consumer PR',300,async()=>{
    const stream=await w.kube.get(`/apis/image.openshift.io/v1/namespaces/box1-ci/imagestreams/${w.name}-bundle`);
    if(!(stream?.status?.tags||[]).some(t=>(t.items||[]).some(i=>i.image===digest)))return `${bundle} holds ${digest}`;
    if(pr.outcome==='current') {
      branch=(await w.github(`/repos/${ORG}/${consumer.repository}`))?.default_branch||'main';
      const file=await w.content(consumer.repository,consumer.path,branch);
      check(file?.includes(`/${bundle}@${digest}`),`${ORG}/${consumer.repository} no longer pins ${bundle}@${digest} and no PR was opened`);
      state='current';return true;
    }
    const current=await w.github(`/repos/${ORG}/${consumer.repository}/pulls/${pr.url.split('/').pop()}`);
    check(current?.html_url===pr.url&&current.base?.repo?.full_name===`${ORG}/${consumer.repository}`,'Consumer PR identity changed');
    if(current.merged){state='merged';return true;}
    check(current.state==='open','The consumer PR was closed without merging: '+pr.url);
    state='open';return true;
  });
  await w.save('ARTIFACT_VERIFIED',{bundleImage:`${REGISTRY}/${bundle}@${digest}`,artifactVerifiedAt:new Date().toISOString(),consumerPR:{...pr,state}});
  // The action's output keys are shared with the other profiles: deploymentUrl is where the
  // bundle is delivered (the consumer PR, or the consumer file when it already pins it).
  const links={sourceUrl:w.data.sourceUrl,catalogUrl:`https://developer-hub.apps.ocp.box1.org/catalog/default/component/${w.name}`,pipelineUrl:`https://console-openshift-console.apps.ocp.box1.org/k8s/ns/box1-ci/tekton.dev~v1~PipelineRun/${w.data.pipelineName}`,deploymentUrl:pr.url||`https://github.com/${ORG}/${consumer.repository}/blob/${branch}/${consumer.path}`,argoUrl:`https://openshift-gitops-server-openshift-gitops.apps.ocp.box1.org/applications/openshift-gitops/${artifactCiApplication(w)}`,onboardingUrl:w.data.onboardingPR.url,statusRecord:'rhdh/'+w.key,imageDigest:digest};
  for(const [key,value] of Object.entries(links))w.ctx.output(key,value);
}
// A published, gated bundle that was proposed to (or is already pinned by) its consumer.
function artifactComplete(data) { return Boolean(data?.bundleImage&&data.artifactVerifiedAt&&data.onboardingPR?.merged&&data.gate?.policy==='pass'&&data.consumerPR?.outcome); }
// vm-instance profile (box1-docs#138) ---------------------------------------------------
// One more VM of an already built and approved bootc OS image (the *source*, for example
// site-gateway-os). There is no source repository and no build: the instance adopts the
// source's approved digests, gets its identity from cloud-init (box1-docs#140) and then
// pins its own digest. Contracts: box1-gitops platform/pipelines/GOLDEN-PATH.md
// ("VM instance workload profile").
//
// Mirrors VM_INSTANCE_SOURCES in box1-gitops gitops-validate.yaml. Adding a source is a
// reviewed change to both, and to the template's `source` enum (scripts/validate.mjs).
const VM_INSTANCE_SOURCES=['site-gateway-os'];
// The booted-digest check: read-only Task, its ServiceAccount and the deploy key Secret
// (created outside Git; approval required). The guest user comes from the source image.
const BOOTED_DIGEST={task:'box1-bootc-status',serviceAccount:'ci-vm-deploy',keySecret:'vm-instance-deploy-ssh',user:'box1-deploy'};
const HUB_ACCOUNT={kind:'ServiceAccount',name:'developer-hub-onboarding',namespace:'rhdh'};
const CLOUD_INIT_RUNBOOK='box1-docs runbooks/vm-cloud-init-identity.md';
// The <instance>-site ConfigMap (box1-docs#140): key -> [required, pattern]. Same allowlist
// as box1-gitops-validate and the assembly script.
const SITE_PATH='(?:/[A-Za-z0-9._%+:-]*)*';
const SITE_KEYS={
  siteId:[true,/^[a-z][a-z0-9_]{1,62}$/],
  keycloakClientId:[true,/^[a-z][a-z0-9-]{1,62}$/],
  keycloakTokenUrl:[true,new RegExp('^https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?'+SITE_PATH+'$')],
  assetServiceUrl:[false,new RegExp('^https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?'+SITE_PATH+'$')],
  kafkaBootstrapServers:[false,/^[A-Za-z0-9.-]+:[0-9]{1,5}(?:,[A-Za-z0-9.-]+:[0-9]{1,5})*$/],
  otlpEndpoint:[false,new RegExp('^https?://[A-Za-z0-9.-]+(?::[0-9]{1,5})?'+SITE_PATH+'$')],
};
const DIGEST=/^sha256:[a-f0-9]{64}$/;
const VM_INSTANCE_FILES=['namespace','updater','admin-access','site','virtualmachine','datavolume','deploy-access','onboarding','kustomization','catalog-info'];
function validateVmInstanceSource(source) {
  check(typeof source==='string'&&VM_INSTANCE_SOURCES.includes(source),`Source image ${source} is not on the vm-instance allowlist (${VM_INSTANCE_SOURCES.join(', ')}; box1-gitops gitops-validate.yaml VM_INSTANCE_SOURCES)`);
  return source;
}
// The source an instance bundle names in box1.org/source-image.
function vmInstanceSourceOf(files, name) {
  const vm=YAML.parseAllDocuments(files[`workloads/${name}/virtualmachine.yaml`]?.content||'').map(d=>d.toJSON()).find(d=>d?.kind==='VirtualMachine');
  return validateVmInstanceSource(vm?.metadata?.annotations?.['box1.org/source-image']);
}
// Mirrors box1-gitops-validate's vm-instance rules (box1-docs#139, with the #140 rules
// added by #138) for an unbuilt bundle, narrowed to the exact resources this profile
// generates: Halted VM with zero digests, DataVolume generated but not yet listed, no PaC
// Repository, the cloud-init Secret only by reference, and the <name>-site ConfigMap.
function validateVmInstanceBundle(files, name) {
  validateName(name);
  const ns=name+'-dev',base=`workloads/${name}/`;
  check(same(Object.keys(files).sort(),[`applications/${name}.yaml`,...VM_INSTANCE_FILES.map(f=>`${base}${f}.yaml`)].sort()),'VM instance onboarding must add one Application and the scoped instance files');
  const source=vmInstanceSourceOf(files,name);
  check(source!==name,'An instance must not be named after its source');
  const k=YAML.parse(files[base+'kustomization.yaml'].content);
  check(same(k.resources,['namespace.yaml','updater.yaml','admin-access.yaml','site.yaml','virtualmachine.yaml','deploy-access.yaml','onboarding.yaml'])&&!k.bases&&!k.components&&!k.patches&&!k.generators&&!k.transformers&&!k.images&&!k.configMapGenerator&&!k.secretGenerator,'Invalid initial VM instance Kustomization: the DataVolume is listed only by the first promotion, and catalog-info.yaml never');
  const objects=Object.entries(files).filter(([p])=>!p.endsWith('kustomization.yaml')&&p!==base+'catalog-info.yaml').flatMap(([p,f])=>YAML.parseAllDocuments(f.content).map(d=>({file:p,obj:d.toJSON()}))).filter(({obj})=>obj);
  const seen={};
  const roleRules={
    [name+'-release-observer@'+ns]:[{apiGroups:['kubevirt.io'],resources:['virtualmachines','virtualmachineinstances'],resourceNames:[name],verbs:['get']},{apiGroups:['cdi.kubevirt.io'],resources:['datavolumes'],resourceNames:[name+'-root'],verbs:['get']}],
    [name+'-release-observer@openshift-gitops']:[{apiGroups:['argoproj.io'],resources:['applications'],resourceNames:[name],verbs:['get']}],
    [name+'-cloud-init-observer@'+ns]:[{apiGroups:[''],resources:['secrets'],resourceNames:[name+'-cloud-init'],verbs:['get']}],
    [name+'-deployer@'+ns]:[{apiGroups:['kubevirt.io'],resources:['virtualmachineinstances'],resourceNames:[name],verbs:['get']},{apiGroups:['subresources.kubevirt.io'],resources:['virtualmachineinstances/portforward'],resourceNames:[name],verbs:['get','update']}],
  };
  const bindingSubjects={
    [name+'-release-observer@'+ns]:[{kind:'ServiceAccount',name:'ci-observe',namespace:'box1-ci'}],
    [name+'-release-observer@openshift-gitops']:[{kind:'ServiceAccount',name:'ci-observe',namespace:'box1-ci'}],
    [name+'-cloud-init-observer@'+ns]:[HUB_ACCOUNT],
    [name+'-deployer@'+ns]:[{kind:'ServiceAccount',name:BOOTED_DIGEST.serviceAccount,namespace:'box1-ci'}],
  };
  for(const {file,obj} of objects) {
    const m=obj.metadata;
    check(m&&!m.generateName&&!m.ownerReferences&&!m.finalizers,'Invalid generated metadata');
    seen[obj.kind]=(seen[obj.kind]||0)+1;
    if(obj.kind==='Application') {
      check(m.name===name&&m.namespace==='openshift-gitops'&&obj.spec.project==='default'&&obj.spec.destination.namespace===ns&&obj.spec.destination.server==='https://kubernetes.default.svc'&&obj.spec.source.repoURL==='https://github.com/box1-org/box1-workloads-dev.git'&&obj.spec.source.path===`workloads/${name}`&&obj.spec.source.targetRevision==='main'&&!obj.spec.syncPolicy?.automated?.prune,'Application must target the instance development namespace without pruning');
    } else if(obj.kind==='Namespace') {
      check(m.name===ns&&m.labels?.['box1.org/workload-profile']==='vm-instance'&&m.labels?.['argocd.argoproj.io/managed-by']==='openshift-gitops','VM instance Namespace must be the managed development namespace with the vm-instance profile');
    } else if(obj.kind==='Role') {
      const rules=roleRules[m.name+'@'+m.namespace];
      check(rules&&same(obj.rules,rules),'Invalid Role '+m.name+' in '+m.namespace+': only the release observers, the cloud-init Secret observer and the booted-digest deployer, exactly as generated');
    } else if(obj.kind==='RoleBinding') {
      if(m.name===name+'-image-puller') {
        check(m.namespace==='box1-ci'&&obj.roleRef.name==='system:image-puller'&&obj.roleRef.kind==='ClusterRole'&&same(obj.subjects,[{apiGroup:'rbac.authorization.k8s.io',kind:'Group',name:'system:serviceaccounts:'+ns}]),'Invalid VM registry pull binding');
      } else {
        const subjects=bindingSubjects[m.name+'@'+m.namespace];
        check(subjects&&obj.roleRef.kind==='Role'&&obj.roleRef.name===m.name&&same(obj.subjects,subjects),'Invalid RoleBinding '+m.name+' in '+m.namespace);
      }
    } else if(obj.kind==='ServiceAccount') {
      check(m.name===name+'-updater'&&m.namespace===ns&&obj.automountServiceAccountToken===false,'Only the non-mounted updater ServiceAccount may be created');
    } else if(obj.kind==='Secret'&&obj.type==='kubernetes.io/service-account-token') {
      check(m.name===name+'-updater-token'&&m.namespace===ns&&m.annotations?.['kubernetes.io/service-account.name']===name+'-updater'&&!obj.data&&!obj.stringData,'Updater token Secret must carry no data in Git');
    } else if(obj.kind==='Secret') {
      check(m.name!==name+'-cloud-init','The '+name+'-cloud-init Secret is assembled outside Git; it must not be in the bundle');
      const values=Object.values(obj.stringData||{});
      check(m.name===name+'-admin-ssh'&&m.namespace===ns&&obj.type==='Opaque'&&!obj.data&&values.length>=1&&values.every(v=>typeof v==='string'&&SSH_KEY.test(v))&&!Object.keys(obj.stringData).some(key=>/^(user|network)data$/i.test(key)),'Only SSH public keys may be stored, in the admin-ssh Secret');
    } else if(obj.kind==='ConfigMap') {
      check(m.name===name+'-site'&&m.namespace===ns&&m.labels?.['box1.org/instance']===name&&!obj.binaryData,'Only the ConfigMap '+name+'-site, labelled box1.org/instance: '+name+' and without binaryData, may be created');
      const data=obj.data||{};
      for(const key of Object.keys(data)) check(Object.hasOwn(SITE_KEYS,key),`ConfigMap ${name}-site may only hold ${Object.keys(SITE_KEYS).join(', ')}; found ${key}`);
      for(const [key,[required,pattern]] of Object.entries(SITE_KEYS)) {
        if(!Object.hasOwn(data,key)) { check(!required,`ConfigMap ${name}-site must set ${key}`); continue; }
        check(typeof data[key]==='string'&&pattern.test(data[key]),`ConfigMap ${name}-site ${key} does not match the #140 pattern`);
      }
    } else if(obj.kind==='VirtualMachine') {
      const a=m.annotations||{},spec=obj.spec,t=spec.template.spec;
      check(m.name===name&&m.namespace===ns,'VirtualMachine must be named after the instance');
      check(a['box1.org/source-image']===source,'VirtualMachine must record its source in box1.org/source-image');
      check(spec.runStrategy==='Halted'&&!spec.dataVolumeTemplates&&a['box1.org/os-image-digest']===ZERO&&/^[a-f0-9]{40}$/.test(a['box1.org/source-revision']||'')&&a['box1.org/build-pipelinerun']==='awaiting-first-release','Unbuilt VirtualMachine must be Halted with zero digests and no dataVolumeTemplates');
      const volumes=Object.fromEntries((t.volumes||[]).map(v=>[v.name,v]));
      check(same(Object.keys(volumes).sort(),['cloudinitdisk','regtoken','root','serviceca'])&&volumes.root.dataVolume?.name===name+'-root'&&volumes.serviceca.configMap?.name==='openshift-service-ca.crt'&&volumes.regtoken.secret?.secretName===name+'-updater-token','VirtualMachine volumes must be the root DataVolume, the bootc update disks and cloudinitdisk');
      check(same(volumes.cloudinitdisk,{name:'cloudinitdisk',cloudInitNoCloud:{secretRef:{name:name+'-cloud-init'}}}),'cloudinitdisk must be cloudInitNoCloud with only secretRef.name: '+name+'-cloud-init');
      const disks=Object.fromEntries((t.domain.devices.disks||[]).map(d=>[d.name,d]));
      check(disks.serviceca?.serial==='serviceca'&&disks.regtoken?.serial==='regtoken'&&disks.root&&disks.cloudinitdisk?.disk?.bus==='virtio','VirtualMachine must expose the bootc update disks by serial and cloudinitdisk on virtio');
      check(!JSON.stringify(t).match(/"serial":"ds=/)&&!t.domain.firmware?.serial,'VM instances must not set a firmware serial or a ds= serial');
      check(same(t.accessCredentials,[{sshPublicKey:{source:{secret:{secretName:name+'-admin-ssh'}},propagationMethod:{qemuGuestAgent:{users:['cloud-user']}}}}]),'Admin SSH keys must come from the admin-ssh Secret through the guest agent, for cloud-user only');
    } else if(obj.kind==='DataVolume') {
      check(file===base+'datavolume.yaml'&&m.name===name+'-root'&&m.namespace===ns&&obj.spec.source?.registry?.url===`docker://${REGISTRY}/box1-ci/${source}-disk@${ZERO}`&&obj.spec.source.registry.pullMethod==='node'&&obj.spec.storage?.storageClassName==='lvms-vg1','Unbuilt root DataVolume must reference the zero '+source+'-disk digest');
    } else {
      throw new Error('Unexpected generated resource for a VM instance: '+obj.kind);
    }
  }
  for(const kind of ['Application','Namespace','ServiceAccount','ConfigMap','VirtualMachine','DataVolume']) check(seen[kind]===1,'VM instance onboarding needs exactly one '+kind);
  check(seen.Secret===2,'VM instance onboarding needs the updater token and admin-ssh Secrets');
  check(seen.Role===4&&seen.RoleBinding===5,'VM instance onboarding needs the observer, cloud-init observer and deployer Roles and their bindings, and the pull binding');
  check(!seen.Repository,'An instance has no source repository, so no PaC Repository');
  const entity=YAML.parse(files[base+'catalog-info.yaml'].content);
  const ann=entity?.metadata?.annotations||{};
  check(entity?.apiVersion==='backstage.io/v1alpha1'&&entity.kind==='Component'&&entity.metadata.name===name&&entity.spec?.type==='vm-instance'&&ann['box1.org/workload-profile']==='vm-instance'&&ann['box1.org/source-image']===source&&ann['backstage.io/kubernetes-id']===name&&!ann['github.com/project-slug']&&same(entity.spec.dependsOn,['component:default/'+source]),'catalog-info.yaml must describe this instance as a vm-instance Component that depends on its source');
  return files;
}
// The source's approved state, read from Git and the registry. Git (box1-workloads-dev
// main) holds the approved OS digest and revision. The root DataVolume of the source is
// the disk of its FIRST release and never changes (DataVolume specs are immutable), so it
// is not the disk of the approved revision once the source has had a day-2 release; the
// instance therefore uses the disk the release pipeline built for that revision,
// box1-ci/<source>-disk:<revision>, and requires box1-ci/<source>:<revision> to be the
// approved OS digest.
async function approvedSource(w, source) {
  const ref=(await w.github(`${REPO}/git/ref/heads/main`))?.object?.sha;
  check(/^[a-f0-9]{40}$/.test(ref||''),'Cannot read box1-workloads-dev main');
  const read=async file=>{const text=await w.content('box1-workloads-dev',`workloads/${source}/${file}`,ref);check(text,`Source ${source} has no workloads/${source}/${file} in box1-workloads-dev`);return YAML.parseAllDocuments(text).map(d=>d.toJSON()).filter(Boolean);};
  const [namespace]=await read('namespace.yaml');
  check(namespace?.metadata?.labels?.['box1.org/workload-profile']==='virtual-machine',`Source ${source} is not a virtual-machine workload`);
  const vm=(await read('virtualmachine.yaml')).find(d=>d.kind==='VirtualMachine');
  const a=vm?.metadata?.annotations||{};
  check(vm?.metadata?.name===source&&DIGEST.test(a['box1.org/os-image-digest']||'')&&a['box1.org/os-image-digest']!==ZERO&&/^[a-f0-9]{40}$/.test(a['box1.org/source-revision']||''),`Source ${source} has no approved OS digest yet (box1.org/os-image-digest is zero or missing); release it first`);
  const dv=(await read('datavolume.yaml')).find(d=>d.kind==='DataVolume');
  const firstDisk=(dv?.spec?.source?.registry?.url||'').split('@')[1];
  const revision=a['box1.org/source-revision'],imageDigest=a['box1.org/os-image-digest'];
  const tag=async(stream,label)=>{
    const is=await w.kube.get(`/apis/image.openshift.io/v1/namespaces/box1-ci/imagestreams/${stream}`);
    const digest=(is?.status?.tags||[]).find(t=>t.tag===label)?.items?.[0]?.image;
    check(DIGEST.test(digest||''),`box1-ci/${stream}:${label} does not exist; the source's approved revision has no ${stream.endsWith('-disk')?'install disk':'image'} in the registry`);
    return digest;
  };
  check(await tag(source,revision)===imageDigest,`box1-ci/${source}:${revision} is not the approved OS digest ${imageDigest}; refusing to pair it with a disk`);
  const diskDigest=await tag(source+'-disk',revision);
  check(diskDigest!==ZERO,'The source disk digest is zero');
  return {sourceRevision:revision,sourceUrl:`https://github.com/${ORG}/${source}`,imageDigest,diskDigest,
    source:{name:source,revision,imageDigest,diskDigest,gitopsRevision:ref,buildPipelineRun:a['box1.org/build-pipelinerun']||null,firstReleaseDiskDigest:DIGEST.test(firstDisk||'')?firstDisk:null}};
}
// An instance name must not shadow an existing workload, CI bundle, Application,
// namespace or repository (whose catalog entity would share component:default/<name>).
async function vmInstanceNameFree(w) {
  const taken=[];
  for(const dir of [`workloads/${w.name}`,`ci/${w.name}`,`applications/${w.name}.yaml`]) if(await w.github(`${REPO}/contents/${dir}?ref=main`,'GET',undefined,{missing:true})) taken.push('box1-workloads-dev/'+dir);
  if(await w.github(`/repos/${ORG}/${w.name}`,'GET',undefined,{missing:true})) taken.push(`repository ${ORG}/${w.name}`);
  if(await w.kube.get('/api/v1/namespaces/'+w.ns)) taken.push('namespace '+w.ns);
  if(await w.kube.get(APPS+'/'+w.name)) taken.push('Argo CD Application '+w.name);
  check(!taken.length,`Instance name ${w.name} collides with an existing workload: ${taken.join(', ')}`);
}
// sourceRevision semantics (box1-docs#138 decision): the source's approved revision, the
// box1.org/source-revision of workloads/<source>/virtualmachine.yaml on box1-workloads-dev
// main when the request is made. A resumed request returns its recorded revision, so a
// later source release never changes an instance in flight.
async function vmInstanceResolveSource(w, source) {
  validateVmInstanceSource(source);
  check(source!==w.name,'An instance must not be named after its source');
  if(w.data) {
    check(w.data.source?.name===source,`Instance ${w.name} was requested from source ${w.data.source?.name}; resubmit with the same source`);
    return {sourceRevision:w.data.sourceRevision,sourceUrl:w.data.sourceUrl,imageDigest:w.data.source.imageDigest,diskDigest:w.data.source.diskDigest};
  }
  await vmInstanceNameFree(w);
  const resolved=await approvedSource(w,source);
  return {sourceRevision:resolved.sourceRevision,sourceUrl:resolved.sourceUrl,imageDigest:resolved.imageDigest,diskDigest:resolved.diskDigest};
}
// Provision's first record: the rendered bundle names the source; its approved state must
// still be the revision the template rendered.
async function vmInstanceInitialRecord(w) {
  const files=validateVmInstanceBundle(await filesAt(path.join(w.ctx.workspacePath,'gitops')),w.name);
  const source=vmInstanceSourceOf(files,w.name);
  await vmInstanceNameFree(w);
  const resolved=await approvedSource(w,source);
  check(resolved.sourceRevision===w.ctx.input.sourceRevision,`The approved revision of ${source} changed from ${w.ctx.input.sourceRevision} to ${resolved.sourceRevision} after this request was rendered; submit the template again`);
  const vm=YAML.parseAllDocuments(files[`workloads/${w.name}/virtualmachine.yaml`].content).map(d=>d.toJSON()).find(d=>d?.kind==='VirtualMachine');
  check(vm?.metadata?.annotations?.['box1.org/source-revision']===resolved.sourceRevision,'The rendered VirtualMachine must record the resolved source revision');
  return {sourceRevision:resolved.sourceRevision,sourceUrl:resolved.sourceUrl,source:resolved.source};
}
function vmInstancePlatformChecks(w) {
  const rbac=ns=>`/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}`;
  return {
    namespace:async()=>{const v=await w.kube.get('/api/v1/namespaces/'+w.ns);return v?.status?.phase==='Active'||w.ns+' Namespace Active';},
    serviceaccounts:async()=>{const values=await Promise.all([[w.ns,w.name+'-updater'],['box1-ci','ci-observe'],['box1-ci',BOOTED_DIGEST.serviceAccount]].map(async([ns,name])=>[ns,name,await w.kube.get(`/api/v1/namespaces/${ns}/serviceaccounts/${name}`)]));const missing=values.find(([, ,v])=>!v);return missing?missing[0]+'/'+missing[1]+' ServiceAccount':true;},
    registry_pull:async()=>{const v=await w.kube.get(`${rbac('box1-ci')}/rolebindings/${w.name}-image-puller`);return v?.roleRef?.name==='system:image-puller'&&v.subjects?.some(s=>s.kind==='Group'&&s.name==='system:serviceaccounts:'+w.ns)||'instance namespace registry pull permission';},
    observer_rbac:async()=>{const values=await Promise.all([w.ns,'openshift-gitops'].map(async ns=>[ns,await w.kube.get(`${rbac(ns)}/roles/${w.name}-release-observer`),await w.kube.get(`${rbac(ns)}/rolebindings/${w.name}-release-observer`)]));const missing=values.find(([ns,role,binding])=>!role||binding?.roleRef?.name!==role.metadata.name||!binding.subjects?.some(s=>s.name==='ci-observe'&&s.namespace==='box1-ci'));return missing?missing[0]+' release observer permissions':true;},
    booted_digest_access:async()=>{const binding=await w.kube.get(`${rbac(w.ns)}/rolebindings/${w.name}-deployer`);return binding?.roleRef?.name===w.name+'-deployer'&&binding.subjects?.some(s=>s.name===BOOTED_DIGEST.serviceAccount&&s.namespace==='box1-ci')||'booted-digest check permission ('+w.name+'-deployer)';},
    argo_application:async()=>{const v=await w.kube.get(APPS+'/'+w.name);return v?.spec?.destination?.namespace===w.ns&&v.status?.sync?.status==='Synced'||'Argo CD Application Synced in '+w.ns;},
    virtual_machine:async()=>await w.kube.get(`/apis/kubevirt.io/v1/namespaces/${w.ns}/virtualmachines/${w.name}`)?true:'initial VirtualMachine',
    // The VM stays Halted (no promotion) until its identity Secret exists. Metadata only.
    cloud_init_secret:async()=>{
      let secret;
      try { secret=await w.kube.metadata(`/api/v1/namespaces/${w.ns}/secrets/${w.name}-cloud-init`); }
      catch(error) { if(error.status===403) return `cannot check ${w.ns}/${w.name}-cloud-init: Role ${w.name}-cloud-init-observer is not in effect`; throw error; }
      if(!secret) return `Secret ${w.ns}/${w.name}-cloud-init is missing: create it with ${CLOUD_INIT_RUNBOOK} (approval required), then resubmit; the VM stays Halted until then`;
      const labels=secret.metadata?.labels||{};
      return labels['box1.org/instance']===w.name&&labels['box1.org/cloud-init']==='userdata'||`Secret ${w.ns}/${w.name}-cloud-init was not assembled by the ${CLOUD_INIT_RUNBOOK} script (labels box1.org/instance and box1.org/cloud-init missing)`;
    },
  };
}
// No build: the instance adopts the digests recorded at provision, after checking that
// the registry still holds both, since the DataVolume and the guest pull them by digest.
async function vmInstanceBuildResults(w) {
  const {source}=w.data;
  check(source?.name&&DIGEST.test(source.imageDigest||'')&&DIGEST.test(source.diskDigest||'')&&source.diskDigest!==ZERO,'The source digests were not recorded at provision; resubmit the template');
  for(const [stream,digest] of [[source.name,source.imageDigest],[source.name+'-disk',source.diskDigest]]) {
    const is=await w.kube.get(`/apis/image.openshift.io/v1/namespaces/box1-ci/imagestreams/${stream}`);
    check((is?.status?.tags||[]).some(t=>(t.items||[]).some(i=>i.image===digest)),`box1-ci/${stream} no longer holds ${digest}; it may have been pruned`);
  }
  return {imageDigest:source.imageDigest,diskDigest:source.diskDigest,adoptedFrom:{source:source.name,revision:source.revision,gitopsRevision:source.gitopsRevision}};
}
// First promotion through the box1-gitops-promote vm-instance contract: this instance's
// OS digest and build annotation, its DataVolume from <source>-disk, the DataVolume listed,
// and the VM started. Nothing outside workloads/<name>/ changes.
async function vmInstancePromotionUpdates(w, files) {
  const {source}=w.data;
  check(DIGEST.test(w.data.imageDigest||'')&&DIGEST.test(w.data.diskDigest||'')&&w.data.diskDigest!==ZERO&&source?.name,'First instance release requires the adopted image and disk digests');
  const base=`workloads/${w.name}/`,v=base+'virtualmachine.yaml',dv=base+'datavolume.yaml',k=base+'kustomization.yaml';
  const updates={[v]:{...files[v]},[dv]:{...files[dv]},[k]:{...files[k]}};
  const replaceOnce=(content,pattern,value,message)=>{const matches=content.match(new RegExp(pattern.source,'gm'));check(matches?.length===1,message);return content.replace(new RegExp(pattern.source,'m'),()=>value);};
  check(updates[v].content.includes('    box1.org/source-revision: '+w.data.sourceRevision),'Initial source revision drifted');
  check(updates[v].content.includes('    box1.org/source-image: '+source.name+'\n'),'The instance must record box1.org/source-image: '+source.name);
  const run=/^box1-ci\/[a-z0-9][a-z0-9.-]{0,252}$/.test(source.buildPipelineRun||'')?source.buildPipelineRun:'adopted-from-'+source.name;
  updates[v].content=replaceOnce(updates[v].content,/^    box1\.org\/os-image-digest: sha256:0{64}$/,'    box1.org/os-image-digest: '+w.data.imageDigest,'First release requires the unbuilt instance OS digest');
  updates[v].content=replaceOnce(updates[v].content,/^    box1\.org\/build-pipelinerun: .+$/,'    box1.org/build-pipelinerun: '+run,'Build annotation missing');
  updates[v].content=replaceOnce(updates[v].content,/^  runStrategy: Halted$/,'  runStrategy: Always','Unbuilt VirtualMachine must be Halted');
  updates[dv].content=replaceOnce(updates[dv].content,new RegExp('^(      url: docker://image-registry\\.openshift-image-registry\\.svc:5000/box1-ci/'+source.name+'-disk@)sha256:0{64}$'),`      url: docker://${REGISTRY}/box1-ci/${source.name}-disk@${w.data.diskDigest}`,'Unbuilt root DataVolume must reference the zero '+source.name+'-disk digest');
  check(!/^  - datavolume\.yaml$/m.test(updates[k].content),'Unbuilt instance must not list its DataVolume');
  updates[k].content=replaceOnce(updates[k].content,/^  - virtualmachine\.yaml$/,'  - virtualmachine.yaml\n  - datavolume.yaml','Kustomization must list virtualmachine.yaml once');
  for(const file of [v,dv,k]) {
    const live=await w.content('box1-workloads-dev',file);
    check(live===files[file].content||live===updates[file].content,'First-release GitOps content drifted: '+file);
  }
  return updates;
}
// Booted-digest mechanism (box1-docs#138 decision): `bootc status --format json` in the
// guest, read by the read-only Task box1-bootc-status as ci-vm-deploy over `virtctl ssh`.
// Returns {digest, pipelineRun}. Replace this function to change the mechanism (for
// example a guest heartbeat); verify only needs the booted digest.
async function vmInstanceBootedDigest(w) {
  const key=await w.kube.metadata(`${CI}/secrets/${BOOTED_DIGEST.keySecret}`);
  check(key,`Booted digest not verified: the deploy key Secret box1-ci/${BOOTED_DIGEST.keySecret} does not exist. Creating it is an approval item (box1-docs#138); the source image must also provide the guest user ${BOOTED_DIGEST.user}. The VM is running; resubmit the same parameters to resume.`);
  const runs='/apis/tekton.dev/v1/namespaces/box1-ci/pipelineruns';
  const previous=w.data.bootedDigestCheck||{};
  let attempt=previous.attempt||1,runName=previous.pipelineName||`onb-${w.name}-boot-${w.data.imageDigest.slice(7,15)}`;
  let run=await w.kube.get(runs+'/'+runName);
  if(run) check(run.metadata.labels?.['box1.org/onboarding-id']===w.data.id,'Booted-digest PipelineRun ownership mismatch');
  if(run?.status?.conditions?.some(c=>c.type==='Succeeded'&&c.status==='False')) {
    check(attempt<3,`Three booted-digest checks failed; inspect PipelineRun box1-ci/${runName}`);
    attempt+=1;runName=`onb-${w.name}-boot-${w.data.imageDigest.slice(7,15)}-r${attempt}`;run=await w.kube.get(runs+'/'+runName);
    if(run) check(run.metadata.labels?.['box1.org/onboarding-id']===w.data.id,'Booted-digest PipelineRun ownership mismatch');
  }
  if(!run) {
    const task={name:'status',taskRef:{resolver:'cluster',params:[{name:'kind',value:'task'},{name:'name',value:BOOTED_DIGEST.task},{name:'namespace',value:'box1-ci'}]},params:[{name:'application-name',value:w.name},{name:'application-namespace',value:w.ns},{name:'ssh-user',value:BOOTED_DIGEST.user},{name:'ssh-key-secret',value:BOOTED_DIGEST.keySecret}]};
    run=await w.kube.request('POST',runs,{apiVersion:'tekton.dev/v1',kind:'PipelineRun',metadata:{name:runName,namespace:'box1-ci',labels:{'backstage.io/kubernetes-id':w.name,'box1.org/onboarding-id':w.data.id}},spec:{taskRunTemplate:{serviceAccountName:BOOTED_DIGEST.serviceAccount},timeouts:{pipeline:'20m'},pipelineSpec:{tasks:[task],results:[{name:'booted-digest',value:'$(tasks.status.results.booted-digest)'}]}}});
  }
  await w.save(null,{bootedDigestCheck:{pipelineName:runName,attempt}});
  await w.wait('booted-digest check '+runName,1200,async()=>{
    run=await w.kube.get(runs+'/'+runName);const c=run?.status?.conditions?.find(c=>c.type==='Succeeded');
    check(c?.status!=='False',`Booted-digest check failed: ${c?.message}. Inspect PipelineRun box1-ci/${runName}; resubmit to retry.`);
    return c?.status==='True';
  });
  const digest=(run.status.results||[]).find(r=>r.name==='booted-digest')?.value;
  check(DIGEST.test(digest||''),'The booted-digest check returned no digest');
  return {digest,pipelineRun:runName};
}
async function vmInstanceVerify(w) {
  requireImageDigest(w);
  const vmPath=`/apis/kubevirt.io/v1/namespaces/${w.ns}/virtualmachines/${w.name}`;
  await w.wait('first instance boot with guest agent',1500,async()=>{
    const app=await w.kube.get(APPS+'/'+w.name);
    const sync=w.data.promotionSync,operation=app?.status?.operationState;
    if(sync?.requestedAt&&['Error','Failed'].includes(operation?.phase)&&Date.parse(operation.startedAt)>=Date.parse(sync.requestedAt)-5000)throw new Error(syncDetails(app,w.name,sync.revision));
    const vm=await w.kube.get(vmPath);
    if(vm?.metadata?.annotations?.['box1.org/os-image-digest']!==w.data.imageDigest)return 'VirtualMachine records the promoted OS digest';
    const dv=await w.kube.get(`/apis/cdi.kubevirt.io/v1beta1/namespaces/${w.ns}/datavolumes/${w.name}-root`);
    if(dv?.status?.phase==='Failed')throw new Error('Root disk import failed: '+(dv.status.conditions||[]).map(c=>c.message).filter(Boolean).join('; '));
    if(dv?.status?.phase!=='Succeeded')return 'root disk imported ('+(dv?.status?.phase||'pending')+(dv?.status?.progress?' '+dv.status.progress:'')+')';
    if(!vm.status?.conditions?.some(c=>c.type==='Ready'&&c.status==='True'))return 'VirtualMachine Ready ('+(vm.status?.printableStatus||'unknown')+(vm.status?.printableStatus==='CreateContainerConfigError'?'; is the '+w.name+'-cloud-init Secret present?':'')+')';
    const vmi=await w.kube.get(`/apis/kubevirt.io/v1/namespaces/${w.ns}/virtualmachineinstances/${w.name}`);
    if(!vmi?.status?.conditions?.some(c=>c.type==='AgentConnected'&&c.status==='True'))return 'guest agent connected';
    if(app?.status?.sync?.status!=='Synced'||app?.status?.health?.status!=='Healthy')return 'Argo CD Synced and Healthy';
    return true;
  });
  const booted=await w.handlers.bootedDigest(w);
  check(booted.digest===w.data.imageDigest,`Instance ${w.name} booted ${booted.digest}, not the approved ${w.data.imageDigest}. Its disk may predate the approved image; see PipelineRun box1-ci/${booted.pipelineRun}.`);
  const image=`${REGISTRY}/box1-ci/${w.data.source.name}@${w.data.imageDigest}`;
  await w.save('DEPLOYMENT_READY',{deploymentImage:image,deploymentReadyAt:new Date().toISOString(),bootedDigest:{digest:booted.digest,pipelineRun:booted.pipelineRun,checkedAt:new Date().toISOString(),mechanism:`${BOOTED_DIGEST.task}: bootc status --format json over virtctl ssh`}});
  const links={sourceUrl:w.data.sourceUrl,catalogUrl:`https://developer-hub.apps.ocp.box1.org/catalog/default/component/${w.name}`,pipelineUrl:`https://console-openshift-console.apps.ocp.box1.org/k8s/ns/box1-ci/tekton.dev~v1~PipelineRun/${booted.pipelineRun}`,deploymentUrl:`https://console-openshift-console.apps.ocp.box1.org/k8s/ns/${w.ns}/kubevirt.io~v1~VirtualMachine/${w.name}`,argoUrl:`https://openshift-gitops-server-openshift-gitops.apps.ocp.box1.org/applications/openshift-gitops/${w.name}`,onboardingUrl:w.data.onboardingPR.url,statusRecord:'rhdh/'+w.key,imageDigest:w.data.imageDigest};
  for(const [key,value] of Object.entries(links))w.ctx.output(key,value);
}
// A verified instance: both PRs merged, the VM running, and the booted digest proven.
function vmInstanceComplete(data) { return deploymentComplete(data)&&Boolean(data.bootedDigest?.digest)&&data.bootedDigest.digest===data.imageDigest; }
// The instance has no repository: its catalog-info.yaml lives in its GitOps bundle.
function vmInstanceCatalogEntity(w) {
  const target=`https://github.com/${ORG}/box1-workloads-dev/blob/main/workloads/${w.name}/catalog-info.yaml`;
  return {ref:'component:default/'+w.name,target,
    owns:entity=>entity.spec?.type==='vm-instance'&&entity.metadata?.annotations?.['box1.org/workload-profile']==='vm-instance'&&entity.metadata.annotations['backstage.io/managed-by-location']==='url:'+target,
    mismatch:`Existing catalog entity component:default/${w.name} is not this VM instance (expected a vm-instance Component from ${target})`};
}
class Kube {
  async request(method, resource, body, allowMissing = false, accept) {
    const token = (await fs.readFile('/var/run/secrets/kubernetes.io/serviceaccount/token','utf8')).trim();
    const ca = await fs.readFile('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
    return new Promise((resolve,reject) => {
      const req = https.request('https://kubernetes.default.svc' + resource, { method, ca, headers:{ Authorization:'Bearer '+token, 'Content-Type':method==='PATCH'?'application/merge-patch+json':'application/json', ...(accept?{Accept:accept}:{}) } }, res => {
        let text=''; res.on('data', c => text+=c); res.on('end', () => {
          if (allowMissing && res.statusCode === 404) return resolve(null);
          let value; try { value=JSON.parse(text); } catch { return reject(new Error('Invalid Kubernetes response')); }
          if (res.statusCode >= 300) { const error=new Error(`Kubernetes ${method} ${resource}: HTTP ${res.statusCode} ${resource.includes('/secrets') ? value.reason || '' : value.message || value.reason || ''}`); error.status=res.statusCode; return reject(error); }
          resolve(value);
        });
      });
      req.setTimeout(30000, () => req.destroy(new Error('Kubernetes request timeout'))); req.on('error', reject);
      if (body) req.write(JSON.stringify(body)); req.end();
    });
  }
  get(p) { return this.request('GET',p,undefined,true); }
  // Object metadata only (PartialObjectMetadata), for objects whose content the plugin must
  // never receive, such as Secrets. RBAC still needs `get` on the object (box1-docs#138).
  metadata(p) { return this.request('GET',p,undefined,true,'application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1'); }
}
class Workflow {
  constructor({ctx, config, credentials, catalog, kube = new Kube()}) { this.ctx=ctx; this.catalogService=catalog; this.config=config; this.credentials=credentials; this.kube=kube; this.name=validateName(ctx.input.name); this.profile=validateProfile(ctx.input.profile||'service'); this.handlers=PROFILES[this.profile]; this.ns=this.name+'-dev'; this.key='box1-onboard-'+this.name; this.holder=(ctx.task?.id || 'task')+'-'+crypto.randomUUID(); this.executionId=ctx.task?.id || crypto.randomUUID(); this.activeWaits=new Set(); this.saveQueue=Promise.resolve(); }
  log(phase, state, extra={}) { const fields={onboardingId:this.data?.onboardingId||this.data?.id||this.executionId,phase,state,...extra}; this.ctx.logger.info(Object.entries(fields).map(([k,v])=>`${k}=${String(v).replace(/\s+/g,'_')}`).join(' ')); }
  async github(p, method='GET', body, options={}) {
    const { token } = options.token ? {token:options.token} : await this.credentials.getCredentials({url:'https://github.com/'+ORG});
    const response=await fetch('https://api.github.com'+p, {method, headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28'},body:body===undefined?undefined:JSON.stringify(body), signal:AbortSignal.timeout(45000)});
    if (options.missing && response.status===404) return null;
    if (!response.ok) { const e=new Error(`GitHub ${method} ${p.split('?')[0]}: HTTP ${response.status}`);e.status=response.status;throw e; }
    const text=await response.text();return text?JSON.parse(text):null;
  }
  async open() {
    const leasePath=LEASES+'/'+this.key;
    const old=await this.kube.get(leasePath);
    if (old?.spec?.holderIdentity && Date.parse(old.spec.renewTime)+old.spec.leaseDurationSeconds*1000>Date.now()) throw new Error('Another onboarding task holds this service lease; retry after it finishes');
    this.lease=await this.kube.request(old?'PUT':'POST',old?leasePath:LEASES,{apiVersion:'coordination.k8s.io/v1',kind:'Lease',metadata:{name:this.key,namespace:'rhdh',...(old?{resourceVersion:old.metadata.resourceVersion}:{})},spec:{holderIdentity:this.holder,leaseDurationSeconds:120,renewTime:new Date().toISOString().replace('Z','000Z')}});
    this.cm=await this.kube.get(ROOT+'/configmaps/'+this.key);
    this.data=this.cm?JSON.parse(this.cm.data['status.json']):null;
  }
  async renew() {
    check(!this.ctx.signal?.aborted,'Onboarding task was cancelled; submit the same service parameters to resume');
    // Concurrent waits share one renewal: overlapping GET/PUT pairs would conflict on the Lease resourceVersion.
    this.renewal??=this.renewLease().finally(()=>{this.renewal=null;});
    return this.renewal;
  }
  async renewLease() {
    const current=await this.kube.get(LEASES+'/'+this.key);check(current?.spec.holderIdentity===this.holder,'Onboarding lease lost');
    this.lease=await this.kube.request('PUT',LEASES+'/'+this.key,{...current,spec:{...current.spec,renewTime:new Date().toISOString().replace('Z','000Z')}});
  }
  async close() { if(this.lease) {const l=await this.kube.get(LEASES+'/'+this.key);if(l?.spec.holderIdentity===this.holder) await this.kube.request('PUT',LEASES+'/'+this.key,{...l,spec:{...l.spec,holderIdentity:'',leaseDurationSeconds:1}});} }
  // The build and platform observers overlap, so state writes run one at a time.
  // Each write uses the resourceVersion left by the previous one; a 409 therefore
  // means another process changed the record. A null phase keeps the current phase.
  save(phase, extra={}) {
    const write=this.saveQueue.then(()=>this.writeState(phase,extra));
    this.saveQueue=write.catch(()=>{});
    return write;
  }
  async writeState(requestedPhase, extra) {
    const previous=this.data?.phase;
    const phase=requestedPhase??previous;
    const now=new Date().toISOString();
    const status=extra.phaseStatus||(requestedPhase?'succeeded':this.data?.phaseStatus);
    this.data={schemaVersion:2,...this.data,onboardingId:this.data?.onboardingId||this.data?.id||this.executionId,serviceName:this.name,phase,phaseStatus:status,phaseStartedAt:previous===phase?(this.data?.phaseStartedAt||now):now,lastTransitionAt:previous===phase?(this.data?.lastTransitionAt||now):now,updatedAt:now,activeWaits:[...this.activeWaits],...extra};
    if(phase!=='FAILED') {this.data.lastSuccessfulState=phase;delete this.data.error;}
    this.data.history=[...(this.data.history||[]),...(previous===phase?[]:[{phase,at:this.data.updatedAt}])].slice(-40);
    const obj={apiVersion:'v1',kind:'ConfigMap',metadata:{name:this.key,namespace:'rhdh',labels:{'box1.org/onboarding':this.name},...(this.cm?{resourceVersion:this.cm.metadata.resourceVersion}:{})},data:{'status.json':JSON.stringify(this.data)}};
    try {
      this.cm=await this.kube.request(this.cm?'PUT':'POST',this.cm?ROOT+'/configmaps/'+this.key:ROOT+'/configmaps',obj);
    } catch(error) {
      if(error.status===409) {
        const latest=await this.kube.get(ROOT+'/configmaps/'+this.key);
        if(latest) { this.cm=latest; try { this.data=JSON.parse(latest.data['status.json']); } catch {} }
        error.code='ONBOARDING_STATE_CONFLICT';
      }
      throw error;
    }
    if(previous!==phase) this.log(phase,'succeeded',{elapsed: this.data.phaseStartedAt ? Math.round((Date.now()-Date.parse(this.data.phaseStartedAt))/1000)+'s' : '0s'});
  }
  async wait(label, seconds, observe, {signal=this.ctx.signal,logPhase}={}) {
    const deadline=Date.now()+seconds*1000;let last;const phase=logPhase||this.data?.phase||'unknown';const started=Date.now();
    this.activeWaits.add(label);
    try {
      if(this.data) await this.save(null,{phaseStatus:'waiting',waitCondition:label});
      this.log(phase,'waiting',{condition:label,elapsed:'0s'});
      while(Date.now()<deadline) {
        signal?.throwIfAborted();
        await this.renew();
        const result=await observe(); if(result===true||result?.done) return result?.value;
        const reason=typeof result==='string'?result:label;
        if(reason!==last){this.log(phase,'waiting',{condition:reason,elapsed:Math.round((Date.now()-started)/1000)+'s'});last=reason;}
        await pause(5000,undefined,{signal});
      }
      throw new Error('Timed out waiting for '+label+(last&&last!==label?' (last observed: '+last+')':'')+'; retry the same service to resume. Status: rhdh/'+this.key);
    } finally { this.activeWaits.delete(label); }
  }
  // Waits for any running operation to end, then requests the sync. Returns the
  // request time, or null when the Application is already at the expected revision.
  async requestApplicationSync(applicationName, expectedRevision, label) {
    check(/^[a-f0-9]{40}$/.test(expectedRevision), 'GitOps merge commit is missing or invalid');
    const path=APPS+'/'+applicationName;
    await this.wait(label+' before sync',300,async()=>{
      const app=await this.kube.get(path);if(!app)return `${applicationName} Application exists`;
      const operation=app.status?.operationState||{};
      if(['Running','Terminating'].includes(operation.phase))return `${applicationName} has an active Argo operation`;
      if(['Error','Failed'].includes(operation.phase))throw new Error(syncDetails(app,applicationName,expectedRevision));
      return true;
    });
    const app=await this.kube.get(path);check(app,`${applicationName} Application does not exist`);
    const source=workloadSource(app);
    check(source&&normalizeRepo(source.repoURL)===WORKLOADS_REPO,`${applicationName} Application does not track ${WORKLOADS_REPO}`);
    if(syncedAt(app,expectedRevision)){
      this.ctx.logger.info(`${applicationName} already Synced/Healthy at ${app.status.sync.revision||JSON.stringify(app.status.sync.revisions)}`);return null;
    }
    const requestStarted=Date.now();
    const sync={syncStrategy:{hook:{}}};
    if(app.spec?.sources?.length) sync.revisions=app.spec.sources.map(item=>normalizeRepo(item.repoURL)===WORKLOADS_REPO?expectedRevision:(item.targetRevision||'HEAD'));
    else sync.revision=expectedRevision;
    await this.kube.request('PATCH',path,{operation:{initiatedBy:{username:'box1-rhdh'},sync}});
    return requestStarted;
  }
  async awaitApplicationSync(applicationName, expectedRevision, label, requestStarted, options) {
    const path=APPS+'/'+applicationName;
    await this.wait(label+' requested Argo sync',300,async()=>{
      const current=await this.kube.get(path);if(!current)return syncDetails(current,applicationName,expectedRevision);
      const op=current.status?.operationState||{};
      if(['Error','Failed'].includes(op.phase))throw new Error(syncDetails(current,applicationName,expectedRevision));
      const started=op.startedAt?Date.parse(op.startedAt):0;
      if(op.phase==='Succeeded'&&started>=requestStarted-5000&&syncedAt(current,expectedRevision))return true;
      return syncDetails(current,applicationName,expectedRevision);
    },options);
    this.ctx.logger.info(`${applicationName} sync completed at ${expectedRevision}`);
  }
  // The Argo Application the onboarding PR creates (the profile's gitopsApplication).
  applicationName() { return this.handlers.gitopsApplication?this.handlers.gitopsApplication(this):this.name; }
  // Syncs the workload index so the service Application exists, then requests the
  // service sync without waiting for it. awaitServiceSync observes the outcome.
  async requestServiceSync() {
    const revision=this.data.onboardingPR?.mergeCommit;
    const indexRequested=await this.requestApplicationSync(WORKLOADS_APP,revision,'box1-workloads-dev');
    if(indexRequested!==null) await this.awaitApplicationSync(WORKLOADS_APP,revision,'box1-workloads-dev',indexRequested);
    const application=this.applicationName();
    await this.wait('new service Argo Application creation',300,async()=>{
      const app=await this.kube.get(APPS+'/'+application);
      if(!app)return application+' Application exists';
      this.log('platform','ready',{condition:'service_application_created',application,namespace:'openshift-gitops'});
      return true;
    });
    const requested=await this.requestApplicationSync(application,revision,application);
    const observed=(await this.kube.get(APPS+'/'+application))?.status?.sync;
    this.log('platform',requested===null?'ready':'waiting',{condition:'service_application_sync',application,observedRevision:observed?.revision||observed?.revisions?.join(',')||'none'});
    if(requested===null) await this.save('PLATFORM_APPS_SYNCED',{applicationsSyncedAt:new Date().toISOString()});
    else await this.save('PLATFORM_SYNC_REQUESTED',{serviceSyncRequestedAt:new Date(requested).toISOString()});
  }
  async awaitServiceSync(options) {
    if(this.data.applicationsSyncedAt) return;
    const application=this.applicationName();
    await this.awaitApplicationSync(application,this.data.onboardingPR?.mergeCommit,application,Date.parse(this.data.serviceSyncRequestedAt),options);
    await this.save(null,{applicationsSyncedAt:new Date().toISOString()});
  }
  async content(repo,file,ref='main') { const result=await this.github(`/repos/${ORG}/${repo}/contents/${file}?ref=${encodeURIComponent(ref)}`,'GET',undefined,{missing:true});return result?Buffer.from(result.content,'base64').toString():null; }
  async repository() {
    check(this.handlers.sourceRepository!==false,`The ${this.profile} onboarding profile has no source repository`);
    check(['private','public'].includes(this.ctx.input.visibility),'Invalid repository visibility');
    let repo=await this.github(`/repos/${ORG}/${this.name}`,'GET',undefined,{missing:true});
    if(!this.data) {
      check(!repo,'Repository already exists and has no matching onboarding record; refusing to modify it');
      await this.save('REQUESTED',{id:crypto.randomUUID(),name:this.name,namespace:this.ns,owner:this.ctx.input.owner,visibility:this.ctx.input.visibility,description:this.ctx.input.description,templateVersion:this.handlers.templateVersion,...this.handlers.recordFields(this),createdAt:new Date().toISOString()});
    }
    check(this.data.owner===this.ctx.input.owner && this.data.visibility===this.ctx.input.visibility && this.data.description===this.ctx.input.description,'Retry parameters must match the original request');
    this.requireProfile();
    const marker={id:this.data.id,name:this.name,namespace:this.ns,owner:this.data.owner,templateVersion:this.data.templateVersion,...this.handlers.markerFields(this)};
    const pendingDescription=this.data.description+' [box1-onboarding:'+this.data.id+']';
    if(!repo) repo=await this.github('/orgs/'+ORG+'/repos','POST',{name:this.name,private:this.data.visibility==='private',description:pendingDescription,auto_init:false,delete_branch_on_merge:true});
    let currentMarker=await this.content(this.name,'.box1/onboarding.json');
    if(!currentMarker) {
      check(repo.description===pendingDescription && repo.size===0,'Existing repository is not the empty repository owned by this onboarding request');
      await this.github(`/repos/${ORG}/${this.name}/contents/.box1/onboarding.json`,'PUT',{message:'Initialize Box1 development onboarding',content:Buffer.from(JSON.stringify(marker,null,2)+'\n').toString('base64'),branch:'main'});
      currentMarker=JSON.stringify(marker);
    }
    check(same(JSON.parse(currentMarker),marker),'Repository ownership marker does not match this request');
    if(!this.data.sourceRevision) {
      const files=await filesAt(path.join(this.ctx.workspacePath,'application'));
      files['.box1/onboarding.json']={content:JSON.stringify(marker,null,2)+'\n',mode:'100644'};
      const head=(await this.github(`/repos/${ORG}/${this.name}/git/ref/heads/main`)).object.sha;
      const commit=await this.github(`/repos/${ORG}/${this.name}/git/commits/${head}`);
      const tree=await this.github(`/repos/${ORG}/${this.name}/git/trees/${commit.tree.sha}?recursive=1`);
      check(!tree.truncated,'Source tree is truncated');
      const existing=Object.fromEntries(tree.tree.filter(e=>e.type==='blob').map(e=>[e.path,e.sha]));
      const complete=Object.keys(existing).length===Object.keys(files).length&&Object.entries(files).every(([p,f])=>existing[p]===blobSha(f.content));
      let revision=head;
      if(!complete){
        check(Object.keys(existing).length===1&&existing['.box1/onboarding.json']===blobSha(files['.box1/onboarding.json'].content),'Source repository changed during initialization; refusing to overwrite');
        revision=await this.commit(this.name,head,files,this.handlers.commitMessage);
        await this.github(`/repos/${ORG}/${this.name}/git/refs/heads/main`,'PATCH',{sha:revision,force:false});
      }
      await this.save('REPOSITORY_READY',{sourceRevision:revision,sourceUrl:`https://github.com/${ORG}/${this.name}`});
    }
    await this.github(`/repos/${ORG}/${this.name}`,'PATCH',{description:this.data.description});
    this.ctx.output('remoteUrl',this.data.sourceUrl);this.ctx.output('repoContentsUrl',this.data.sourceUrl+'/blob/main');this.ctx.output('commitHash',this.data.sourceRevision);
  }
  async commit(repo,parent,files,message) {
    const previous=await this.github(`/repos/${ORG}/${repo}/git/commits/${parent}`);const entries=[];
    for(const [file,entry] of Object.entries(files)) { const b=await this.github(`/repos/${ORG}/${repo}/git/blobs`,'POST',{content:entry.content,encoding:'utf-8'});entries.push({path:file,mode:entry.mode,type:'blob',sha:b.sha}); }
    const tree=await this.github(`/repos/${ORG}/${repo}/git/trees`,'POST',{base_tree:previous.tree.sha,tree:entries});
    return (await this.github(`/repos/${ORG}/${repo}/git/commits`,'POST',{message,tree:tree.sha,parents:[parent]})).sha;
  }
  async pullRequest(stage,files) {
    const field=stage==='onboarding'?'onboardingPR':'promotionPR';
    const branch=(stage==='onboarding'?'onboard/':'onboard-release/')+this.name;
    let pr=this.data[field]?await this.github(REPO+'/pulls/'+this.data[field].number):null;
    if(!pr) {
      const list=await this.github(REPO+'/pulls?state=all&head='+encodeURIComponent(ORG+':'+branch)+'&base=main');
      check(list.length<=1,'Duplicate onboarding PRs require review');pr=list[0];
    }
    if(!pr) {
      const ref=await this.github(REPO+'/git/ref/heads/'+branch,'GET',undefined,{missing:true});
      if(!ref) {
        const parent=(await this.github(REPO+'/git/ref/heads/main')).object.sha;
        if(stage==='onboarding') for(const file of Object.keys(files)) check(await this.content('box1-workloads-dev',file)===null,'GitOps resources already exist without this onboarding PR');
        const sha=await this.commit('box1-workloads-dev',parent,files,`Onboard ${this.name}: ${stage}`);
        await this.github(REPO+'/git/refs','POST',{ref:'refs/heads/'+branch,sha});
      }
      // A deterministic branch is accepted only after its content is verified below.
      pr=await this.github(REPO+'/pulls','POST',{title:`${stage==='onboarding'?'Onboard':'Promote first release of'} ${this.name} to development`,head:branch,base:'main',body:`Box1 zero-touch onboarding ${this.data.id}.\n\nDevelopment namespace: ${this.ns}\nSource: ${this.data.sourceRevision}\nOnly this service's generated files may be merged after required checks pass.`});
    }
    await this.save(stage==='onboarding'?'ONBOARDING_PR_OPEN':'PROMOTION_PR_OPEN',{[field]:{number:pr.number,url:pr.html_url,head:pr.head.sha}});
    return this.merge(stage,pr,files);
  }
  async verifyPR(pr,files) {
    check(pr.base.ref==='main'&&pr.base.repo.full_name===ORG+'/box1-workloads-dev'&&pr.head.repo.full_name===ORG+'/box1-workloads-dev'&&pr.body.includes(this.data.id),'PR identity changed');
    const changed=await this.github(REPO+'/pulls/'+pr.number+'/files?per_page=100');
    check(same(changed.map(f=>f.filename).sort(),Object.keys(files).sort()) && changed.every(f=>f.status!=='removed'&&!f.previous_filename),'PR has unexpected paths');
    for(const [file,f] of Object.entries(files)) check(await this.content('box1-workloads-dev',file,pr.head.sha)===f.content,'PR contents changed: '+file);
  }
  async merge(stage,pr,files) {
    const field=stage==='onboarding'?'onboardingPR':'promotionPR';let retry=this.data[field]?.validationRetries||0;
    if(!pr.merged_at) {
      await this.verifyPR(pr,files);
      await this.wait(stage+' exact-head required checks',900,async()=>{
        pr=await this.github(REPO+'/pulls/'+pr.number);check(pr.state==='open'||pr.merged,'PR was closed without merging');
        if(pr.merged) return true;
        check(pr.head.sha===this.data[field].head,'PR head changed outside the workflow');
        const checks=(await this.github(REPO+'/commits/'+pr.head.sha+'/check-runs?per_page=100')).check_runs;
        const required=['Pipelines as Code CI / box1-phase1-smoke-','Pipelines as Code CI / box1-gitops-validate-'];
        const selected={};for(const c of checks.sort((a,b)=>a.id-b.id)) if(required.includes(c.name)&&c.app.slug==='box1-pipelines') selected[c.name]=c;
        const failed=Object.values(selected).filter(c=>c.status==='completed'&&c.conclusion!=='success');
        if(failed.length) {
          // Re-run on a new GitOps commit with the IDENTICAL tree. Never override failed checks.
          check(retry<2,'Required GitOps checks failed after two fresh validation attempts: '+failed.map(c=>c.html_url).join(', '));
          const old=await this.github(REPO+'/git/commits/'+pr.head.sha);
          const replacement=await this.github(REPO+'/git/commits','POST',{message:`Retry ${this.name} ${stage} validation ${++retry}`,tree:old.tree.sha,parents:[pr.head.sha]});
          await this.github(REPO+'/git/refs/heads/'+pr.head.ref,'PATCH',{sha:replacement.sha,force:false});
          await this.save(this.data.phase,{[field]:{...this.data[field],head:replacement.sha,validationRetries:retry}});
          return 'fresh required checks for unchanged '+stage+' content';
        }
        return required.every(n=>selected[n]?.status==='completed'&&selected[n].conclusion==='success')||'required checks for '+pr.head.sha.slice(0,12);
      });
      await this.verifyPR(pr,files);
      if(!pr.merged) {
        try{ await this.github(REPO+'/pulls/'+pr.number+'/merge','PUT',{sha:pr.head.sha,merge_method:'squash'}); }
        catch(e){if(!e.status||e.status>=500){const current=await this.github(REPO+'/pulls/'+pr.number);if(!current.merged)throw e;}else throw e;}
      }
    }
    pr=await this.github(REPO+'/pulls/'+pr.number);check(pr.merged,'Exact-head development merge rejected');
    await this.save(stage==='onboarding'?'ONBOARDING_MERGED':'PROMOTION_MERGED',{[field]:{...this.data[field],merged:true,mergeCommit:pr.merge_commit_sha}});
    return pr;
  }
  // Build prerequisites for the profile, waited for at the end of box1:development:platform.
  async buildBarrier() { if(this.handlers.buildBarrier) await this.handlers.buildBarrier(this); }
  async platformReady(options) {
    const checks=this.handlers.platformChecks(this);
    const started=Date.now();
    await this.wait('development platform readiness',900,async()=>{
      const results=await Promise.all(Object.entries(checks).map(async([condition,fn])=>{try{const result=await fn();return [condition,result===true?'ready':result];}catch(error){return [condition,'failed: '+error.message];}}));
      const pending=results.filter(([,state])=>state!=='ready');
      this.data.readiness={conditions:Object.fromEntries(results),elapsedSeconds:Math.round((Date.now()-started)/1000)};
      if(!pending.length)return true;
      return pending.map(([condition,state])=>`condition=${condition} state=${state}`).join('; ');
    },options);
  }
  platformComplete() { return Boolean(this.data.history?.some(item=>item.phase==='PLATFORM_READY')); }
  async completePlatform({signal}) {
    const options={signal,logPhase:'platform'};
    if(this.handlers.validateBundle) await this.awaitServiceSync(options);
    if(this.handlers.platformChecks) await this.platformReady(options);
  }
  async buildToken() {
    const app=this.config.getConfigArray('integrations.github')[0].getConfigArray('apps')[0];
    const now=Math.floor(Date.now()/1000);const h=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url');
    const p=Buffer.from(JSON.stringify({iat:now-60,exp:now+300,iss:String(app.getString('appId'))})).toString('base64url');
    const unsigned=h+'.'+p;const jwt=unsigned+'.'+crypto.sign('RSA-SHA256',Buffer.from(unsigned),app.getString('privateKey')).toString('base64url');
    const installation=await this.github('/orgs/'+ORG+'/installation','GET',undefined,{token:jwt});
    const scope=this.handlers.buildCredential?this.handlers.buildCredential(this):{repositories:[this.name],permissions:{contents:'read'}};
    return this.github('/app/installations/'+installation.id+'/access_tokens','POST',scope,{token:jwt});
  }
  hasBuild() { return Boolean(this.handlers.buildSpec||this.handlers.buildResults); }
  async build() {
    // Without a PipelineRun the profile records its build results directly.
    if(!this.handlers.buildSpec) return this.save('IMAGE_BUILT',await this.handlers.buildResults(this,null));
    const runs='/apis/tekton.dev/v1/namespaces/box1-ci/pipelineruns';
    let runName=this.data.pipelineName||`onb-${this.name}-${this.data.sourceRevision.slice(0,8)}`;
    let run=await this.kube.get(runs+'/'+runName);
    if(run)check(run.metadata.labels?.['box1.org/onboarding-id']===this.data.id,'PipelineRun ownership mismatch');
    if(run?.status?.conditions?.some(c=>c.type==='Succeeded'&&c.status==='False')) {
      const attempt=(this.data.buildAttempt||1)+1;
      check(attempt<=3,'Three initial build attempts failed; inspect recorded PipelineRuns before retrying');
      runName=`onb-${this.name}-${this.data.sourceRevision.slice(0,8)}-r${attempt}`;
      await this.save('BUILD_RETRY',{pipelineName:runName,buildAttempt:attempt,previousPipelines:[...(this.data.previousPipelines||[]),run.metadata.name]});
      run=await this.kube.get(runs+'/'+runName);
      if(run)check(run.metadata.labels?.['box1.org/onboarding-id']===this.data.id,'Retry PipelineRun ownership mismatch');
    }
    if(!run) {
      // Check source head before building; never silently deploy a later user revision.
      check((await this.github(`/repos/${ORG}/${this.name}/commits/main`)).sha===this.data.sourceRevision,'Source main changed before first build; review onboarding before resuming');
      const secretName=runName+'-git';let secret=await this.kube.get(CI+'/secrets/'+secretName);
      if(secret) {
        check(secret.metadata.labels?.['box1.org/onboarding-id']===this.data.id,'Build Secret ownership mismatch');
        if(Date.parse(secret.metadata.annotations?.['box1.org/expires-at']||'1970-01-01') < Date.now()+300000) {
          await this.kube.request('DELETE',CI+'/secrets/'+secretName,{apiVersion:'v1',kind:'DeleteOptions',preconditions:{uid:secret.metadata.uid}});secret=null;
        }
      }
      if(!secret) {
        const credential=await this.buildToken();
        secret=await this.kube.request('POST',CI+'/secrets',{apiVersion:'v1',kind:'Secret',metadata:{name:secretName,namespace:'box1-ci',labels:{'box1.org/onboarding-id':this.data.id},annotations:{'box1.org/expires-at':credential.expires_at}},type:'Opaque',stringData:{'git-provider-token':credential.token}});
      }
      // Secret creation is observed BEFORE PipelineRun creation, eliminating the PAC secret race.
      check(secret.data?.['git-provider-token'],'Build credential Secret was not persisted');
      const spec=this.handlers.buildSpec(this,secretName);
      run=await this.kube.request('POST',runs,{apiVersion:'tekton.dev/v1',kind:'PipelineRun',metadata:{name:runName,namespace:'box1-ci',labels:{'backstage.io/kubernetes-id':this.name,'box1.org/onboarding-id':this.data.id}},spec});
      await this.save('BUILD_RUNNING',{pipelineName:runName,credentialSecret:secretName});
      // Owner-reference cleanup also works if the Hub process exits before explicit cleanup.
      await this.kube.request('PUT',CI+'/secrets/'+secretName,{...secret,metadata:{...secret.metadata,ownerReferences:[{apiVersion:'tekton.dev/v1',kind:'PipelineRun',name:runName,uid:run.metadata.uid}]}});
    }
    if(!this.data.pipelineName)await this.save('BUILD_RUNNING',{pipelineName:runName,credentialSecret:runName+'-git'});
    try {
      await this.wait('initial CI build '+runName,2800,async()=>{
        run=await this.kube.get(runs+'/'+runName);const c=run?.status?.conditions?.find(c=>c.type==='Succeeded');
        check(c?.status!=='False',`Initial build failed: ${c?.message}. Inspect PipelineRun box1-ci/${runName}; the repository and GitOps onboarding remain recorded for recovery.`);
        return c?.status==='True';
      });
    } catch(error) {
      const failedSecret=this.data.credentialSecret&&await this.kube.get(CI+'/secrets/'+this.data.credentialSecret);
      if(failedSecret){check(failedSecret.metadata.labels?.['box1.org/onboarding-id']===this.data.id,'Refusing to delete an unrelated Secret');await this.kube.request('DELETE',CI+'/secrets/'+this.data.credentialSecret,{apiVersion:'v1',kind:'DeleteOptions',preconditions:{uid:failedSecret.metadata.uid}});}
      throw error;
    }
    const results=this.handlers.buildResults(this,run);
    if(this.data.credentialSecret) {
      const secret=await this.kube.get(CI+'/secrets/'+this.data.credentialSecret);
      if(secret){check(secret.metadata.labels?.['box1.org/onboarding-id']===this.data.id,'Refusing to delete an unrelated Secret');await this.kube.request('DELETE',CI+'/secrets/'+this.data.credentialSecret,{apiVersion:'v1',kind:'DeleteOptions',preconditions:{uid:secret.metadata.uid}});}
    }
    await this.save('IMAGE_BUILT',results);
  }
  // Compatibility wrapper for box1:development:onboard: the same phases the template runs.
  async delivery() {
    for(const phase of DELIVERY_PHASES) await this[phase]();
  }
  // Every phase must run with the profile recorded when the repository was created.
  requireProfile() { check((this.data?.profile||'service')===this.profile,'Onboarding profile does not match the original request'); }
  // Binds a phase to this onboarding: its recorded source revision and profile.
  checkpoint() {
    check(this.data?.sourceRevision===this.ctx.input.sourceRevision,'Missing or mismatched repository checkpoint');
    this.requireProfile();
  }
  // A phase the profile declares absent still checks the checkpoint, then records the skip.
  skip(phase, reason) { this.checkpoint(); this.log(phase,'skipped',{reason}); }
  async gitopsFiles() {
    this.checkpoint();
    return this.handlers.validateBundle(await filesAt(path.join(this.ctx.workspacePath,'gitops')),this.name);
  }
  // A profile without a source repository has no box1:repository:ensure step, so its
  // first phase creates the onboarding record.
  async ensureRecord() {
    const {initialRecord}=this.handlers;
    if(this.data||!initialRecord) return;
    await this.save('REQUESTED',{id:crypto.randomUUID(),name:this.name,namespace:this.ns,templateVersion:this.handlers.templateVersion,...this.handlers.recordFields(this),...await initialRecord(this),createdAt:new Date().toISOString()});
  }
  async provision() {
    await this.ensureRecord();
    if(!this.handlers.validateBundle) return this.skip('provision','profile_has_no_gitops_bundle');
    const files=await this.gitopsFiles();
    if(!this.data.onboardingPR?.merged) await this.pullRequest('onboarding',files);
  }
  // Ends at the build's dependency boundary. The rest of platform readiness is
  // observed during buildPhase, so the build does not wait on unrelated conditions.
  async platform() {
    if(this.handlers.validateBundle&&!this.data.applicationsSyncedAt&&!this.data.serviceSyncRequestedAt) await this.requestServiceSync();
    if(!this.data.imageDigest) await this.buildBarrier();
  }
  // Scaffolder steps run one at a time, so the overlap lives inside this action.
  // That keeps the credential Secret's whole lifecycle within build(). A platform
  // failure lets the build finish, so its digest is kept and cleanup runs; a build
  // failure stops the platform observers.
  async buildPhase() {
    const observers=new AbortController();
    const signal=this.ctx.signal?AbortSignal.any([this.ctx.signal,observers.signal]):observers.signal;
    const build=(async()=>{if(this.hasBuild()&&!this.data.imageDigest) await this.build();})().catch(error=>{observers.abort(error);throw error;});
    const platform=this.platformComplete()?Promise.resolve():this.completePlatform({signal}).catch(error=>{
      if(!signal.aborted) this.log('platform','failed',{condition:error.message});
      throw error;
    });
    const [built,ready]=await Promise.allSettled([build,platform]);
    if(built.status==='rejected') throw built.reason;
    if(ready.status==='rejected') throw ready.reason;
    if(!this.platformComplete()) await this.save('PLATFORM_READY');
  }
  async promote() {
    const {validateBundle,promotionUpdates}=this.handlers;
    if(!validateBundle||!promotionUpdates) return this.skip('promote',validateBundle?'profile_has_no_workload_promotion':'profile_has_no_gitops_bundle');
    const files=await this.gitopsFiles();
    if(!this.data.promotionPR?.merged) {
      check(this.platformComplete(),'Platform readiness has not completed; retry the same service to resume');
      await this.pullRequest('promotion',await promotionUpdates(this,files));
    }
    await this.requestPromotionSync();
  }
  // Requests the rollout of the merged digest instead of relying on when Argo next
  // notices the commit. verify observes the outcome, and the record stops a retry
  // from repeating the request.
  async requestPromotionSync() {
    if(this.data.promotionSync) return;
    const revision=this.data.promotionPR.mergeCommit;
    const application=this.applicationName();
    const requested=await this.requestApplicationSync(application,revision,application);
    await this.save('PROMOTION_SYNC_REQUESTED',{promotionSync:{revision,requestedAt:requested===null?null:new Date(requested).toISOString()}});
  }
  async verify() {
    if(!this.handlers.verify) return this.skip('verify','profile_has_no_verification');
    return this.handlers.verify(this);
  }
  // box1:development:resolve-source (1.5.0): for a profile without a source repository,
  // the source revision (and its approved digests) that the template renders and passes
  // to every later step. Read-only apart from the onboarding Lease; it creates no record.
  async resolveSource() {
    check(this.handlers.resolveSource,`The ${this.profile} onboarding profile has no external source to resolve`);
    if(this.data) this.requireProfile();
    const resolved=await this.handlers.resolveSource(this,this.ctx.input.source);
    check(/^[a-f0-9]{40}$/.test(resolved?.sourceRevision||''),'The source has no approved 40-hex source revision');
    for(const key of RESOLVE_OUTPUTS) if(resolved[key]!==undefined) this.ctx.output(key,resolved[key]);
    this.log('resolveSource','ready',{source:this.ctx.input.source,sourceRevision:resolved.sourceRevision});
  }
  // Catalog actions take only `name`, so the stored record, not the input, names the
  // profile whose completion rule applies. A record without `profile` is a service.
  async registerCatalog() {
    check(this.recordHandlers().catalogComplete(this.data),'Catalog completion requires a verified development deployment');
    await this.catalogSubmit();
    await this.catalogVerify();
  }
  // The profile the stored record names (a record without `profile` is a service).
  recordHandlers() { return PROFILES[validateProfile(this.data?.profile||'service')]; }
  // The catalog entity of this onboarding: the record's profile hook, or the source
  // repository's catalog-info.yaml.
  catalogEntity() { const {catalogEntity}=this.recordHandlers(); return catalogEntity?catalogEntity(this):repositoryCatalogEntity(this.name); }
  async catalogSubmit() {
    check(this.catalogService,'Catalog service is unavailable');
    const entity=this.catalogEntity();
    await this.save('CATALOG_SUBMITTING');
    const options={credentials:await this.ctx.getInitiatorCredentials()};
    const {target,ref}=entity;
    const existing=await this.catalogService.getEntityByRef(ref,options);
    if(!existing) {
      try{await this.catalogService.addLocation({type:'url',target},options);}
      catch(error){if(error.statusCode!==409&&error.status!==409)throw error;this.log('CATALOG_SUBMITTING','waiting',{condition:'catalog_location_exists'});}
    } else check(entity.owns(existing),entity.mismatch);
    this.ctx.output('entityRef',ref);this.ctx.output('catalogInfoUrl',target);
    await this.save('CATALOG_SUBMITTED',{catalog:{entityRef:ref,status:'submitted'}});
  }
  async catalogVerify() {
    const entity=this.catalogEntity();
    const ref=this.data?.catalog?.entityRef||entity.ref;
    await this.save('CATALOG_REGISTERING');
    await ensureCatalog(this.catalogService,this.ctx,entity);
    await this.save('COMPLETE',{completedAt:new Date().toISOString(),catalogEntityRef:ref,catalog:{entityRef:ref,status:'ready'}});
  }
  async run(operation) {
    try{await this.open();this.log(operation,'running');await this[operation]();}
    catch(error){if(this.data)try{const cancelled=this.ctx.signal?.aborted;await this.save(cancelled?'CANCELLED':'FAILED',{phaseStatus:cancelled?'cancelled':'failed',error:error.message,lastErrorCode:error.code|| (cancelled?'ONBOARDING_CANCELLED':'ONBOARDING_FAILED'),lastErrorMessage:error.message,failedDuring:this.data.phase,failedAt:new Date().toISOString()});}catch{}throw error;}
    finally{await this.close();}
  }
}
// The default catalog entity: the source repository's catalog-info.yaml.
function repositoryCatalogEntity(name) {
  return {ref:'component:default/'+name,target:'https://github.com/'+ORG+'/'+name+'/tree/main/catalog-info.yaml',owns:entity=>entity.metadata.annotations?.['github.com/project-slug']===ORG+'/'+name,mismatch:'Existing catalog entity belongs to another source repository'};
}
async function ensureCatalog(catalog,ctx,entity=repositoryCatalogEntity(validateName(ctx.input.name))) {
  const {ref,target}=entity;
  const options={credentials:await ctx.getInitiatorCredentials()};
  const verify=existing=>{
    check(entity.owns(existing),entity.mismatch);
    ctx.output('entityRef',ref);ctx.output('catalogInfoUrl',target);
  };
  const existing=await catalog.getEntityByRef(ref,options);
  if(existing){verify(existing);ctx.logger.info('Reusing existing catalog entity '+ref);return;}
  try{await catalog.addLocation({type:'url',target},options);}
  catch(error){if(error.statusCode!==409&&error.status!==409)throw error;ctx.logger.info('Catalog location already exists; observing entity processing');}
  const deadline=Date.now()+300000;
  while(Date.now()<deadline){
    const entity=await catalog.getEntityByRef(ref,options);
    if(entity){verify(entity);return;}
    await pause(2000,undefined,{signal:ctx.signal});
  }
  throw new Error('Catalog registration did not resolve '+ref+' within five minutes; resume the same onboarding request');
}
module.exports={DELIVERY_PHASES,RESOLVE_OUTPUTS,PROFILES,VM_INSTANCE_SOURCES,Workflow,Kube,validateName,validateProfile,profileInputSchema,validateBundle,validateVmBundle,validateArtifactBundle,validateVmInstanceBundle,filesAt,blobSha,ensureCatalog};
