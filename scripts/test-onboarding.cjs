// Retired historical fixture: these names validate rejection of previously used demo identifiers.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const YAML=require('yaml');
const {Workflow,validateName,validateBundle,filesAt}=require('../plugins/box1-onboarding/workflow.cjs');
const name='orders-api',id='9ae74f64-b93b-4d70-a6fe-4a223436b6f0',sha='a'.repeat(40),digest='sha256:'+'b'.repeat(64);
function workflow(kube={}){const outputs={};const w=new Workflow({ctx:{input:{name,sourceRevision:sha},workspacePath:'unused',logger:{info(){}},output:(k,v)=>outputs[k]=v},config:{},credentials:{},kube});w.data={id,name,namespace:name+'-dev',sourceRevision:sha};w.renew=async()=>{};w.save=async(phase,extra={})=>{w.data={...w.data,...extra,phase};};return w;}
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
 w.data={...w.data,applicationsSyncedAt:'now',history:[{phase:'PLATFORM_READY'}]};w.syncNewServiceApplications=async()=>{calls++;};w.platformReady=async()=>{calls++;};await w.platform();assert.equal(calls,0);
 w.data.imageDigest=digest;w.build=async()=>{calls++;};await w.buildPhase();assert.equal(calls,0);
 w.data.promotionPR={merged:true};await w.promote();assert.equal(calls,0);
});
test('restart after onboarding PR creation validates and resumes the existing PR',async()=>{
 const w=workflow();let merged=0;const pr={number:7,head:{sha,ref:'onboard/'+name},merged_at:null};
 w.data.onboardingPR={number:7,head:sha};w.github=async p=>p.endsWith('/pulls/7')?pr:{};w.verifyPR=async()=>{};w.wait=async(_l,_s,fn)=>{await fn();};w.merge=async()=>{merged++;};
 await w.pullRequest('onboarding',{});assert.equal(merged,1);assert.equal(w.data.onboardingPR.number,7);
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
test('delivery starts readiness observation before the initial build completes',async()=>{
 const w=workflow();const events=[];w.provision=async()=>events.push('provision');w.syncNewServiceApplications=async()=>events.push('sync');w.platformReady=async()=>{events.push('readiness-start');await new Promise(resolve=>setTimeout(resolve,1));events.push('readiness-done');};w.buildBarrier=async()=>events.push('barrier');w.buildPhase=async()=>{events.push('build-start');await new Promise(resolve=>setTimeout(resolve,3));events.push('build-done');};w.promote=async()=>events.push('promote');w.verify=async()=>events.push('verify');w.data={...w.data};await w.delivery();assert(events.indexOf('readiness-start')<events.indexOf('build-done'));assert(events.indexOf('build-start')<events.indexOf('readiness-done'));
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
 await w.syncNewServiceApplications();
 assert.deepEqual(requests.map(r=>r.p),['/apis/argoproj.io/v1alpha1/namespaces/openshift-gitops/applications/box1-workloads-dev','/apis/argoproj.io/v1alpha1/namespaces/openshift-gitops/applications/orders-api']);
 assert(requests.every(r=>r.body.operation.initiatedBy.username==='box1-rhdh'));
 assert(requests.every(r=>r.body.operation.sync.revision===mergeCommit));
});
test('existing healthy service Application skips a duplicate sync request',async()=>{
 const mergeCommit='c'.repeat(40),requests=[];const app=(name)=>({spec:{source:{repoURL:'https://github.com/box1-org/box1-workloads-dev.git',path:'workloads/'+name}},status:{sync:{status:'Synced',revision:mergeCommit},health:{status:'Healthy'},operationState:{phase:'Succeeded'}}});
 const kube={get:async p=>p.endsWith('/box1-workloads-dev')?app('box1-workloads-dev'):app(name),request:async()=>{requests.push('PATCH');return {};}};
 const w=workflow(kube);w.data={...w.data,onboardingPR:{merged:true,mergeCommit}};w.wait=async(_label,_seconds,fn)=>{const result=await fn();assert.equal(result,true);};await w.syncNewServiceApplications();assert.deepEqual(requests,[]);assert(w.data.applicationsSyncedAt);
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
 const w=workflow();const pr={number:1,head:{sha,ref:'onboard/'+name},state:'open'};w.data.onboardingPR={number:1,head:sha,validationRetries:2};w.verifyPR=async()=>{};
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
 await assert.rejects(w.merge('onboarding',{number:1},{}),/still pending/);assert.equal(merged,false);
});
test('fresh validation retries keep the exact GitOps tree and merge only the new checked SHA',async()=>{
 const w=workflow();let head=sha,merged=false,retried=false;
 const next='c'.repeat(40);const pr={number:1,state:'open',head:{sha,ref:'onboard/'+name}};w.data.onboardingPR={number:1,head};w.verifyPR=async()=>{};
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
