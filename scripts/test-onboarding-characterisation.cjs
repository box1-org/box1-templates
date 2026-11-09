// Characterisation test for the onboarding profiles (box1-docs#136).
//
// It records what the `service` and `virtual-machine` profiles actually do through the
// Workflow's public phase methods and compares the result with
// scripts/fixtures/onboarding-profiles-characterisation.json, which was generated from
// plugin 1.2.0 (box1-templates main 5663eb3) BEFORE the profile dispatch refactor.
// The fixture must not be regenerated to make a refactor pass: a difference means a
// service or VM output changed.
//
// Recorded per profile: the REQUESTED record and repository marker as persisted, the
// skeleton commit, the validated bundle, the onboarding and promotion PR files, the
// build-barrier and platform-readiness observations, the PipelineRun and its stored
// results, the verify sequence and outputs, catalog completion without a profile input,
// resume behaviour after PLATFORM_READY and IMAGE_BUILT, and the registered action
// schemas. Run after `npm run validate`, which renders the bundles under .validation/.
//
// Regenerate (only when a behaviour change is intended and reviewed):
//   UPDATE_CHARACTERISATION=1 node --test scripts/test-onboarding-characterisation.cjs
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const fss=require('node:fs');const os=require('node:os');const path=require('node:path');
const crypto=require('node:crypto');const Module=require('node:module');
const {Workflow,filesAt}=require('../plugins/box1-onboarding/workflow.cjs');

const FIXTURE=path.resolve(__dirname,'fixtures/onboarding-profiles-characterisation.json');
const ROOT=path.resolve(__dirname,'..');
const PROFILES_UNDER_TEST={
  service:{input:undefined,name:'orders-api',sha:'a'.repeat(40),render:'.validation/orders-api'},
  'virtual-machine':{input:'virtual-machine',name:'vm-golden-check',sha:'b'.repeat(40),render:'.validation/rhel-image-vm/vm-golden-check'},
};
const IMAGE='sha256:'+'1'.repeat(64),DISK='sha256:'+'2'.repeat(64),MERGE='c'.repeat(40),HEAD='d'.repeat(40),NEWSRC='e'.repeat(40);

// ---- deterministic environment --------------------------------------------------
let uuidCounter=0;
crypto.randomUUID=()=>`00000000-0000-4000-8000-${String(++uuidCounter).padStart(12,'0')}`;
const TIME=/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g;
const norm=value=>JSON.parse(JSON.stringify(value??null).replace(TIME,'<time>'));
const sha256=text=>crypto.createHash('sha256').update(text).digest('hex');
const fileDigest=files=>Object.fromEntries(Object.keys(files).sort().map(p=>[p,{mode:files[p].mode,sha256:sha256(files[p].content)}]));
async function outcome(fn){try{const value=await fn();return {ok:true,...(value===undefined?{}:{value:norm(value)})};}catch(error){return {error:error.message};}}

async function workspace(spec){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'box1-char-'));
  await fs.cp(path.join(ROOT,spec.render,'gitops'),path.join(dir,'gitops'),{recursive:true});
  await fs.cp(path.join(ROOT,spec.render,'application'),path.join(dir,'application'),{recursive:true});
  return dir;
}

