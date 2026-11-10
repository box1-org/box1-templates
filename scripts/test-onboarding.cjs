// Retired historical fixture: these names validate rejection of previously used demo identifiers.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const YAML=require('yaml');
const {DELIVERY_PHASES,Workflow,validateName,validateBundle,filesAt}=require('../plugins/box1-onboarding/workflow.cjs');
const name='orders-api',id='9ae74f64-b93b-4d70-a6fe-4a223436b6f0',sha='a'.repeat(40),digest='sha256:'+'b'.repeat(64);
function workflow(kube={}){const outputs={};const w=new Workflow({ctx:{input:{name,sourceRevision:sha},workspacePath:'unused',logger:{info(){}},output:(k,v)=>outputs[k]=v},config:{},credentials:{},kube});w.data={id,name,namespace:name+'-dev',sourceRevision:sha};w.renew=async()=>{};w.save=async(phase,extra={})=>{w.data={...w.data,...extra,phase:phase??w.data.phase};};return w;}
test('PostgreSQL NetworkPolicy is accepted only when scoped to this service',async()=>{
 const svc='inventory-service',file=`workloads/${svc}/postgres.yaml`;
 const base=await filesAt(path.resolve(__dirname,'../.validation/inventory-service/gitops'));
 const policy=(n=svc,extra='')=>`\n---\napiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: ${svc}-postgres\n  namespace: ${svc}-dev\nspec:\n  podSelector:\n    matchLabels:\n      app.kubernetes.io/name: ${svc}-postgres\n  policyTypes: [Ingress]\n  ingress:\n    - from:\n        - podSelector:\n            matchLabels:\n              app.kubernetes.io/name: ${n}\n${extra}`;
 const stripped=base[file].content.split(/^---$/m).filter(d=>!d.includes('kind: NetworkPolicy')).join('---');
 const withPolicy=text=>({...base,[file]:{...base[file],content:stripped+text}});
 validateBundle(withPolicy(policy()),svc);
 assert.throws(()=>validateBundle(withPolicy(policy('other-service')),svc),/Invalid PostgreSQL NetworkPolicy/);
 assert.throws(()=>validateBundle(withPolicy(policy(svc,'          namespaceSelector: {}\n')),svc),/Invalid PostgreSQL NetworkPolicy/);
 assert.throws(()=>validateBundle(withPolicy(policy().replace(`${svc}-dev`,'other-dev')),svc),/Invalid PostgreSQL NetworkPolicy/);
 assert.throws(()=>validateBundle(withPolicy(policy().replace(`name: ${svc}-postgres\n  namespace`,'name: other\n  namespace')),svc),/Unexpected generated resource/);
});
test('development-only merge policy rejects namespace, RBAC and baseline changes',async()=>{
 const files=await filesAt(path.resolve(__dirname,'../.validation/orders-api/gitops'));validateBundle(files,name);
 for(const invalid of ['orders-service','quarkus-reference','default','prod/escape','box1-other','Uppercase'])assert.throws(()=>validateName(invalid));
 const namespace=`workloads/${name}/namespace.yaml`,app=`applications/${name}.yaml`;
 const copy=()=>structuredClone(files);
 let changed=copy();changed[namespace].content=changed[namespace].content.replace(name+'-dev',name+'-prod');assert.throws(()=>validateBundle(changed,name));
 changed=copy();changed[app].content=changed[app].content.replace('namespace: "orders-api-dev"','namespace: "orders-api-prod"');assert.throws(()=>validateBundle(changed,name));
 changed=copy();changed['workloads/orders-service/deployment.yaml']={content:'',mode:'100644'};assert.throws(()=>validateBundle(changed,name));
 changed=copy();changed[`workloads/${name}/onboarding.yaml`].content+='\n---\napiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRoleBinding\nmetadata:\n  name: escalated\n';assert.throws(()=>validateBundle(changed,name));
 changed=copy();changed[`workloads/${name}/onboarding.yaml`].content=changed[`workloads/${name}/onboarding.yaml`].content.replace('- get','- create');assert.throws(()=>validateBundle(changed,name));
});
test('phase resume reuses completed provision, platform, build, and promotion work',async()=>{
 const w=workflow();let calls=0;
 w.gitopsFiles=async()=>({});w.pullRequest=async()=>{calls++;};
 w.data.onboardingPR={merged:true};await w.provision();assert.equal(calls,0);
 w.data={...w.data,applicationsSyncedAt:'now',history:[{phase:'PLATFORM_READY'}],imageDigest:digest};w.requestServiceSync=async()=>{calls++;};w.buildBarrier=async()=>{calls++;};await w.platform();assert.equal(calls,0);
 w.completePlatform=async()=>{calls++;};w.build=async()=>{calls++;};await w.buildPhase();assert.equal(calls,0);
 w.data.promotionPR={merged:true};w.data.promotionSync={revision:sha,requestedAt:null};await w.promote();assert.equal(calls,0);
});
test('restart after onboarding PR creation validates and resumes the existing PR',async()=>{
 const w=workflow();let merged=0;const pr={number:7,head:{sha,ref:'onboard/'+name},merged_at:null};
 w.data.onboardingPR={number:7,head:sha};w.github=async p=>p.endsWith('/pulls/7')?pr:{};w.verifyPR=async()=>{};w.wait=async(_l,_s,fn)=>{await fn();};w.merge=async()=>{merged++;};
 await w.pullRequest('onboarding',{});assert.equal(merged,1);assert.equal(w.data.onboardingPR.number,7);
});
test('a merged PR from an earlier onboarding of the same name is not reused (1.5.2)',async()=>{
 const w=workflow();const calls=[];let merged;
 const old={number:210,state:'closed',merged_at:'2026-11-10T03:30:25Z',body:'Box1 zero-touch onboarding 00000000-0000-0000-0000-000000000000.',head:{sha:'c'.repeat(40)}};
 w.content=async()=>null;w.commit=async()=>'d'.repeat(40);w.merge=async(_s,pr)=>{merged=pr;};
 w.github=async(p,method,body)=>{calls.push((method||'GET')+' '+p.split('?')[0]);
  if(p.includes('/pulls?state=all'))return [old];
  if(p.includes('/git/ref/heads/onboard/'))return null;
  if(p.endsWith('/git/ref/heads/main'))return {object:{sha:'e'.repeat(40)}};
  if(method==='POST'&&p.endsWith('/pulls'))return {number:216,html_url:'https://github.com/box1-org/box1-workloads-dev/pull/216',head:{sha:'d'.repeat(40)},body:body.body};
  return {};};
 await w.pullRequest('onboarding',{['workloads/'+name+'/namespace.yaml']:{content:'x',mode:'100644'}});
 assert.equal(merged.number,216);assert.equal(w.data.onboardingPR.number,216);
 assert(calls.some(c=>c.startsWith('POST')&&c.endsWith('/git/refs')),'a new branch is created');
});
test('an open PR from another onboarding on the same branch is refused (1.5.2)',async()=>{
 const w=workflow();w.merge=async()=>{throw Error('must not merge');};
 w.github=async p=>p.includes('/pulls?state=all')?[{number:9,state:'open',body:'Box1 zero-touch onboarding someone-else'}]:{};
 await assert.rejects(w.pullRequest('onboarding',{}),/open onboarding PR from another onboarding uses onboard\/orders-api \(#9\)/);
});
test('merge refuses an already merged PR of another onboarding (1.5.2)',async()=>{
 const w=workflow();
 await assert.rejects(w.merge('promotion',{number:211,merged_at:'x',body:'Box1 zero-touch onboarding someone-else'},{}),/PR identity changed: #211 belongs to another onboarding/);
});
test('a concurrent task cannot acquire an unexpired service lease',async()=>{
 const w=workflow({get:async()=>({spec:{holderIdentity:'other',renewTime:new Date().toISOString(),leaseDurationSeconds:120}})});
 await assert.rejects(w.open(),/Another onboarding task/);
});
test('readiness gates do not advance while namespace or permissions are missing',async()=>{
 const w=workflow({get:async()=>null});let observed;
 w.wait=async(label,seconds,fn)=>{observed=await fn();throw new Error('pending readiness');};
 await assert.rejects(w.platformReady(),/pending readiness/);assert.match(observed,/condition=namespace state=.*Namespace Active/);assert.match(observed,/condition=serviceaccounts/);assert.notEqual(w.data.phase,'PLATFORM_READY');
});
test('readiness aggregation retains diagnostics when a condition fails',async()=>{
 const w=workflow({get:async p=>{if(p.includes('/namespaces/orders-api-dev'))throw Error('api unavailable');return null;}});let diagnostic;
 w.wait=async(_label,_seconds,fn)=>{diagnostic=await fn();throw Error('timed out');};
 await assert.rejects(w.platformReady(),/timed out/);assert.match(diagnostic,/condition=namespace state=failed: api unavailable/);assert.match(diagnostic,/condition=registry_pull/);assert.equal(w.data.readiness.conditions.namespace,'failed: api unavailable');
});
test('readiness cancellation stops before another observation',async()=>{
 const w=workflow({get:async()=>null});w.renew=async()=>{const e=new Error('cancelled');e.name='AbortError';throw e;};
 await assert.rejects(w.platformReady(),/cancelled/);
});
test('build barrier ignores unrelated platform readiness conditions',async()=>{
 const calls=[];const w=workflow({get:async p=>{calls.push(p);if(p.includes('/namespaces/orders-api-dev'))return {status:{phase:'Active'}};if(p.includes('/serviceaccounts/ci-build'))return {};if(p.includes('ci-build-image-builder'))return {roleRef:{name:'system:image-builder'},subjects:[{name:'ci-build',namespace:'box1-ci'}]};return null;}});
 w.wait=async(_label,_seconds,fn)=>fn();await w.buildBarrier();assert.equal(calls.length,3);assert(calls.every(p=>!p.includes('pipelinesascode')&&!p.includes('argoproj')));
});
test('Argo sync PATCH uses Kubernetes merge-patch content type',async()=>{
 const source=await fs.readFile(path.resolve(__dirname,'../plugins/box1-onboarding/workflow.cjs'),'utf8');assert.match(source,/method==='PATCH'\?'application\/merge-patch\+json':'application\/json'/);
});
test('new service explicitly syncs the workload index and service Application',async()=>{
 const mergeCommit='c'.repeat(40),requests=[];let service=null;
 const source={repoURL:'https://github.com/box1-org/box1-workloads-dev.git',path:'applications',targetRevision:'main'};
 const app=(name,revision,status='OutOfSync')=>({metadata:{name},spec:{source:{...source,path:name==='box1-workloads-dev'?'applications':'workloads/'+name}},status:{sync:{status,revision},health:{status:'Healthy'},operationState:{phase:'Succeeded',startedAt:new Date(Date.now()-60000).toISOString()}}});
 let root=app('box1-workloads-dev','old'.repeat(10));
 const kube={get:async p=>p.endsWith('/box1-workloads-dev')?root:p.endsWith('/orders-api')?service:null,request:async(method,p,body)=>{
   requests.push({method,p,body});assert.equal(method,'PATCH');
   const updated=app(p.endsWith('/box1-workloads-dev')?'box1-workloads-dev':'orders-api',mergeCommit,'Synced');updated.status.health.status='Healthy';updated.status.operationState={phase:'Succeeded',startedAt:new Date().toISOString()};
   if(p.endsWith('/box1-workloads-dev')){root=updated;service=app('orders-api','old'.repeat(10));}else service=updated;
   return updated;
 }};
 const w=workflow(kube);w.data={...w.data,onboardingPR:{merged:true,mergeCommit}};
 w.wait=async(label,_seconds,fn)=>{if(label.includes('before sync'))return;const result=await fn();if(label.includes('creation'))assert(result);else assert.equal(result,true);};
 await w.requestServiceSync();await w.awaitServiceSync();
 assert.deepEqual(requests.map(r=>r.p),['/apis/argoproj.io/v1alpha1/namespaces/openshift-gitops/applications/box1-workloads-dev','/apis/argoproj.io/v1alpha1/namespaces/openshift-gitops/applications/orders-api']);
 assert(requests.every(r=>r.body.operation.initiatedBy.username==='box1-rhdh'));
 assert(requests.every(r=>r.body.operation.sync.revision===mergeCommit));
});
test('existing healthy service Application skips a duplicate sync request',async()=>{
 const mergeCommit='c'.repeat(40),requests=[];const app=(name)=>({spec:{source:{repoURL:'https://github.com/box1-org/box1-workloads-dev.git',path:'workloads/'+name}},status:{sync:{status:'Synced',revision:mergeCommit},health:{status:'Healthy'},operationState:{phase:'Succeeded'}}});
 const kube={get:async p=>p.endsWith('/box1-workloads-dev')?app('box1-workloads-dev'):app(name),request:async()=>{requests.push('PATCH');return {};}};
 const w=workflow(kube);w.data={...w.data,onboardingPR:{merged:true,mergeCommit}};w.wait=async(_label,_seconds,fn)=>{const result=await fn();assert.equal(result,true);};await w.requestServiceSync();assert.deepEqual(requests,[]);assert(w.data.applicationsSyncedAt);
});
test('persist Secret before creating initial CI, and resume the same completed run',async()=>{
 const events=[];let run=null,secret=null;
 const kube={get:async p=>p.includes('/pipelineruns/')?run:p.includes('/secrets/')?secret:null,request:async(method,p,body)=>{
  events.push(method+' '+p);
  if(p.endsWith('/secrets')&&method==='POST'){secret={...body,metadata:{...body.metadata,uid:'secret-uid'},data:{'git-provider-token':'redacted'}};delete secret.stringData;return secret;}
  if(p.endsWith('/pipelineruns')){assert(secret?.data);run={...body,metadata:{...body.metadata,uid:'run-uid'},status:{conditions:[{type:'Succeeded',status:'True'}],results:[{name:'image-digest',value:digest}]}};return run;}
  if(method==='DELETE'){secret=null;return {};}
  if(method==='PUT'){secret=body;return secret;}
 }};
 const w=workflow(kube);w.github=async()=>({sha});w.buildToken=async()=>({token:'test-token',expires_at:new Date(Date.now()+3600000).toISOString()});w.wait=async(_l,_s,fn)=>{assert.equal(await fn(),true);};
 await w.build();assert.equal(w.data.imageDigest,digest);
 const posts=events.filter(e=>e.startsWith('POST'));assert.match(posts[0],/secrets$/);assert.match(posts[1],/pipelineruns$/);
 await w.build();assert.equal(events.filter(e=>e.startsWith('POST')).length,2,'Resume must not duplicate a completed build or Secret');
 assert(events.some(e=>e.startsWith('DELETE')),'Short-lived build credential is removed');
});
test('failed initial build cleans its owned credential Secret',async()=>{
 let secret,deleted=false;const kube={get:async p=>p.includes('/pipelineruns/')?null:p.includes('/secrets/')?secret:null,request:async(method,p,body)=>{if(p.endsWith('/secrets')&&method==='POST'){secret={...body,metadata:{...body.metadata,uid:'secret-uid'},data:{'git-provider-token':'redacted'}};return secret;}if(p.endsWith('/pipelineruns'))return {...body,metadata:{...body.metadata,uid:'run-uid'}};if(method==='PUT')return body;if(method==='DELETE'){deleted=true;secret=null;return {};}}};
 const w=workflow(kube);w.github=async()=>({sha});w.buildToken=async()=>({token:'test-token',expires_at:new Date(Date.now()+3600000).toISOString()});w.wait=async()=>{throw Error('build failed');};await assert.rejects(w.build(),/build failed/);assert.equal(deleted,true);
});
test('failed required checks never produce a merge; retry uses an identical tree',async()=>{
 const w=workflow();const pr={number:1,head:{sha,ref:'onboard/'+name},state:'open',body:'Box1 zero-touch onboarding '+id};w.data.onboardingPR={number:1,head:sha,validationRetries:2};w.verifyPR=async()=>{};
 let merged=false;
 w.github=async(p,method,body)=>{if(p.includes('/merge')){merged=true;return {};}
  if(p.endsWith('/pulls/1'))return pr;
  if(p.includes('/check-runs'))return {check_runs:[{id:1,name:'Pipelines as Code CI / box1-gitops-validate-',app:{slug:'box1-pipelines'},status:'completed',conclusion:'failure',html_url:'https://example/check'}]};
  throw new Error('Unexpected API '+p);
 };
 w.wait=async(_l,_s,fn)=>fn();await assert.rejects(w.merge('onboarding',pr,{}),/Required GitOps checks failed/);assert.equal(merged,false);
});
test('checks from another App cannot authorize the merge',async()=>{
 const w=workflow();w.data.onboardingPR={head:sha};w.verifyPR=async()=>{};let merged=false;
 w.github=async(p)=>{if(p.includes('/merge')){merged=true;return {};}
  if(p.endsWith('/pulls/1'))return {state:'open',head:{sha}};
  return {check_runs:['box1-phase1-smoke-','box1-gitops-validate-'].map((n,i)=>({id:i,name:'Pipelines as Code CI / '+n,app:{slug:'other-app'},status:'completed',conclusion:'success'}))};
 };
 w.wait=async(_l,_s,fn)=>{const observation=await fn();assert.equal(typeof observation,'string');throw Error('Required checks still pending');};
 await assert.rejects(w.merge('onboarding',{number:1,body:'Box1 zero-touch onboarding '+id},{}),/still pending/);assert.equal(merged,false);
});
test('fresh validation retries keep the exact GitOps tree and merge only the new checked SHA',async()=>{
 const w=workflow();let head=sha,merged=false,retried=false;
 const next='c'.repeat(40);const pr={number:1,state:'open',head:{sha,ref:'onboard/'+name},body:'Box1 zero-touch onboarding '+id};w.data.onboardingPR={number:1,head};w.verifyPR=async()=>{};
 w.github=async(p,method,body)=>{
  if(p.endsWith('/pulls/1'))return {...pr,head:{...pr.head,sha:head},merged,merge_commit_sha:'d'.repeat(40)};
  if(p.includes('/check-runs'))return {check_runs:['box1-phase1-smoke-','box1-gitops-validate-'].map((n,i)=>({id:i,name:'Pipelines as Code CI / '+n,app:{slug:'box1-pipelines'},status:'completed',conclusion:retried?'success':'failure'}))};
  if(p.includes('/git/commits/')&&method===undefined)return {tree:{sha:'original-tree'}};
  if(p.endsWith('/git/commits')&&method==='POST'){assert.equal(body.tree,'original-tree');retried=true;return {sha:next};}
  if(p.includes('/git/refs/')&&method==='PATCH'){head=body.sha;return {};}
  if(p.endsWith('/merge')){assert.equal(body.sha,next);merged=true;return {merged:true};}
  throw Error('Unexpected '+method+' '+p);
 };
 w.wait=async(_l,_s,fn)=>{assert.equal(typeof await fn(),'string');assert.equal(await fn(),true);};
 await w.merge('onboarding',pr,{});assert.equal(merged,true);assert.equal(w.data.phase,'ONBOARDING_MERGED');
});
test('Lease renewTime uses Kubernetes MicroTime precision',async()=>{
 let lease;
 const w=workflow({get:async()=>null,request:async(method,p,body)=>{lease=body;return body;}});
 await w.open();assert.match(lease.spec.renewTime,/\.\d{6}Z$/);assert.equal(lease.spec.leaseDurationSeconds,120);
});
const {ensureCatalog}=require('../plugins/box1-onboarding/workflow.cjs');
function catalogContext(){return {input:{name},logger:{info(){}},output(){},getInitiatorCredentials:async()=>({principal:{type:'service'}})};}
const ownedEntity={metadata:{annotations:{'github.com/project-slug':'box1-org/'+name}}};
test('catalog replay reuses the owned entity without adding another location',async()=>{
 let adds=0;await ensureCatalog({getEntityByRef:async()=>ownedEntity,addLocation:async()=>adds++},catalogContext());assert.equal(adds,0);
});
test('a pending duplicate catalog location is resolved without swallowing other errors',async()=>{
 let reads=0;await ensureCatalog({getEntityByRef:async()=>++reads===1?undefined:ownedEntity,addLocation:async()=>{const e=new Error('exists');e.statusCode=409;throw e;}},catalogContext());assert.equal(reads,2);
 await assert.rejects(ensureCatalog({getEntityByRef:async()=>undefined,addLocation:async()=>{const e=new Error('catalog unavailable');e.statusCode=503;throw e;}},catalogContext()),/catalog unavailable/);
});
test('catalog registration refuses an entity from another repository',async()=>{
 await assert.rejects(ensureCatalog({getEntityByRef:async()=>({metadata:{annotations:{'github.com/project-slug':'other/repository'}}})},catalogContext()),/another source repository/);
});
test('catalog submit records the location without waiting for entity processing',async()=>{
 const w=workflow();let reads=0,adds=0;w.ctx.getInitiatorCredentials=async()=>({principal:{type:'service'}});
 w.save=async(phase,extra={})=>{w.data={...w.data,...extra,phase};};
 w.catalogService={getEntityByRef:async()=>{reads++;return undefined;},addLocation:async({target})=>{adds++;assert.equal(target,'https://github.com/box1-org/orders-api/tree/main/catalog-info.yaml');}};
 await w.catalogSubmit();assert.equal(adds,1);assert.equal(reads,1);assert.equal(w.data.catalog.status,'submitted');
});
test('catalog failures keep provisioning incomplete and produce durable failure state',async()=>{
 const w=workflow();w.data={...w.data,phase:'DEPLOYMENT_READY',deploymentImage:'registry@'+digest,onboardingPR:{merged:true},promotionPR:{merged:true}};
 w.ctx.getInitiatorCredentials=async()=>({principal:{type:'service'}});w.open=async()=>{};w.close=async()=>{};
 w.catalogService={getEntityByRef:async()=>undefined,addLocation:async()=>{throw Error('catalog unavailable');}};
 await assert.rejects(w.run('registerCatalog'),/catalog unavailable/);assert.equal(w.data.phase,'FAILED');assert.equal(w.data.failedDuring,'CATALOG_SUBMITTING');
 w.catalogService={getEntityByRef:async()=>ownedEntity};await w.run('registerCatalog');assert.equal(w.data.phase,'COMPLETE');assert.equal(w.data.catalogEntityRef,'component:default/'+name);
});
test('new onboarding writes only to development workload repository',async()=>{
 const w=workflow();const files={['applications/'+name+'.yaml']:{content:'application',mode:'100644'}};
 const calls=[];let committed;
 w.content=async(repo)=>{assert.equal(repo,'box1-workloads-dev');return null;};
 w.commit=async(repo,parent,actual)=>{assert.equal(repo,'box1-workloads-dev');assert.equal(parent,sha);assert.deepEqual(actual,files);committed=true;return 'b'.repeat(40);};
 w.merge=async()=>{};
 w.github=async(p,method,body)=>{
  assert(p.startsWith('/repos/box1-org/box1-workloads-dev/'),'Unexpected repository: '+p);calls.push(p);
  if(p.includes('/pulls?'))return [];
  if(p.endsWith('/git/ref/heads/onboard/'+name))return null;
  if(p.endsWith('/git/ref/heads/main'))return {object:{sha}};
  if(p.endsWith('/git/refs')){assert(committed);return {};}
  if(p.endsWith('/pulls')&&method==='POST')return {number:1,html_url:'https://github.com/box1-org/box1-workloads-dev/pull/1',head:{sha:'b'.repeat(40)}};
  throw Error('Unexpected '+p);
 };
 await w.pullRequest('onboarding',files);assert(calls.length>=4);assert.match(w.data.onboardingPR.url,/box1-workloads-dev/);
});
test('ConfigMap state conflicts are surfaced without overwriting newer state',async()=>{
 const latest={metadata:{resourceVersion:'9'},data:{'status.json':JSON.stringify({id,onboardingId:id,phase:'BUILD_RUNNING',phaseStatus:'running'})}};
 const kube={get:async()=>latest,request:async()=>{const e=new Error('conflict');e.status=409;throw e;}};
 const w=workflow(kube);w.save=Workflow.prototype.save.bind(w);w.cm={metadata:{resourceVersion:'8'}};await assert.rejects(w.save('PLATFORM_READY'),error=>error.code==='ONBOARDING_STATE_CONFLICT');assert.equal(w.data.phase,'BUILD_RUNNING');assert.equal(w.cm.metadata.resourceVersion,'9');
});
test('wait persists an explicit waiting phase status',async()=>{
 const w=workflow();const saves=[];w.save=async(phase,extra)=>saves.push({phase,...extra});w.renew=async()=>{};await assert.rejects(w.wait('registry_permission',0,async()=>false),/Timed out waiting/);assert.equal(saves[0].phaseStatus,'waiting');assert.equal(saves[0].waitCondition,'registry_permission');
});

// A fake API server that rejects stale resourceVersions, as Kubernetes does.
function versionedKube(objects={}){
 const store=new Map(Object.entries(objects)),writes=[];
 const key=p=>p.replace(/\/configmaps$/,'/configmaps/box1-onboard-'+name);
 return {store,writes,get:async p=>store.get(key(p))??null,request:async(method,p,body)=>{
  await new Promise(resolve=>setTimeout(resolve,2));
  if(method==='PATCH'){writes.push({method,p,status:200});return store.get(p);}
  const current=store.get(key(p)),sent=body.metadata?.resourceVersion;
  if(current&&sent!==current.metadata.resourceVersion){writes.push({method,p,status:409});const e=new Error('conflict');e.status=409;throw e;}
  const saved={...body,metadata:{...body.metadata,resourceVersion:String(Number(current?.metadata.resourceVersion||0)+1)}};
  store.set(key(p),saved);writes.push({method,p,status:200});return saved;
 }};
}
function realState(w,kube){w.save=Workflow.prototype.save.bind(w);w.wait=Workflow.prototype.wait.bind(w);w.cm=kube.store.get('/api/v1/namespaces/rhdh/configmaps/box1-onboard-'+name);return w;}
const stateRecord=()=>({'/api/v1/namespaces/rhdh/configmaps/box1-onboard-orders-api':{metadata:{resourceVersion:'1'},data:{'status.json':'{}'}}});
test('parallel waits serialize state writes against a resourceVersion-enforcing API',async()=>{
 const kube=versionedKube(stateRecord());const w=realState(workflow(kube),kube);w.data.phase='ONBOARDING_MERGED';
 await Promise.all([w.wait('platform readiness',1,async()=>true),w.wait('build prerequisites',1,async()=>true)]);
 assert.deepEqual(kube.writes.map(item=>item.status),[200,200]);assert.equal(w.cm.metadata.resourceVersion,'3');assert.equal(w.data.phase,'ONBOARDING_MERGED');
 assert.deepEqual(w.data.activeWaits,['platform readiness','build prerequisites']);
});
test('a waiting save during a build does not move the phase back',async()=>{
 const kube=versionedKube(stateRecord());const w=realState(workflow(kube),kube);w.data.phase='ONBOARDING_MERGED';
 await Promise.all([w.save('BUILD_RUNNING',{pipelineName:'run'}),w.wait('platform readiness',1,async()=>true)]);
 assert.equal(w.data.phase,'BUILD_RUNNING');assert.equal(w.data.phaseStatus,'waiting');
});
test('a real state conflict from another process still surfaces after serialization',async()=>{
 const kube=versionedKube(stateRecord());const w=realState(workflow(kube),kube);w.cm={metadata:{resourceVersion:'0'}};
 await assert.rejects(w.save('PLATFORM_READY'),error=>error.code==='ONBOARDING_STATE_CONFLICT');
});
test('concurrent waits share one Lease renewal',async()=>{
 const leasePath='/apis/coordination.k8s.io/v1/namespaces/rhdh/leases/box1-onboard-orders-api';
 const w0=workflow();const kube=versionedKube({[leasePath]:{metadata:{resourceVersion:'1'},spec:{holderIdentity:w0.holder}}});w0.kube=kube;
 const w=w0;w.renew=Workflow.prototype.renew.bind(w);
 await Promise.all([w.renew(),w.renew(),w.renew()]);assert.deepEqual(kube.writes.map(item=>item.status),[200]);
 await w.renew();assert.deepEqual(kube.writes.map(item=>item.status),[200,200]);
});
const mergeCommit='c'.repeat(40);
const argoApp=(sync,revision=mergeCommit,operation={phase:'Succeeded',startedAt:new Date(Date.now()-600000).toISOString()})=>({metadata:{},spec:{source:{repoURL:'https://github.com/box1-org/box1-workloads-dev.git'}},status:{sync:{status:sync,revision},health:{status:'Healthy'},operationState:operation}});
test('an out-of-sync Application with no active operation gets an explicit sync request',async()=>{
 const patches=[];const w=workflow({get:async()=>argoApp('OutOfSync','d'.repeat(40)),request:async(method,p,body)=>{patches.push({method,p,body});return {};}});
 w.wait=async(label,_seconds,fn)=>{assert.equal(await fn(),true,label);};
 assert.equal(typeof await w.requestApplicationSync(name,mergeCommit,name),'number');
 assert.equal(patches.length,1);assert.equal(patches[0].method,'PATCH');assert.equal(patches[0].body.operation.sync.revision,mergeCommit);
});
test('a sync request waits for an active Argo operation and refuses a failed one',async()=>{
 const results=[];const running=workflow({get:async()=>argoApp('OutOfSync','d'.repeat(40),{phase:'Running'})});
 running.wait=async(_label,_seconds,fn)=>{results.push(await fn());throw new Error('stop');};
 await assert.rejects(running.requestApplicationSync(name,mergeCommit,name),/stop/);assert.match(results[0],/active Argo operation/);
 const failed=workflow({get:async()=>argoApp('OutOfSync','d'.repeat(40),{phase:'Failed',message:'hook failed'})});
 failed.wait=async(_label,_seconds,fn)=>fn();await assert.rejects(failed.requestApplicationSync(name,mergeCommit,name),/hook failed/);
});
test('platform stops at the build boundary and a restart does not repeat the sync request',async()=>{
 let patches=0;const kube={get:async p=>p.endsWith('/box1-workloads-dev')?argoApp('Synced'):argoApp('OutOfSync','d'.repeat(40)),request:async method=>{assert.equal(method,'PATCH');patches++;return {};}};
 const w=workflow(kube);const labels=[];w.data={...w.data,onboardingPR:{merged:true,mergeCommit}};w.wait=async(label,_seconds,fn)=>{labels.push(label);await fn();};w.buildBarrier=async()=>labels.push('barrier');
 await w.platform();
 assert.equal(patches,1);assert(w.data.serviceSyncRequestedAt);assert.equal(w.data.applicationsSyncedAt,undefined);assert.equal(labels.at(-1),'barrier');
 assert(!labels.some(label=>label.includes('readiness')||label.includes('requested Argo sync')));
 await w.platform();assert.equal(patches,1);
});
test('awaitServiceSync honours the persisted request time after a restart',async()=>{
 const requested=Date.now()-60000;const w=workflow({get:async()=>argoApp('Synced',mergeCommit,{phase:'Succeeded',startedAt:new Date(requested+1000).toISOString()})});
 w.data={...w.data,onboardingPR:{merged:true,mergeCommit},serviceSyncRequestedAt:new Date(requested).toISOString()};w.wait=async(_label,_seconds,fn)=>{assert.equal(await fn(),true);};
 await w.awaitServiceSync();assert(w.data.applicationsSyncedAt);
 const stale=workflow({get:async()=>argoApp('Synced',mergeCommit)});stale.data={...w.data,applicationsSyncedAt:undefined};let result;stale.wait=async(_label,_seconds,fn)=>{result=await fn();};
 await stale.awaitServiceSync();assert.notEqual(result,true);
});
test('the build overlaps platform readiness, which is recorded once both finish',async()=>{
 const w=workflow();const events=[];w.data.history=[];
 w.build=async()=>{events.push('build-start');await new Promise(resolve=>setTimeout(resolve,5));events.push('build-done');await w.save('IMAGE_BUILT',{imageDigest:digest});};
 w.completePlatform=async()=>{events.push('platform-start');await new Promise(resolve=>setTimeout(resolve,1));events.push('platform-done');};
 const saved=[];const save=w.save;w.save=async(phase,extra)=>{saved.push(phase);await save(phase,extra);};
 await w.buildPhase();
 assert(events.indexOf('build-start')<events.indexOf('platform-done'));assert(events.indexOf('platform-start')<events.indexOf('build-done'));assert.deepEqual(saved,['IMAGE_BUILT','PLATFORM_READY']);
});
test('a build failure stops platform observers and reports the build error',async()=>{
 const w=workflow({get:async()=>null});w.data.applicationsSyncedAt='now';w.build=async()=>{await new Promise(resolve=>setTimeout(resolve,5));throw new Error('Initial build failed');};w.wait=Workflow.prototype.wait.bind(w);
 const started=Date.now();await assert.rejects(w.buildPhase(),/Initial build failed/);assert(Date.now()-started<1000,'observers should not keep polling');assert.equal(w.activeWaits.size,0);assert.equal(w.data.phase,undefined);
});
test('a platform failure lets the build finish, keeps its digest, and a retry does not rebuild',async()=>{
 const w=workflow();let builds=0,finished=false;w.data.history=[];
 w.build=async()=>{builds++;await new Promise(resolve=>setTimeout(resolve,5));finished=true;await w.save('IMAGE_BUILT',{imageDigest:digest});};
 w.completePlatform=async()=>{throw new Error('Argo sync failed');};
 await assert.rejects(w.buildPhase(),/Argo sync failed/);assert.equal(finished,true);assert.equal(w.data.imageDigest,digest);
 w.completePlatform=async()=>{};await w.buildPhase();assert.equal(builds,1);assert.equal(w.data.phase,'PLATFORM_READY');
});
test('promotion refuses to start before platform readiness completes',async()=>{
 const w=workflow();w.gitopsFiles=async()=>({});w.data.imageDigest=digest;await assert.rejects(w.promote(),/Platform readiness has not completed/);
});
test('the compatibility wrapper runs exactly the template phases in order',async()=>{
 const w=workflow();const events=[];for(const phase of DELIVERY_PHASES)w[phase]=async()=>events.push(phase);await w.delivery();assert.deepEqual(events,DELIVERY_PHASES);
 const template=YAML.parse(await fs.readFile(path.resolve(__dirname,'../templates/quarkus-rest-service/template.yaml'),'utf8'));
 const actions=template.spec.steps.map(step=>step.action);
 const phaseActions=actions.filter(action=>action.startsWith('box1:development:'));
 const registered=await fs.readFile(path.resolve(__dirname,'../plugins/box1-onboarding/index.cjs'),'utf8');
 const operationFor=action=>registered.match(new RegExp(`action\\('${action}','([a-zA-Z]+)'`))?.[1];
 assert.deepEqual(phaseActions.map(operationFor),DELIVERY_PHASES);
 for(const action of actions.filter(item=>item.startsWith('box1:')))assert(registered.includes(`'${action}'`),'Unregistered action '+action);
 assert(actions.indexOf('box1:catalog:submit')<actions.indexOf('box1:development:provision'));assert.equal(actions.at(-1),'box1:catalog:verify');
 assert.equal(operationFor('box1:development:onboard'),'delivery');
});
test('the wrapper completes against a resourceVersion-enforcing API with real state and Lease writes',async()=>{
 const ci='/api/v1/namespaces/box1-ci/serviceaccounts/',rbac='/apis/rbac.authorization.k8s.io/v1/namespaces/',apps='/apis/argoproj.io/v1alpha1/namespaces/openshift-gitops/applications/';
 const observer={metadata:{name:name+'-release-observer'},roleRef:{name:name+'-release-observer'},subjects:[{name:'ci-observe',namespace:'box1-ci'}]};
 const w=workflow();
 const objects={...stateRecord(),
  '/apis/coordination.k8s.io/v1/namespaces/rhdh/leases/box1-onboard-orders-api':{metadata:{resourceVersion:'1'},spec:{holderIdentity:w.holder}},
  ['/api/v1/namespaces/'+name+'-dev']:{status:{phase:'Active'}},
  [`/api/v1/namespaces/${name}-dev/serviceaccounts/${name}`]:{},[ci+'ci-build']:{},[ci+'ci-gitops']:{},[ci+'ci-observe']:{},
  [`${rbac}box1-ci/rolebindings/ci-build-image-builder`]:{roleRef:{name:'system:image-builder'},subjects:[{name:'ci-build',namespace:'box1-ci'}]},
  [`${rbac}box1-ci/rolebindings/${name}-image-puller`]:{roleRef:{name:'system:image-puller'},subjects:[{name,namespace:name+'-dev'}]},
  [`${rbac}${name}-dev/roles/${name}-release-observer`]:observer,[`${rbac}${name}-dev/rolebindings/${name}-release-observer`]:observer,
  [`${rbac}openshift-gitops/roles/${name}-release-observer`]:observer,[`${rbac}openshift-gitops/rolebindings/${name}-release-observer`]:observer,
  [`/apis/pipelinesascode.tekton.dev/v1alpha1/namespaces/box1-ci/repositories/${name}`]:{spec:{url:`https://github.com/box1-org/${name}`}},
  [`/apis/apps/v1/namespaces/${name}-dev/deployments/${name}`]:{},
  [apps+'box1-workloads-dev']:argoApp('Synced'),[apps+name]:{...argoApp('Synced'),spec:{...argoApp('Synced').spec,destination:{namespace:name+'-dev'}}},
 };
 const kube=versionedKube(objects);w.kube=kube;realState(w,kube);w.renew=Workflow.prototype.renew.bind(w);
 w.data={...w.data,phase:'ONBOARDING_MERGED',history:[],onboardingPR:{merged:true,mergeCommit}};
 const order=[];w.provision=async()=>order.push('provision');w.promote=async()=>order.push('promote');w.verify=async()=>order.push('verify');
 w.build=async()=>{await w.save('BUILD_RUNNING',{pipelineName:'run'});await w.wait('initial CI build run',1,async()=>true);await w.save('IMAGE_BUILT',{imageDigest:digest});};
 await w.delivery();
 assert.deepEqual(order,['provision','promote','verify']);assert.equal(w.data.imageDigest,digest);assert(w.platformComplete());
 assert.deepEqual(kube.writes.filter(item=>item.status!==200),[],'no write may conflict');
});

const promotionCommit='e'.repeat(40);
function promotedWorkflow(appState){
 const patches=[];const w=workflow({get:async()=>appState(),request:async(method,p,body)=>{assert.equal(method,'PATCH');patches.push({p,body});return {};}});
 w.gitopsFiles=async()=>({});w.wait=async(label,_seconds,fn)=>{assert.equal(await fn(),true,label);};
 w.data={...w.data,imageDigest:digest,history:[{phase:'PLATFORM_READY'}],promotionPR:{merged:true,mergeCommit:promotionCommit}};
 return {w,patches};
}
test('promotion requests a sync when Argo still reports Synced at the previous revision',async()=>{
 const {w,patches}=promotedWorkflow(()=>argoApp('Synced',mergeCommit));
 await w.promote();
 assert.equal(patches.length,1);assert(patches[0].p.endsWith('/applications/orders-api'));assert.equal(patches[0].body.operation.sync.revision,promotionCommit);
 assert.equal(w.data.promotionSync.revision,promotionCommit);assert(w.data.promotionSync.requestedAt);assert.equal(w.data.phase,'PROMOTION_SYNC_REQUESTED');
});
test('promotion requests its sync after the PR merges, and a retry does not repeat it',async()=>{
 const {w,patches}=promotedWorkflow(()=>argoApp('Synced',mergeCommit));const events=[];
 w.data.promotionPR=undefined;w.content=async()=>null;w.pullRequest=async stage=>{events.push(stage+':'+patches.length);w.data.promotionPR={merged:true,mergeCommit:promotionCommit};};
 const kustomization=`workloads/${name}/kustomization.yaml`,deployment=`workloads/${name}/deployment.yaml`;
 const files={[kustomization]:{content:'digest: sha256:'+'0'.repeat(64)},[deployment]:{content:'  replicas: 0\n    box1.org/source-revision: '+sha}};
 w.gitopsFiles=async()=>files;w.content=async(_repo,file)=>files[file].content;
 await w.promote();assert.deepEqual(events,['promotion:0']);assert.equal(patches.length,1);
 await w.promote();assert.deepEqual(events,['promotion:0']);assert.equal(patches.length,1);
});
test('a restart between the promotion merge and the sync request still requests the sync',async()=>{
 const {w,patches}=promotedWorkflow(()=>argoApp('OutOfSync',mergeCommit));let merges=0;w.pullRequest=async()=>{merges++;};
 await w.promote();assert.equal(merges,0);assert.equal(patches.length,1);
});
test('promotion records an Application already at the merged revision without a sync request',async()=>{
 const {w,patches}=promotedWorkflow(()=>argoApp('Synced',promotionCommit));
 await w.promote();assert.equal(patches.length,0);assert.deepEqual(w.data.promotionSync,{revision:promotionCommit,requestedAt:null});
});
test('verify fails at once when the requested promotion sync fails, but ignores an older failure',async()=>{
 const requestedAt=new Date().toISOString();
 const failedAt=at=>({...argoApp('OutOfSync',mergeCommit,{phase:'Failed',startedAt:at,message:'hook failed'})});
 const verifying=app=>{const w=workflow({get:async p=>p.includes('/applications/')?app:null});w.data={...w.data,imageDigest:digest,promotionSync:{revision:promotionCommit,requestedAt}};return w;};
 const current=verifying(failedAt(requestedAt));current.wait=async(_label,_seconds,fn)=>fn();
 await assert.rejects(current.verify(),/hook failed/);
 const older=verifying(failedAt(new Date(Date.now()-3600000).toISOString()));let observed;older.wait=async(_label,_seconds,fn)=>{observed=await fn();throw new Error('stop');};
 await assert.rejects(older.verify(),/stop/);assert.equal(observed,'Argo CD Synced and Healthy');
});
