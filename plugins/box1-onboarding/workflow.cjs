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
const NAME = /^(?!quarkus-reference$)(?!orders-service$)(?!rhdh$)(?!default$)(?!box1-)(?!openshift-)(?!kube-)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
function check(ok, message) { if (!ok) throw new Error(message); }
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
class Kube {
  async request(method, resource, body, allowMissing = false) {
    const token = (await fs.readFile('/var/run/secrets/kubernetes.io/serviceaccount/token','utf8')).trim();
    const ca = await fs.readFile('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
    return new Promise((resolve,reject) => {
      const req = https.request('https://kubernetes.default.svc' + resource, { method, ca, headers:{ Authorization:'Bearer '+token, 'Content-Type':method==='PATCH'?'application/merge-patch+json':'application/json' } }, res => {
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
}
class Workflow {
  constructor({ctx, config, credentials, catalog, kube = new Kube()}) { this.ctx=ctx; this.catalogService=catalog; this.config=config; this.credentials=credentials; this.kube=kube; this.name=validateName(ctx.input.name); this.ns=this.name+'-dev'; this.key='box1-onboard-'+this.name; this.holder=(ctx.task?.id || 'task')+'-'+crypto.randomUUID(); this.executionId=ctx.task?.id || crypto.randomUUID(); this.activeWaits=new Set(); this.saveQueue=Promise.resolve(); }
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
      throw new Error('Timed out waiting for '+label+'; retry the same service to resume. Status: rhdh/'+this.key);
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
  // Syncs the workload index so the service Application exists, then requests the
  // service sync without waiting for it. awaitServiceSync observes the outcome.
  async requestServiceSync() {
    const revision=this.data.onboardingPR?.mergeCommit;
    const indexRequested=await this.requestApplicationSync(WORKLOADS_APP,revision,'box1-workloads-dev');
    if(indexRequested!==null) await this.awaitApplicationSync(WORKLOADS_APP,revision,'box1-workloads-dev',indexRequested);
    await this.wait('new service Argo Application creation',300,async()=>{
      const app=await this.kube.get(APPS+'/'+this.name);
      if(!app)return this.name+' Application exists';
      this.log('platform','ready',{condition:'service_application_created',application:this.name,namespace:'openshift-gitops'});
      return true;
    });
    const requested=await this.requestApplicationSync(this.name,revision,this.name);
    const observed=(await this.kube.get(APPS+'/'+this.name))?.status?.sync;
    this.log('platform',requested===null?'ready':'waiting',{condition:'service_application_sync',application:this.name,observedRevision:observed?.revision||observed?.revisions?.join(',')||'none'});
    if(requested===null) await this.save('PLATFORM_APPS_SYNCED',{applicationsSyncedAt:new Date().toISOString()});
    else await this.save('PLATFORM_SYNC_REQUESTED',{serviceSyncRequestedAt:new Date(requested).toISOString()});
  }
  async awaitServiceSync(options) {
    if(this.data.applicationsSyncedAt) return;
    await this.awaitApplicationSync(this.name,this.data.onboardingPR?.mergeCommit,this.name,Date.parse(this.data.serviceSyncRequestedAt),options);
    await this.save(null,{applicationsSyncedAt:new Date().toISOString()});
  }
  async content(repo,file,ref='main') { const result=await this.github(`/repos/${ORG}/${repo}/contents/${file}?ref=${encodeURIComponent(ref)}`,'GET',undefined,{missing:true});return result?Buffer.from(result.content,'base64').toString():null; }
  async repository() {
    check(['private','public'].includes(this.ctx.input.visibility),'Invalid repository visibility');
    let repo=await this.github(`/repos/${ORG}/${this.name}`,'GET',undefined,{missing:true});
    if(!this.data) {
      check(!repo,'Repository already exists and has no matching onboarding record; refusing to modify it');
      await this.save('REQUESTED',{id:crypto.randomUUID(),name:this.name,namespace:this.ns,owner:this.ctx.input.owner,visibility:this.ctx.input.visibility,description:this.ctx.input.description,templateVersion:'1.1.0',createdAt:new Date().toISOString()});
    }
    check(this.data.owner===this.ctx.input.owner && this.data.visibility===this.ctx.input.visibility && this.data.description===this.ctx.input.description,'Retry parameters must match the original request');
    const marker={id:this.data.id,name:this.name,namespace:this.ns,owner:this.data.owner,templateVersion:this.data.templateVersion};
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
        revision=await this.commit(this.name,head,files,'Create Quarkus service from the Box1 golden path');
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
  async buildBarrier() {
    await this.wait('initial build prerequisites',300,async()=>{
      const [namespace,serviceAccount,push]=await Promise.all([
        this.kube.get('/api/v1/namespaces/'+this.ns),
        this.kube.get('/api/v1/namespaces/box1-ci/serviceaccounts/ci-build'),
        this.kube.get('/apis/rbac.authorization.k8s.io/v1/namespaces/box1-ci/rolebindings/ci-build-image-builder'),
      ]);
      if(namespace?.status?.phase!=='Active')return this.ns+' Namespace Active';
      if(!serviceAccount)return 'box1-ci/ci-build ServiceAccount';
      if(push?.roleRef?.name!=='system:image-builder'||!push.subjects?.some(s=>s.name==='ci-build'&&s.namespace==='box1-ci'))return 'CI registry push permission';
      return true;
    });
  }
  async platformReady(options) {
    const checks={
      namespace:async()=>{const v=await this.kube.get('/api/v1/namespaces/'+this.ns);return v?.status?.phase==='Active'||this.ns+' Namespace Active';},
      serviceaccounts:async()=>{const values=await Promise.all([[this.ns,this.name],['box1-ci','ci-build'],['box1-ci','ci-gitops'],['box1-ci','ci-observe']].map(async([ns,name])=>[ns,name,await this.kube.get(`/api/v1/namespaces/${ns}/serviceaccounts/${name}`)]));const missing=values.find(([, ,v])=>!v);return missing?missing[0]+'/'+missing[1]+' ServiceAccount':true;},
      registry_pull:async()=>{const v=await this.kube.get(`/apis/rbac.authorization.k8s.io/v1/namespaces/box1-ci/rolebindings/${this.name}-image-puller`);return v?.roleRef?.name==='system:image-puller'&&v.subjects?.some(s=>s.name===this.name&&s.namespace===this.ns)||'service registry pull permission';},
      registry_push:async()=>{const v=await this.kube.get('/apis/rbac.authorization.k8s.io/v1/namespaces/box1-ci/rolebindings/ci-build-image-builder');return v?.roleRef?.name==='system:image-builder'&&v.subjects?.some(s=>s.name==='ci-build'&&s.namespace==='box1-ci')||'CI registry push permission';},
      observer_rbac:async()=>{const values=await Promise.all([this.ns,'openshift-gitops'].map(async ns=>[ns,await this.kube.get(`/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/roles/${this.name}-release-observer`),await this.kube.get(`/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings/${this.name}-release-observer`)]));const missing=values.find(([ns,role,binding])=>!role||binding?.roleRef?.name!==role.metadata.name||!binding.subjects?.some(s=>s.name==='ci-observe'&&s.namespace==='box1-ci'));return missing?missing[0]+' release observer permissions':true;},
      pac_repository:async()=>{const v=await this.kube.get('/apis/pipelinesascode.tekton.dev/v1alpha1/namespaces/box1-ci/repositories/'+this.name);return v?.spec?.url===`https://github.com/${ORG}/${this.name}`||'PAC Repository registration';},
      argo_application:async()=>{const v=await this.kube.get(APPS+'/'+this.name);return v?.spec?.destination?.namespace===this.ns&&v.status?.sync?.status==='Synced'||'Argo CD Application Synced in '+this.ns;},
      deployment:async()=>await this.kube.get(`/apis/apps/v1/namespaces/${this.ns}/deployments/${this.name}`)?true:'initial Deployment',
    };
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
    await this.awaitServiceSync(options);
    await this.platformReady(options);
  }
  async buildToken() {
    const app=this.config.getConfigArray('integrations.github')[0].getConfigArray('apps')[0];
    const now=Math.floor(Date.now()/1000);const h=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url');
    const p=Buffer.from(JSON.stringify({iat:now-60,exp:now+300,iss:String(app.getString('appId'))})).toString('base64url');
    const unsigned=h+'.'+p;const jwt=unsigned+'.'+crypto.sign('RSA-SHA256',Buffer.from(unsigned),app.getString('privateKey')).toString('base64url');
    const installation=await this.github('/orgs/'+ORG+'/installation','GET',undefined,{token:jwt});
    return this.github('/app/installations/'+installation.id+'/access_tokens','POST',{repositories:[this.name],permissions:{contents:'read'}},{token:jwt});
  }
  async build() {
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
      run=await this.kube.request('POST',runs,{apiVersion:'tekton.dev/v1',kind:'PipelineRun',metadata:{name:runName,namespace:'box1-ci',labels:{'backstage.io/kubernetes-id':this.name,'box1.org/onboarding-id':this.data.id}},spec:{taskRunTemplate:{serviceAccountName:'ci-build'},timeouts:{pipeline:'45m'},pipelineSpec:{tasks:[{name:'build',taskRef:{resolver:'cluster',params:[{name:'kind',value:'task'},{name:'name',value:'box1-quarkus-maven'},{name:'namespace',value:'box1-ci'}]},params:[{name:'revision',value:this.data.sourceRevision},{name:'source-repo',value:ORG+'/'+this.name},{name:'git-auth-secret',value:secretName},{name:'push-image',value:'true'},{name:'image-name',value:this.name}]}],results:[{name:'image-digest',value:'$(tasks.build.results.image-digest)'}]}}});
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
    const digest=(run.status.results||[]).find(r=>r.name==='image-digest')?.value;
    check(/^sha256:[a-f0-9]{64}$/.test(digest),'Initial CI did not return an immutable image digest');
    if(this.data.credentialSecret) {
      const secret=await this.kube.get(CI+'/secrets/'+this.data.credentialSecret);
      if(secret){check(secret.metadata.labels?.['box1.org/onboarding-id']===this.data.id,'Refusing to delete an unrelated Secret');await this.kube.request('DELETE',CI+'/secrets/'+this.data.credentialSecret,{apiVersion:'v1',kind:'DeleteOptions',preconditions:{uid:secret.metadata.uid}});}
    }
    await this.save('IMAGE_BUILT',{imageDigest:digest});
  }
  // Compatibility wrapper for box1:development:onboard: the same phases the template runs.
  async delivery() {
    for(const phase of DELIVERY_PHASES) await this[phase]();
  }
  async gitopsFiles() {
    check(this.data?.sourceRevision===this.ctx.input.sourceRevision,'Missing or mismatched repository checkpoint');
    return validateBundle(await filesAt(path.join(this.ctx.workspacePath,'gitops')),this.name);
  }
  async provision() {
    const files=await this.gitopsFiles();
    if(!this.data.onboardingPR?.merged) await this.pullRequest('onboarding',files);
  }
  // Ends at the build's dependency boundary. The rest of platform readiness is
  // observed during buildPhase, so the build does not wait on unrelated conditions.
  async platform() {
    if(!this.data.applicationsSyncedAt&&!this.data.serviceSyncRequestedAt) await this.requestServiceSync();
    if(!this.data.imageDigest) await this.buildBarrier();
  }
  // Scaffolder steps run one at a time, so the overlap lives inside this action.
  // That keeps the credential Secret's whole lifecycle within build(). A platform
  // failure lets the build finish, so its digest is kept and cleanup runs; a build
  // failure stops the platform observers.
  async buildPhase() {
    const observers=new AbortController();
    const signal=this.ctx.signal?AbortSignal.any([this.ctx.signal,observers.signal]):observers.signal;
    const build=(async()=>{if(!this.data.imageDigest) await this.build();})().catch(error=>{observers.abort(error);throw error;});
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
    const files=await this.gitopsFiles();
    if(!this.data.promotionPR?.merged) {
      check(this.platformComplete(),'Platform readiness has not completed; retry the same service to resume');
      const paths=[`workloads/${this.name}/kustomization.yaml`,`workloads/${this.name}/deployment.yaml`];const updates={};
      for(const file of paths) updates[file]={...files[file]};
      check(updates[paths[0]].content.includes('digest: sha256:'+'0'.repeat(64)),'First release requires the unbuilt development image');
      updates[paths[0]].content=updates[paths[0]].content.replace('digest: sha256:'+'0'.repeat(64),'digest: '+this.data.imageDigest);
      updates[paths[1]].content=updates[paths[1]].content.replace(/^  replicas: 0$/m,'  replicas: 1').replace(/^    box1\.org\/build-pipelinerun: .+$/m,'    box1.org/build-pipelinerun: box1-ci/'+this.data.pipelineName);
      check(updates[paths[1]].content.includes('box1.org/source-revision: '+this.data.sourceRevision),'Initial source revision drifted');
      for(const file of paths) {
        const live=await this.content('box1-workloads-dev',file);
        check(live===files[file].content||live===updates[file].content,'First-release GitOps content drifted: '+file);
      }
      await this.pullRequest('promotion',updates);
    }
  }
  async verify() {
    check(this.data?.imageDigest,'Cannot verify deployment without an image digest');
    const image=`image-registry.openshift-image-registry.svc:5000/box1-ci/${this.name}@${this.data.imageDigest}`;
    await this.wait('first deployment and public endpoint',900,async()=>{
      const app=await this.kube.get(APPS+'/'+this.name);const dep=await this.kube.get(`/apis/apps/v1/namespaces/${this.ns}/deployments/${this.name}`);
      if(app?.status?.sync?.status!=='Synced'||app?.status?.health?.status!=='Healthy')return 'Argo CD Synced and Healthy';
      if(dep?.spec?.template?.spec?.containers[0].image!==image||dep.status?.observedGeneration!==dep.metadata.generation||!dep.status?.availableReplicas)return 'digest-pinned Deployment Available';
      try{
        const response=await fetch('https://'+this.ns+'.apps.ocp.box1.org/api/info',{signal:AbortSignal.timeout(10000)});
        if(!response.ok)return 'public Route HTTP '+response.status;
        const info=await response.json();check(info.name===this.name&&info.gitRef===this.data.sourceRevision,'Deployed source identity mismatch');
        const health=await fetch('https://'+this.ns+'.apps.ocp.box1.org/q/health/ready',{signal:AbortSignal.timeout(10000)});
        if(!health.ok||(await health.json()).status!=='UP')return 'public readiness UP';
        return true;
      }catch(e){if(e.message==='Deployed source identity mismatch')throw e;return 'public Route reachable';}
    });
    await this.save('DEPLOYMENT_READY',{deploymentImage:image,deploymentReadyAt:new Date().toISOString()});
    const links={sourceUrl:this.data.sourceUrl,catalogUrl:`https://developer-hub.apps.ocp.box1.org/catalog/default/component/${this.name}`,pipelineUrl:`https://console-openshift-console.apps.ocp.box1.org/k8s/ns/box1-ci/tekton.dev~v1~PipelineRun/${this.data.pipelineName}`,deploymentUrl:'https://'+this.ns+'.apps.ocp.box1.org',argoUrl:`https://openshift-gitops-server-openshift-gitops.apps.ocp.box1.org/applications/openshift-gitops/${this.name}`,onboardingUrl:this.data.onboardingPR.url,statusRecord:'rhdh/'+this.key,imageDigest:this.data.imageDigest};
    for(const [key,value] of Object.entries(links))this.ctx.output(key,value);
  }
  async registerCatalog() {
    check(this.data?.deploymentImage && this.data.onboardingPR?.merged && this.data.promotionPR?.merged,'Catalog completion requires a verified development deployment');
    await this.catalogSubmit();
    await this.catalogVerify();
  }
  async catalogSubmit() {
    check(this.catalogService,'Catalog service is unavailable');
    await this.save('CATALOG_SUBMITTING');
    const options={credentials:await this.ctx.getInitiatorCredentials()};
    const target='https://github.com/'+ORG+'/'+this.name+'/tree/main/catalog-info.yaml';
    const ref='component:default/'+this.name;
    const existing=await this.catalogService.getEntityByRef(ref,options);
    if(!existing) {
      try{await this.catalogService.addLocation({type:'url',target},options);}
      catch(error){if(error.statusCode!==409&&error.status!==409)throw error;this.log('CATALOG_SUBMITTING','waiting',{condition:'catalog_location_exists'});}
    } else check(existing.metadata.annotations?.['github.com/project-slug']===ORG+'/'+this.name,'Existing catalog entity belongs to another source repository');
    this.ctx.output('entityRef',ref);this.ctx.output('catalogInfoUrl',target);
    await this.save('CATALOG_SUBMITTED',{catalog:{entityRef:ref,status:'submitted'}});
  }
  async catalogVerify() {
    const ref=this.data?.catalog?.entityRef||'component:default/'+this.name;
    await this.save('CATALOG_REGISTERING');
    await ensureCatalog(this.catalogService,this.ctx);
    await this.save('COMPLETE',{completedAt:new Date().toISOString(),catalogEntityRef:ref,catalog:{entityRef:ref,status:'ready'}});
  }
  async run(operation) {
    try{await this.open();this.log(operation,'running');await this[operation]();}
    catch(error){if(this.data)try{const cancelled=this.ctx.signal?.aborted;await this.save(cancelled?'CANCELLED':'FAILED',{phaseStatus:cancelled?'cancelled':'failed',error:error.message,lastErrorCode:error.code|| (cancelled?'ONBOARDING_CANCELLED':'ONBOARDING_FAILED'),lastErrorMessage:error.message,failedDuring:this.data.phase,failedAt:new Date().toISOString()});}catch{}throw error;}
    finally{await this.close();}
  }
}
async function ensureCatalog(catalog,ctx) {
  const name=validateName(ctx.input.name);
  const ref='component:default/'+name;
  const target='https://github.com/'+ORG+'/'+name+'/tree/main/catalog-info.yaml';
  const options={credentials:await ctx.getInitiatorCredentials()};
  const verify=entity=>{
    check(entity.metadata.annotations?.['github.com/project-slug']===ORG+'/'+name,'Existing catalog entity belongs to another source repository');
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
module.exports={DELIVERY_PHASES,Workflow,Kube,validateName,validateBundle,filesAt,blobSha,ensureCatalog};