// A Kubernetes double that answers every readiness and build-barrier resource as ready
// (or missing when `empty`), stores ConfigMaps like the API server and logs every call.
function world(spec,{empty=false}={}){
  const {name}=spec,ns=name+'-dev',calls=[],configmaps={};
  const ready={
    ['/api/v1/namespaces/'+ns]:{status:{phase:'Active'}},
    '/apis/rbac.authorization.k8s.io/v1/namespaces/box1-ci/rolebindings/ci-build-image-builder':{roleRef:{name:'system:image-builder'},subjects:[{name:'ci-build',namespace:'box1-ci'}]},
    '/apis/rbac.authorization.k8s.io/v1/namespaces/box1-ci/rolebindings/ci-bootc-release-image-builder':{roleRef:{name:'system:image-builder'},subjects:[{name:'ci-bootc-release',namespace:'box1-ci'}]},
    '/apis/rbac.authorization.k8s.io/v1/namespaces/box1-ci/rolebindings/ci-bootc-privileged-scc':{roleRef:{name:'system:openshift:scc:privileged'},subjects:[{name:'ci-bootc-release',namespace:'box1-ci'}]},
    [`/apis/rbac.authorization.k8s.io/v1/namespaces/box1-ci/rolebindings/${name}-image-puller`]:{roleRef:{name:'system:image-puller'},subjects:[{kind:'ServiceAccount',name,namespace:ns},{kind:'Group',name:'system:serviceaccounts:'+ns}]},
    ['/apis/pipelinesascode.tekton.dev/v1alpha1/namespaces/box1-ci/repositories/'+name]:{spec:{url:'https://github.com/box1-org/'+name}},
    ['/apis/argoproj.io/v1alpha1/namespaces/openshift-gitops/applications/'+name]:{spec:{destination:{namespace:ns}},status:{sync:{status:'Synced'}}},
    [`/apis/apps/v1/namespaces/${ns}/deployments/${name}`]:{},
    [`/apis/kubevirt.io/v1/namespaces/${ns}/virtualmachines/${name}`]:{},
  };
  for(const n of [ns,'openshift-gitops']){
    ready[`/apis/rbac.authorization.k8s.io/v1/namespaces/${n}/roles/${name}-release-observer`]={metadata:{name:name+'-release-observer'}};
    ready[`/apis/rbac.authorization.k8s.io/v1/namespaces/${n}/rolebindings/${name}-release-observer`]={roleRef:{name:name+'-release-observer'},subjects:[{name:'ci-observe',namespace:'box1-ci'}]};
  }
  const kube={calls,configmaps,
    async get(p){calls.push('GET '+p);if(p.includes('/configmaps/'))return configmaps[p.split('/').pop()]??null;if(empty)return null;if(p.includes('/serviceaccounts/'))return {};return structuredClone(ready[p]??null);},
    async request(method,p,body){calls.push(method+' '+p);
      if(p.includes('/configmaps')){const stored={...body,metadata:{...body.metadata,resourceVersion:String(calls.length)}};configmaps[body.metadata.name]=stored;(kube.records??=[]).push(body.data['status.json']);return stored;}
      if(kube.handle)return kube.handle(method,p,body);
      return {};
    }};
  return kube;
}

function make(profileKey,{kube,input={},data,catalog}={}){
  const spec=PROFILES_UNDER_TEST[profileKey];const outputs={};
  const ctx={input:{name:spec.name,sourceRevision:spec.sha,...(spec.input?{profile:spec.input}:{}),...input},workspacePath:spec.ws,logger:{info(){}},output:(k,v)=>{outputs[k]=v;},getInitiatorCredentials:async()=>({token:'initiator'})};
  const w=new Workflow({ctx,config:{},credentials:{},kube:kube||world(spec),catalog});
  w.outputs=outputs;w.renew=async()=>{};
  if(data!==undefined)w.data=data;
  return w;
}
const baseData=(profileKey,extra={})=>{const s=PROFILES_UNDER_TEST[profileKey];return {schemaVersion:2,id:'11111111-1111-4111-8111-111111111111',onboardingId:'11111111-1111-4111-8111-111111111111',name:s.name,namespace:s.name+'-dev',owner:'user:default/mike',visibility:'private',description:'Characterisation',templateVersion:'x',...(s.input?{profile:s.input}:{}),sourceRevision:s.sha,sourceUrl:'https://github.com/box1-org/'+s.name,phase:'REPOSITORY_READY',history:[{phase:'REPOSITORY_READY',at:'2026-11-08T00:00:00.000Z'}],...extra};};
// Records each wait label and observation; `step(i)` may change the world between observations.
function driveWaits(w,{max=6,step=()=>{}}={}){
  const waits=[];
  w.wait=async(label,seconds,observe)=>{const seen=[];waits.push({label,seconds,seen});for(let i=0;i<max;i++){const r=await observe();seen.push(norm(r));if(r===true||r?.done)return r?.value;await step(i,label);}throw new Error('wait did not finish: '+label);};
  return waits;
}

