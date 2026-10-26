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
const LEASES = '/apis/coordination.k8s.io/v1/namespaces/rhdh/leases';
const NAME = /^(?!quarkus-reference$)(?!orders-service$)(?!rhdh$)(?!default$)(?!box1-)(?!openshift-)(?!kube-)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
function check(ok, message) { if (!ok) throw new Error(message); }
function validateName(name) { check(typeof name === 'string' && name.length >= 3 && name.length <= 35 && NAME.test(name), 'Only new, non-reserved development service names are allowed'); return name; }
function blobSha(content) { return crypto.createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex'); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
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
  const expected = [`applications/${name}.yaml`, ...['namespace','serviceaccount','deployment','service','route','onboarding','kustomization'].map(f => `workloads/${name}/${f}.yaml`)];
  check(same(Object.keys(files).sort(), expected.sort()), 'Onboarding must add exactly one Application and its seven development workload files');
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
    } else {
      check(['ServiceAccount','Deployment','Service','Route'].includes(obj.kind) && m.name === name && m.namespace === ns, 'Unexpected generated resource');
      if (obj.kind === 'Deployment') check(obj.spec.replicas === 0 && obj.spec.template.spec.serviceAccountName === name && obj.spec.template.spec.containers.length === 1 && obj.spec.template.spec.containers[0].image === name, 'Unbuilt Deployment must remain inactive');
      if (obj.kind === 'Route') check(obj.spec.host === ns + '.apps.ocp.box1.org' && obj.spec.to.name === name && obj.spec.tls.termination === 'edge', 'Invalid development Route');
    }
  }
  const k = YAML.parse(files[`workloads/${name}/kustomization.yaml`].content);
  check(same(k.resources,['namespace.yaml','serviceaccount.yaml','deployment.yaml','service.yaml','route.yaml','onboarding.yaml']) && k.configMapGenerator?.length === 1 && k.configMapGenerator[0].namespace === ns && k.configMapGenerator[0].name === name + '-config' && !k.bases && !k.components && !k.patches && !k.generators && !k.transformers && k.images?.length === 1 && k.images[0].newName === `image-registry.openshift-image-registry.svc:5000/box1-ci/${name}` && k.images[0].digest === 'sha256:' + '0'.repeat(64), 'Invalid initial Kustomization');
  return files;
}
class Kube {
  async request(method, resource, body, allowMissing = false) {
    const token = (await fs.readFile('/var/run/secrets/kubernetes.io/serviceaccount/token','utf8')).trim();
    const ca = await fs.readFile('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
    return new Promise((resolve,reject) => {
      const req = https.request('https://kubernetes.default.svc' + resource, { method, ca, headers:{ Authorization:'Bearer '+token, 'Content-Type':'application/json' } }, res => {
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
  constructor({ctx, config, credentials, catalog, kube = new Kube()}) { this.ctx=ctx; this.catalogService=catalog; this.config=config; this.credentials=credentials; this.kube=kube; this.name=validateName(ctx.input.name); this.ns=this.name+'-dev'; this.key='box1-onboard-'+this.name; this.holder=(ctx.task?.id || 'task')+'-'+crypto.randomUUID(); }
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
    const current=await this.kube.get(LEASES+'/'+this.key);check(current?.spec.holderIdentity===this.holder,'Onboarding lease lost');
    this.lease=await this.kube.request('PUT',LEASES+'/'+this.key,{...current,spec:{...current.spec,renewTime:new Date().toISOString().replace('Z','000Z')}});
  }
  async close() { if(this.lease) {const l=await this.kube.get(LEASES+'/'+this.key);if(l?.spec.holderIdentity===this.holder) await this.kube.request('PUT',LEASES+'/'+this.key,{...l,spec:{...l.spec,holderIdentity:'',leaseDurationSeconds:1}});} }
  async save(phase, extra={}) {
    const previous=this.data?.phase;
    this.data={...this.data,...extra,phase,updatedAt:new Date().toISOString()};
    if(phase!=='FAILED') {this.data.lastSuccessfulState=phase;delete this.data.error;}
    this.data.history=[...(this.data.history||[]),...(previous===phase?[]:[{phase,at:this.data.updatedAt}])].slice(-40);
    const obj={apiVersion:'v1',kind:'ConfigMap',metadata:{name:this.key,namespace:'rhdh',labels:{'box1.org/onboarding':this.name},...(this.cm?{resourceVersion:this.cm.metadata.resourceVersion}:{})},data:{'status.json':JSON.stringify(this.data)}};
    this.cm=await this.kube.request(this.cm?'PUT':'POST',this.cm?ROOT+'/configmaps/'+this.key:ROOT+'/configmaps',obj);
    if(previous!==phase) this.ctx.logger.info(`${this.name}: ${phase}`);
  }
  async wait(label, seconds, observe) {
    const deadline=Date.now()+seconds*1000;let last;
    while(Date.now()<deadline) {
      await this.renew();
      const result=await observe(); if(result===true||result?.done) return result?.value;
      const reason=typeof result==='string'?result:label;
      if(reason!==last){this.ctx.logger.info('Waiting: '+reason);last=reason;}
      await pause(5000,undefined,{signal:this.ctx.signal});
    }
    throw new Error('Timed out waiting for '+label+'; retry the same service to resume. Status: rhdh/'+this.key);
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
  async platformReady() {
    await this.wait('development platform readiness',900,async()=>{
      const namespace=await this.kube.get('/api/v1/namespaces/'+this.ns);if(namespace?.status?.phase!=='Active')return this.ns+' Namespace Active';
      for(const [ns,name] of [[this.ns,this.name],['box1-ci','ci-build'],['box1-ci','ci-gitops'],['box1-ci','ci-observe']]) if(!await this.kube.get(`/api/v1/namespaces/${ns}/serviceaccounts/${name}`))return ns+'/'+name+' ServiceAccount';
      const pull=await this.kube.get(`/apis/rbac.authorization.k8s.io/v1/namespaces/box1-ci/rolebindings/${this.name}-image-puller`);
      if(pull?.roleRef?.name!=='system:image-puller'||!pull.subjects?.some(s=>s.name===this.name&&s.namespace===this.ns))return 'service registry pull permission';
      const push=await this.kube.get('/apis/rbac.authorization.k8s.io/v1/namespaces/box1-ci/rolebindings/ci-build-image-builder');
      if(push?.roleRef?.name!=='system:image-builder'||!push.subjects?.some(s=>s.name==='ci-build'&&s.namespace==='box1-ci'))return 'CI registry push permission';
      for(const ns of [this.ns,'openshift-gitops']) {
        const role=await this.kube.get(`/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/roles/${this.name}-release-observer`);
        const binding=await this.kube.get(`/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings/${this.name}-release-observer`);
        if(!role||binding?.roleRef?.name!==role.metadata.name||!binding.subjects?.some(s=>s.name==='ci-observe'&&s.namespace==='box1-ci'))return ns+' release observer permissions';
      }
      const repository=await this.kube.get('/apis/pipelinesascode.tekton.dev/v1alpha1/namespaces/box1-ci/repositories/'+this.name);
      if(repository?.spec?.url!==`https://github.com/${ORG}/${this.name}`)return 'PAC Repository registration';
      const app=await this.kube.get(APPS+'/'+this.name);
      if(app?.spec?.destination?.namespace!==this.ns||app.status?.sync?.status!=='Synced')return 'Argo CD Application Synced in '+this.ns;
      const dep=await this.kube.get(`/apis/apps/v1/namespaces/${this.ns}/deployments/${this.name}`);
      if(!dep)return 'initial Deployment';
      return true;
    });
    await this.save('PLATFORM_READY');
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
    await this.wait('initial CI build '+runName,2800,async()=>{
      run=await this.kube.get(runs+'/'+runName);const c=run?.status?.conditions?.find(c=>c.type==='Succeeded');
      check(c?.status!=='False',`Initial build failed: ${c?.message}. Inspect PipelineRun box1-ci/${runName}; the repository and GitOps onboarding remain recorded for recovery.`);
      return c?.status==='True';
    });
    const digest=(run.status.results||[]).find(r=>r.name==='image-digest')?.value;
    check(/^sha256:[a-f0-9]{64}$/.test(digest),'Initial CI did not return an immutable image digest');
    if(this.data.credentialSecret) {
      const secret=await this.kube.get(CI+'/secrets/'+this.data.credentialSecret);
      if(secret){check(secret.metadata.labels?.['box1.org/onboarding-id']===this.data.id,'Refusing to delete an unrelated Secret');await this.kube.request('DELETE',CI+'/secrets/'+this.data.credentialSecret,{apiVersion:'v1',kind:'DeleteOptions',preconditions:{uid:secret.metadata.uid}});}
    }
    await this.save('IMAGE_BUILT',{imageDigest:digest});
  }
  async delivery() {
    check(this.data?.sourceRevision===this.ctx.input.sourceRevision,'Missing or mismatched repository checkpoint');
    const files=validateBundle(await filesAt(path.join(this.ctx.workspacePath,'gitops')),this.name);
    // Existing checkpoints reconcile external state instead of blindly replaying mutations.
    if(!this.data.onboardingPR?.merged)await this.pullRequest('onboarding',files);
    await this.platformReady();
    if(!this.data.imageDigest)await this.build();
    if(!this.data.promotionPR?.merged) {
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
    await this.save('CATALOG_REGISTERING');
    await ensureCatalog(this.catalogService,this.ctx);
    await this.save('COMPLETE',{completedAt:new Date().toISOString(),catalogEntityRef:'component:default/'+this.name});
  }
  async run(operation) {
    try{await this.open();await this[operation]();}
    catch(error){if(this.data)try{await this.save('FAILED',{error:error.message,failedDuring:this.data.phase,failedAt:new Date().toISOString()});}catch{}throw error;}
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
module.exports={Workflow,Kube,validateName,validateBundle,filesAt,blobSha,ensureCatalog};
