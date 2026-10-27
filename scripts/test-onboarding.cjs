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
test('a concurrent task cannot acquire an unexpired service lease',async()=>{
 const w=workflow({get:async()=>({spec:{holderIdentity:'other',renewTime:new Date().toISOString(),leaseDurationSeconds:120}})});
 await assert.rejects(w.open(),/Another onboarding task/);
});
test('readiness gates do not advance while namespace or permissions are missing',async()=>{
 const w=workflow({get:async()=>null});let observed;
 w.wait=async(label,seconds,fn)=>{observed=await fn();throw new Error('pending readiness');};
 await assert.rejects(w.platformReady(),/pending readiness/);assert.match(observed,/Namespace Active/);assert.notEqual(w.data.phase,'PLATFORM_READY');
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
test('catalog failures keep provisioning incomplete and produce durable failure state',async()=>{
 const w=workflow();w.data={...w.data,phase:'DEPLOYMENT_READY',deploymentImage:'registry@'+digest,onboardingPR:{merged:true},promotionPR:{merged:true}};
 w.ctx.getInitiatorCredentials=async()=>({principal:{type:'service'}});w.open=async()=>{};w.close=async()=>{};
 w.catalogService={getEntityByRef:async()=>undefined,addLocation:async()=>{throw Error('catalog unavailable');}};
 await assert.rejects(w.run('registerCatalog'),/catalog unavailable/);assert.equal(w.data.phase,'FAILED');assert.equal(w.data.failedDuring,'CATALOG_REGISTERING');
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