// ---- scenarios ---------------------------------------------------------------
async function recordAndMarker(profileKey){
  const spec=PROFILES_UNDER_TEST[profileKey];const kube=world(spec);
  const w=make(profileKey,{kube,input:{owner:'user:default/mike',visibility:'private',description:'Characterisation run'}});
  w.data=null;const github=[];let marker,markerSha,commitMessage,blobs=[];
  w.github=async(p,method='GET',body,options={})=>{
    github.push(`${method} ${p}`);
    if(p===`/repos/box1-org/${spec.name}`&&method==='GET')return options.missing?null:{};
    if(p==='/orgs/box1-org/repos')return {description:body.description,size:0};
    if(p.startsWith(`/repos/box1-org/${spec.name}/contents/.box1/onboarding.json`)&&method==='GET')return null;
    if(p.endsWith('/contents/.box1/onboarding.json')&&method==='PUT'){marker=Buffer.from(body.content,'base64').toString();markerSha=crypto.createHash('sha1').update(`blob ${Buffer.byteLength(marker)}\0`).update(marker).digest('hex');return {};}
    if(p.endsWith('/git/ref/heads/main'))return {object:{sha:HEAD}};
    if(p.endsWith('/git/commits/'+HEAD))return {tree:{sha:'tree-0'}};
    if(p.includes('/git/trees/tree-0'))return {truncated:false,tree:[{type:'blob',path:'.box1/onboarding.json',sha:markerSha}]};
    if(p.endsWith('/git/blobs')){const sha=sha256(body.content);return {sha};}
    if(p.endsWith('/git/trees')&&method==='POST'){blobs=body.tree.map(e=>`${e.mode} ${e.path} ${e.sha}`).sort();return {sha:'tree-1'};}
    if(p.endsWith('/git/commits')&&method==='POST'){commitMessage=body.message;return {sha:NEWSRC};}
    return {};
  };
  const result=await outcome(()=>w.repository());
  return {result,requestedRecord:kube.records[0].replace(TIME,'<time>'),marker,commitMessage,skeleton:{entries:blobs.length,sha256:sha256(blobs.join('\n'))},github,finalRecord:norm(w.data),outputs:norm(w.outputs)};
}
async function bundle(profileKey){
  const w=make(profileKey,{data:baseData(profileKey)});
  const files=await w.gitopsFiles();const raw=await filesAt(path.join(PROFILES_UNDER_TEST[profileKey].ws,'gitops'));
  return {files:fileDigest(files),returnsInputUnchanged:JSON.stringify(files)===JSON.stringify(raw)};
}
async function crossBundle(profileKey){
  const other=profileKey==='service'?'virtual-machine':'service';
  const w=make(profileKey,{data:baseData(profileKey)});w.ctx.workspacePath=PROFILES_UNDER_TEST[other].ws;
  return outcome(()=>w.gitopsFiles());
}
async function onboardingPR(profileKey){
  const w=make(profileKey,{data:baseData(profileKey)});const prs=[];
  w.pullRequest=async(stage,files)=>{prs.push({stage,files:fileDigest(files)});};
  const first=await outcome(()=>w.provision());
  w.data.onboardingPR={merged:true,mergeCommit:MERGE};const resumed=prs.length;await w.provision();
  return {first,prs,callsAfterMerged:prs.length-resumed};
}
async function platform(profileKey){
  const spec=PROFILES_UNDER_TEST[profileKey];const out={};
  for(const [label,empty] of [['missing',true],['ready',false]]){
    const kube=world(spec,{empty});const w=make(profileKey,{kube,data:baseData(profileKey,{onboardingPR:{merged:true,mergeCommit:MERGE},applicationsSyncedAt:'2026-11-08T00:00:00.000Z'})});
    const waits=driveWaits(w,{max:1});
    const barrier=await outcome(()=>w.platform());
    const readiness=await outcome(()=>w.platformReady());
    out[label]={barrier,readiness,waits,conditions:norm(w.data.readiness?.conditions),conditionKeys:Object.keys(w.data.readiness?.conditions||{}),kubeReads:[...new Set(kube.calls)].sort()};
  }
  return out;
}
async function resume(profileKey){
  const spec=PROFILES_UNDER_TEST[profileKey];const out={};
  // After IMAGE_BUILT and PLATFORM_READY nothing in platform or build runs again.
  {const kube=world(spec);const w=make(profileKey,{kube,data:baseData(profileKey,{onboardingPR:{merged:true,mergeCommit:MERGE},applicationsSyncedAt:'t',imageDigest:IMAGE,...(profileKey==='virtual-machine'?{diskDigest:DISK}:{}),phase:'PLATFORM_READY',history:[{phase:'IMAGE_BUILT',at:'t'},{phase:'PLATFORM_READY',at:'t'}]})});
   const waits=driveWaits(w);const platform=await outcome(()=>w.platform());const build=await outcome(()=>w.buildPhase());
   out.afterPlatformReady={platform,build,waits,kubeCalls:kube.calls,phase:w.data.phase};}
  // After IMAGE_BUILT only: the build is not repeated, platform readiness completes.
  {const kube=world(spec);const w=make(profileKey,{kube,data:baseData(profileKey,{onboardingPR:{merged:true,mergeCommit:MERGE},applicationsSyncedAt:'t',imageDigest:IMAGE,...(profileKey==='virtual-machine'?{diskDigest:DISK}:{}),phase:'IMAGE_BUILT',history:[{phase:'IMAGE_BUILT',at:'t'}]})});
   const waits=driveWaits(w,{max:1});const platform=await outcome(()=>w.platform());const build=await outcome(()=>w.buildPhase());
   out.afterImageBuilt={platform,build,waits:waits.map(x=>x.label),pipelineCalls:kube.calls.filter(c=>c.includes('pipelineruns')||c.includes('/secrets')),phase:w.data.phase,records:(kube.records||[]).map(r=>JSON.parse(r).phase)};}
  return out;
}
async function build(profileKey,{results}={}){
  const spec=PROFILES_UNDER_TEST[profileKey];const kube=world(spec);let run=null,secret=null;const created={};
  kube.get=(orig=>async p=>{if(p.includes('/pipelineruns/')){kube.calls.push('GET '+p);return run;}if(p.includes('/secrets/')){kube.calls.push('GET '+p);return secret;}return orig(p);})(kube.get.bind(kube));
  kube.handle=async(method,p,body)=>{
    if(method==='POST'&&p.endsWith('/secrets')){created.secret=structuredClone(body);secret={...body,metadata:{...body.metadata,uid:'secret-uid'},data:{'git-provider-token':'cmVkYWN0ZWQ='}};delete secret.stringData;return secret;}
    if(method==='POST'&&p.endsWith('/pipelineruns')){created.pipelineRun=structuredClone(body);run={...body,metadata:{...body.metadata,uid:'run-uid'},status:{conditions:[{type:'Succeeded',status:'True'}],results:results||[{name:'image-digest',value:IMAGE},{name:'disk-digest',value:DISK}]}};return run;}
    if(method==='PUT'&&p.includes('/secrets/')){created.secretOwner=body.metadata.ownerReferences;secret=body;return body;}
    if(method==='DELETE'){secret=null;return {};}
    return {};
  };
  const w=make(profileKey,{kube,data:baseData(profileKey,{onboardingPR:{merged:true,mergeCommit:MERGE},applicationsSyncedAt:'t',phase:'PLATFORM_READY',history:[{phase:'PLATFORM_READY',at:'t'}]})});
  w.github=async p=>p.endsWith('/commits/main')?{sha:spec.sha}:{};
  w.buildToken=async()=>({token:'test-token',expires_at:'2999-01-01T00:00:00Z'});
  const waits=driveWaits(w);
  const result=await outcome(()=>w.buildPhase());
  if(created.secret)created.secret.stringData={'git-provider-token':'<test-token>'};
  return {result,waits,created:norm(created),kubeWrites:kube.calls.filter(c=>!c.startsWith('GET')&&!c.includes('/configmaps')),stored:norm({phase:w.data.phase,imageDigest:w.data.imageDigest,diskDigest:w.data.diskDigest,pipelineName:w.data.pipelineName,credentialSecret:w.data.credentialSecret}),records:(kube.records||[]).map(r=>JSON.parse(r.replace(TIME,'<time>')))};
}
async function promote(profileKey){
  const spec=PROFILES_UNDER_TEST[profileKey];const out={};
  const files=await filesAt(path.join(spec.ws,'gitops'));
  const data=()=>baseData(profileKey,{onboardingPR:{merged:true,mergeCommit:MERGE},imageDigest:IMAGE,...(profileKey==='virtual-machine'?{diskDigest:DISK}:{}),pipelineName:`onb-${spec.name}-${spec.sha.slice(0,8)}`,phase:'PLATFORM_READY',history:[{phase:'PLATFORM_READY',at:'t'}]});
  {const w=make(profileKey,{data:data()});const prs=[];let syncs=0;
   w.content=async(_repo,file)=>files[file]?.content??null;w.pullRequest=async(stage,updates)=>{prs.push({stage,files:Object.fromEntries(Object.keys(updates).sort().map(p=>[p,updates[p]]))});};w.requestPromotionSync=async()=>{syncs++;};
   out.first={result:await outcome(()=>w.promote()),prs,syncRequests:syncs};}
  {const w=make(profileKey,{data:{...data(),history:[]}});w.content=async(_r,f)=>files[f]?.content;w.pullRequest=async()=>{};w.requestPromotionSync=async()=>{};
   out.beforePlatformReady=await outcome(()=>w.promote());}
  {const w=make(profileKey,{data:data()});w.content=async()=>'drifted';w.pullRequest=async()=>{};w.requestPromotionSync=async()=>{};
   out.drifted=await outcome(()=>w.promote());}
  {const w=make(profileKey,{data:{...data(),promotionPR:{merged:true,mergeCommit:MERGE},promotionSync:{revision:MERGE,requestedAt:null}}});let calls=0;w.pullRequest=async()=>{calls++;};
   out.resumedAfterMerge={result:await outcome(()=>w.promote()),prCalls:calls};}
  return out;
}
async function verify(profileKey){
  const spec=PROFILES_UNDER_TEST[profileKey];const ns=spec.name+'-dev';const out={};
  const image=`image-registry.openshift-image-registry.svc:5000/box1-ci/${spec.name}@${IMAGE}`;
  const state={app:{status:{sync:{status:'OutOfSync'},health:{status:'Progressing'}}},dep:{metadata:{generation:2},spec:{template:{spec:{containers:[{image:'old'}]}}},status:{observedGeneration:1}},vm:{metadata:{annotations:{}},status:{conditions:[]}},dv:null,vmi:null,info:{status:503}};
  const kube={get:async p=>p.includes('/applications/')?structuredClone(state.app):p.includes('/deployments/')?structuredClone(state.dep):p.includes('/virtualmachines/')?structuredClone(state.vm):p.includes('/datavolumes/')?structuredClone(state.dv):p.includes('/virtualmachineinstances/')?structuredClone(state.vmi):null,request:async()=>({})};
  const steps=[
    ()=>{state.app={status:{sync:{status:'Synced'},health:{status:'Healthy'}}};},
    ()=>{state.dep={metadata:{generation:2},spec:{template:{spec:{containers:[{image}]}}},status:{observedGeneration:2,availableReplicas:1}};state.vm.metadata.annotations['box1.org/os-image-digest']=IMAGE;state.dv={status:{phase:'ImportInProgress',progress:'40%'}};},
    ()=>{state.info={status:200,body:{name:spec.name,gitRef:spec.sha}};state.dv={status:{phase:'Succeeded'}};},
    ()=>{state.health={status:200,body:{status:'UP'}};state.vm.status.conditions=[{type:'Ready',status:'True'}];},
    ()=>{state.vmi={status:{conditions:[{type:'AgentConnected',status:'True'}]}};},
  ];
  const fetched=[];const realFetch=globalThis.fetch;
  globalThis.fetch=async url=>{fetched.push(url);const r=url.endsWith('/api/info')?state.info:(state.health||{status:503});return {ok:r.status<300,status:r.status,json:async()=>r.body};};
  try{
    const w=make(profileKey,{kube,data:baseData(profileKey,{imageDigest:IMAGE,...(profileKey==='virtual-machine'?{diskDigest:DISK}:{}),pipelineName:'onb-x',onboardingPR:{url:'https://github.com/box1-org/box1-workloads-dev/pull/1',merged:true},promotionPR:{merged:true},promotionSync:{revision:MERGE,requestedAt:null}})});
    const records=[];w.save=async(phase,extra={})=>{records.push(norm({phase,extra}));w.data={...w.data,...extra,phase:phase??w.data.phase};};
    const waits=driveWaits(w,{max:8,step:i=>steps[i]?.()});
    out.success={result:await outcome(()=>w.verify()),waits,records,outputs:norm(w.outputs),fetched:[...new Set(fetched)]};
    const missing=make(profileKey,{kube,data:baseData(profileKey)});driveWaits(missing);
    out.withoutImage=await outcome(()=>missing.verify());
    const failed=make(profileKey,{kube:{get:async p=>p.includes('/applications/')?{status:{operationState:{phase:'Failed',startedAt:'2026-11-08T00:00:10Z',message:'sync failed'},sync:{status:'OutOfSync',revision:'f'.repeat(40)},health:{status:'Degraded'}}}:p.includes('/datavolumes/')?{status:{phase:'Pending'}}:p.includes('/virtualmachines/')?{metadata:{annotations:{'box1.org/os-image-digest':IMAGE}},status:{}}:null},data:baseData(profileKey,{imageDigest:IMAGE,promotionSync:{revision:MERGE,requestedAt:'2026-11-08T00:00:00Z'}})});driveWaits(failed);
    out.failedSync=await outcome(()=>failed.verify());
  } finally { globalThis.fetch=realFetch; }
  return out;
}
async function catalog(profileKey){
  const spec=PROFILES_UNDER_TEST[profileKey];const out={};
  const service=()=>{const calls=[];let entity=null;return {calls,getEntityByRef:async ref=>{calls.push('get '+ref);return entity;},addLocation:async loc=>{calls.push('add '+loc.target);entity={metadata:{annotations:{'github.com/project-slug':'box1-org/'+spec.name}}};}};};
  const complete=baseData(profileKey,{onboardingPR:{merged:true},promotionPR:{merged:true},deploymentImage:'image@'+IMAGE,phase:'DEPLOYMENT_READY'});
  for(const [label,data] of [['complete',complete],['withoutDeploymentImage',{...complete,deploymentImage:undefined}],['withoutPromotion',{...complete,promotionPR:undefined}],['noRecord',null]]){
    const kube=world(spec);const cat=service();
    // Catalog actions take only `name`, so no profile input is passed here.
    const w=make(profileKey,{kube,data,catalog:cat,input:{profile:undefined,sourceRevision:undefined}});
    const result=await outcome(()=>w.registerCatalog());
    out[label]={result,catalogCalls:cat.calls,phases:(kube.records||[]).map(r=>JSON.parse(r).phase),outputs:norm(w.outputs)};
  }
  {const kube=world(spec);const cat=service();const w=make(profileKey,{kube,data:baseData(profileKey),catalog:cat,input:{profile:undefined,sourceRevision:undefined}});
   out.submitBeforeDelivery={result:await outcome(()=>w.catalogSubmit()),catalogCalls:cat.calls,phase:w.data.phase};}
  return out;
}
async function profileChecks(){
  const out={};
  out.unknownProfile=await outcome(()=>{make('service',{input:{profile:'mainframe'}});});
  for(const [input,recorded] of [['service',undefined],['service','virtual-machine'],['virtual-machine',undefined]]){
    const key=input==='service'?'service':'virtual-machine';
    const w=make(key,{input:{profile:input},data:{...baseData(key),profile:recorded}});const prs=[];w.pullRequest=async stage=>{prs.push(stage);};
    out[`input=${input},record=${recorded??'none'}`]={provision:await outcome(()=>w.provision()),promote:await outcome(()=>w.promote()),prs};
  }
  return out;
}
function actionSchemas(){
  const stubs={
    '@backstage/backend-plugin-api':{createBackendModule:o=>o,coreServices:{rootConfig:'rootConfig'}},
    '@backstage/plugin-scaffolder-node':{createTemplateAction:a=>a,scaffolderActionsExtensionPoint:'actions'},
    '@backstage/integration':{DefaultGithubCredentialsProvider:{fromIntegrations:()=>({})},ScmIntegrations:{fromConfig:()=>({})}},
    '@backstage/plugin-catalog-node':{catalogServiceRef:'catalog'},
  };
  const load=Module._load;Module._load=function(request,...rest){return stubs[request]??load.call(this,request,...rest);};
  try{
    const file=path.resolve(ROOT,'plugins/box1-onboarding/index.cjs');delete require.cache[file];
    const definition=require(file).default;let init;definition.register({registerInit:o=>{init=o.init;}});
    const actions=[];init({actions:{addActions:(...a)=>actions.push(...a)},config:{},catalog:{}});
    return actions.map(a=>({id:a.id,description:a.description,schema:a.schema}));
  } finally { Module._load=load; }
}

