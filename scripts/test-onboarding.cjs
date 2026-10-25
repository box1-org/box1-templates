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