test('service and virtual-machine profiles behave exactly as recorded before the dispatch refactor',async()=>{
  const observed={profiles:{}};
  for(const spec of Object.values(PROFILES_UNDER_TEST)){
    assert(fss.existsSync(path.join(ROOT,spec.render,'gitops')),'Run `npm run validate` first: '+spec.render);
    spec.ws=await workspace(spec);
  }
  for(const key of Object.keys(PROFILES_UNDER_TEST)){
    uuidCounter=0;
    observed.profiles[key]={
      recordAndMarker:await recordAndMarker(key),
      bundle:await bundle(key),
      bundleOfOtherProfile:await crossBundle(key),
      onboardingPR:await onboardingPR(key),
      platform:await platform(key),
      build:await build(key),
      buildWithoutImageDigest:(await build(key,{results:[{name:'disk-digest',value:DISK}]})).result,
      buildWithoutDiskDigest:(await build(key,{results:[{name:'image-digest',value:IMAGE}]})).result,
      resume:await resume(key),
      promote:await promote(key),
      verify:await verify(key),
      catalog:await catalog(key),
    };
  }
  observed.profileChecks=await profileChecks();
  observed.actionSchemas=actionSchemas();
  const actual=norm(observed);
  if(process.env.UPDATE_CHARACTERISATION==='1'){await fs.mkdir(path.dirname(FIXTURE),{recursive:true});await fs.writeFile(FIXTURE,JSON.stringify(actual,null,1)+'\n');}
  const expected=JSON.parse(await fs.readFile(FIXTURE,'utf8'));
  assert.deepEqual(actual,expected);
});
