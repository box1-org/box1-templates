// artifact onboarding profile (box1-docs#137): code-only multi-module repositories.
// Run after `npm run validate`, which renders .validation/quarkus-monorepo/<name>/.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const crypto=require('node:crypto');const YAML=require('yaml');
const {DELIVERY_PHASES,PROFILES,Workflow,validateArtifactBundle,validateBundle,validateVmBundle,filesAt}=require('../plugins/box1-onboarding/workflow.cjs');
const name='site-gateway',consumer='site-gateway-os',id='5d0f3a52-2f7e-4e0b-9d55-6c1f0e2a9b37',sha='a'.repeat(40),merge='c'.repeat(40),digest='sha256:'+'1'.repeat(64);
const APPS='/apis/argoproj.io/v1alpha1/namespaces/openshift-gitops/applications/';
const rendered=path.resolve(__dirname,'../.validation/quarkus-monorepo',name);
const prUrl=`https://github.com/box1-org/${consumer}/pull/12`;
const bundle=()=>filesAt(path.join(rendered,'gitops'));
const source=file=>fs.readFile(path.join(rendered,'application',file),'utf8');
function workflow(kube={get:async()=>null,request:async()=>({})},{data,catalog,input={}}={}){
  const outputs={},logs=[];
  const ctx={input:{name,sourceRevision:sha,profile:'artifact',...input},workspacePath:rendered,logger:{info:m=>logs.push(m)},output:(k,v)=>{outputs[k]=v;},getInitiatorCredentials:async()=>({})};
  const w=new Workflow({ctx,config:{},credentials:{},kube,catalog});
  Object.assign(w,{outputs,logs});w.renew=async()=>{};
  w.data=data===undefined?{id,name,namespace:name+'-dev',sourceRevision:sha,profile:'artifact',sourceUrl:'https://github.com/box1-org/'+name}:data;
  w.saves=[];w.save=async(phase,extra={})=>{w.saves.push(phase);w.data={...(w.data||{}),...extra,phase:phase??w.data?.phase,history:[...(w.data?.history||[]),...(phase?[{phase}]:[])]};};
  w.wait=async(_label,_seconds,observe)=>{for(let i=0;i<5;i++){const r=await observe();if(r===true)return;}throw new Error('wait did not complete: '+_label);};
  return w;
}
// Files of the merged repositories, as the Hub reads them through the GitHub contents API.
async function contents(overrides={}){
  const files={[`${name}@${sha}:.tekton/release.yaml`]:await source('.tekton/release.yaml'),
    [`box1-workloads-dev@${merge}:ci/${name}/repository.yaml`]:(await bundle())[`ci/${name}/repository.yaml`].content,...overrides};
  return async(repo,file,ref='main')=>files[`${repo}@${ref}:${file}`]??null;
}
const edit=(files,file,from,to)=>{const copy=structuredClone(files);assert(copy[file].content.includes(from),'fixture text missing: '+from);copy[file].content=copy[file].content.replace(from,to);return copy;};
const ready={
  [`/api/v1/namespaces/box1-ci/serviceaccounts/${name}-release`]:{metadata:{name:name+'-release'}},
  [`/apis/rbac.authorization.k8s.io/v1/namespaces/box1-ci/roles/${name}-bundle-push`]:{metadata:{name:name+'-bundle-push'}},
  [`/apis/rbac.authorization.k8s.io/v1/namespaces/box1-ci/rolebindings/${name}-bundle-push`]:{roleRef:{kind:'Role',name:name+'-bundle-push'},subjects:[{kind:'ServiceAccount',name:name+'-release',namespace:'box1-ci'}]},
  [`/apis/image.openshift.io/v1/namespaces/box1-ci/imagestreams/${name}-bundle`]:{metadata:{name:name+'-bundle'},status:{tags:[{tag:sha,items:[{image:digest}]}]}},
  [`/apis/pipelinesascode.tekton.dev/v1alpha1/namespaces/box1-ci/repositories/${name}`]:{spec:{url:'https://github.com/box1-org/'+name,settings:{github_app_token_scope_repos:['box1-org/'+consumer]}}},
};
const synced=(app,namespace)=>({metadata:{name:app},spec:{source:{repoURL:'https://github.com/box1-org/box1-workloads-dev.git'},destination:{namespace}},status:{sync:{status:'Synced',revision:merge},health:{status:'Healthy'},operationState:{phase:'Succeeded'}}});
const runResults=(overrides={})=>Object.entries({'image-digest':digest,'gate-policy':'pass','gate-findings':'scan-exit=0','consumer-pr':prUrl,'consumer-outcome':'opened',...overrides}).map(([n,value])=>({name:n,value}));

test('artifact is one table entry with the 1.4.0 hooks; service and virtual-machine declare neither hook',()=>{
  const a=PROFILES.artifact;
  assert.equal(a.templateVersion,'1.0.0');assert.equal(a.promotionUpdates,null);
  assert.equal(typeof a.validateBundle,'function');assert.equal(typeof a.gitopsApplication,'function');assert.equal(typeof a.buildCredential,'function');
  for(const p of ['service','virtual-machine'])for(const key of ['gitopsApplication','buildCredential'])assert(!Object.hasOwn(PROFILES[p],key),`${p} keeps the 1.3.0 default for ${key}`);
  const w=workflow();assert.deepEqual(a.recordFields(w),{profile:'artifact'});assert.deepEqual(a.markerFields(w),{profile:'artifact'});
  assert.equal(w.applicationName(),name+'-ci');
  const s=new Workflow({ctx:{input:{name:'orders-api'},logger:{info(){}}},config:{},credentials:{},kube:{}});assert.equal(s.applicationName(),'orders-api');
});

test('bundle validation: the rendered template is ci/ plus the CI Application, and nothing else',async()=>{
  const files=await bundle();
  assert.deepEqual(Object.keys(files).sort(),[`applications/${name}-ci.yaml`,`ci/${name}/kustomization.yaml`,`ci/${name}/release.yaml`,`ci/${name}/repository.yaml`]);
  assert.equal(validateArtifactBundle(files,name),files);
  assert.throws(()=>validateBundle(files,name));assert.throws(()=>validateVmBundle(files,name));
});

test('bundle validation rejects workloads, wider RBAC, token scopes and Application drift',async()=>{
  const files=await bundle(),rel=`ci/${name}/release.yaml`,repo=`ci/${name}/repository.yaml`,app=`applications/${name}-ci.yaml`,k=`ci/${name}/kustomization.yaml`;
  const rejects=(changed,pattern)=>assert.throws(()=>validateArtifactBundle(changed,name),pattern);
  rejects({...files,[`workloads/${name}/deployment.yaml`]:{content:'kind: Deployment',mode:'100644'}},/only applications\/<name>-ci.yaml and ci\/<name>/);
  rejects({...files,[`applications/${name}.yaml`]:files[app]},/only applications/);
  rejects(edit(files,rel,'  - get\n  - update','  - get\n  - update\n  - create'),/push Role may only get and update/);
  rejects(edit(files,rel,'  - imagestreams/layers','  - imagestreams'),/push Role may only get and update/);
  rejects(edit(files,rel,`  - "${name}-bundle"\n  verbs`,'  - "other-bundle"\n  verbs'),/push Role may only get and update/);
  rejects(edit(files,rel,`- kind: ServiceAccount\n  name: "${name}-release"`,'- kind: ServiceAccount\n  name: "ci-build"'),/bind <name>-bundle-push to <name>-release only/);
  rejects(edit(files,rel,`  name: "${name}-release"\n  namespace: box1-ci\n---`,`  name: "${name}-release"\n  namespace: box1-ci\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: ${name}-token\n  namespace: box1-ci\n---`),/Unexpected generated resource for an artifact repository: Secret/);
  rejects(edit(files,rel,`  name: "${name}-bundle"\n  namespace: box1-ci`,`  name: "${name}-bundle"\n  namespace: ${name}-dev`),/must be in box1-ci/);
  rejects(edit(files,repo,`    - box1-org/${consumer}`,'    - box1-org/box1-workloads-dev'),/never box1-gitops or box1-workloads-dev/);
  rejects(edit(files,repo,`    - box1-org/${consumer}`,`    - box1-org/${consumer}\n    - box1-org/other-os`),/exactly one box1-org consumer/);
  rejects(edit(files,repo,`    - box1-org/${consumer}`,`    - box1-org/${name}`),/another box1-org repository/);
  rejects(edit(files,repo,'  concurrency_limit: 1','  concurrency_limit: 1\n  params:\n  - name: x\n    secret_ref:\n      name: y'),/Invalid PAC Repository/);
  rejects(edit(files,repo,'pipelinerun_provenance: default_branch','pipelinerun_provenance: source'),/Invalid PAC Repository/);
  rejects(edit(files,app,'namespace: box1-ci','namespace: site-gateway-dev'),/target box1-ci without pruning/);
  rejects(edit(files,app,`path: ci/${name}`,`path: workloads/${name}`),/track ci\/<name>/);
  rejects(edit(files,app,'      selfHeal: true','      selfHeal: true\n      prune: true'),/without pruning/);
  rejects(edit(files,k,'kind: Kustomization','kind: Kustomization\nnamespace: other'),/Invalid ci\/<name> Kustomization/);
});

test('no-workload flow: provision, platform, first bundle build, no promotion, verify, catalog',async()=>{
  const requests=[],gets=[];let run;const created=[];
  const objects={...ready,[APPS+'box1-workloads-dev']:synced('box1-workloads-dev','openshift-gitops'),[APPS+name+'-ci']:synced(name+'-ci','box1-ci')};
  const kube={
    get:async p=>{gets.push(p);if(p.includes('/pipelineruns/'))return run;if(p.endsWith('-git'))return created.find(c=>c.kind==='Secret');return objects[p]??null;},
    request:async(method,p,body)=>{requests.push([method,p]);
      if(method==='POST'&&body.kind==='Secret'){const s={...body,metadata:{...body.metadata,uid:'s1'},data:{'git-provider-token':'eA=='}};created.push(s);return s;}
      if(method==='POST'&&body.kind==='PipelineRun'){created.push(body);run={...body,metadata:{...body.metadata,uid:'r1'},status:{conditions:[{type:'Succeeded',status:'True'}],results:runResults()}};return run;}
      return {};}};
  const cat={calls:[],getEntityByRef:async ref=>{cat.calls.push(ref);return cat.entity;},addLocation:async()=>{cat.entity={metadata:{annotations:{'github.com/project-slug':'box1-org/'+name}}};}};
  const w=workflow(kube,{catalog:cat});w.content=await contents();
  const prs=[];
  w.pullRequest=async(stage,files)=>{prs.push([stage,Object.keys(files).sort()]);await w.save('ONBOARDING_MERGED',{onboardingPR:{merged:true,mergeCommit:merge,url:'https://github.com/box1-org/box1-workloads-dev/pull/1'}});};
  w.github=async p=>{if(p===`/repos/box1-org/${name}/commits/main`)return {sha};if(p===`/repos/box1-org/${consumer}/pulls/12`)return {html_url:prUrl,state:'open',merged:false,base:{repo:{full_name:'box1-org/'+consumer}}};throw new Error('unexpected GitHub call '+p);};
  let scope;w.buildToken=async()=>{scope=PROFILES.artifact.buildCredential(w);return {token:'t',expires_at:new Date(Date.now()+3600e3).toISOString()};};
  for(const phase of DELIVERY_PHASES)await w[phase]();
  // Onboarding PR: only ci/ and the CI Application. No promotion PR.
  assert.deepEqual(prs,[['onboarding',[`applications/${name}-ci.yaml`,`ci/${name}/kustomization.yaml`,`ci/${name}/release.yaml`,`ci/${name}/repository.yaml`]]]);
  assert(w.logs.some(l=>/phase=promote state=skipped reason=profile_has_no_workload_promotion/.test(l)));
  // The consumer comes from the source revision's release pipeline and matches the token scope.
  assert.deepEqual(w.data.consumer,{repository:consumer,path:'Containerfile'});
  assert.deepEqual(scope,{repositories:[name,consumer],permissions:{contents:'write',pull_requests:'write'}});
  // The first build is the release pipeline: bundle, gate, consumer PR, as <name>-release.
  const pipeline=created.find(c=>c.kind==='PipelineRun');
  assert.equal(pipeline.spec.taskRunTemplate.serviceAccountName,name+'-release');
  assert.deepEqual(pipeline.spec.pipelineSpec.tasks.map(t=>[t.name,t.taskRef.params.find(p=>p.name==='name').value,t.runAfter?.[0]]),[['build','box1-maven-bundle',undefined],['security','box1-security-gates','build'],['consumer','box1-bundle-consumer-pr','security']]);
  const args=Object.fromEntries(pipeline.spec.pipelineSpec.tasks.map(t=>[t.name,Object.fromEntries(t.params.map(p=>[p.name,p.value]))]));
  assert.deepEqual([args.build['push-image'],args.build['image-name'],args.security.enforcement,args.consumer['gate-policy'],args.consumer['consumer-repository'],args.consumer['consumer-path']],['true',name+'-bundle','gate','$(tasks.security.results.policy)',consumer,'Containerfile']);
  assert.equal(args.security['image-reference'],`image-registry.openshift-image-registry.svc:5000/box1-ci/${name}-bundle@$(tasks.build.results.image-digest)`);
  // Same tasks and arguments as the generated .tekton/release.yaml.
  const release=YAML.parse(await source('.tekton/release.yaml'));
  const releaseArgs=Object.fromEntries(release.spec.pipelineSpec.tasks.map(t=>[t.name,Object.fromEntries(t.params.map(p=>[p.name,p.value]))]));
  for(const task of ['build','security','consumer'])for(const [key,value] of Object.entries(releaseArgs[task])){
    if(['revision','git-auth-secret','consumer-repository','consumer-path','source-revision'].includes(key))continue;
    assert.equal(args[task][key],value,`${task}.${key} matches .tekton/release.yaml`);
  }
  // Stored results, platform readiness and verify.
  assert.equal(w.data.imageDigest,digest);
  assert.deepEqual(w.data.gate,{enforcement:'gate',policy:'pass',findings:'scan-exit=0',pipelineRun:`onb-${name}-${sha.slice(0,8)}`});
  assert.deepEqual(Object.keys(w.data.readiness.conditions).sort(),['argo_application','bundle_imagestream','pac_repository','registry_push','release_identity']);
  assert.equal(w.data.consumerPR.state,'open');assert.equal(w.data.bundleImage,`image-registry.openshift-image-registry.svc:5000/box1-ci/${name}-bundle@${digest}`);
  assert.deepEqual(w.saves.filter(Boolean),['ONBOARDING_MERGED','PLATFORM_APPS_SYNCED','BUILD_RUNNING','IMAGE_BUILT','PLATFORM_READY','ARTIFACT_VERIFIED']);
  assert.equal(w.outputs.deploymentUrl,prUrl);assert.equal(w.outputs.imageDigest,digest);assert.match(w.outputs.argoUrl,/applications\/openshift-gitops\/site-gateway-ci$/);
  // Nothing about a namespace, a Deployment or a workload Application was read or written.
  for(const p of [...gets,...requests.map(r=>r[1])])assert(!/site-gateway-dev|\/deployments|virtualmachines|applications\/site-gateway$/.test(p),'unexpected workload access: '+p);
  // The CI Application is the one synced; the credential Secret was removed after the build.
  assert(gets.includes(APPS+name+'-ci'));assert(requests.some(([m,p])=>m==='DELETE'&&p.endsWith(`onb-${name}-${sha.slice(0,8)}-git`)));
  // Catalog completion from the stored record (catalog actions have no profile input).
  const c=workflow(kube,{catalog:cat,data:w.data,input:{profile:undefined,sourceRevision:undefined}});
  await c.registerCatalog();assert.equal(c.data.phase,'COMPLETE');assert.equal(c.outputs.entityRef,'component:default/'+name);
});

test('platform syncs the box1-workloads-dev index and the <name>-ci Application, never <name>',async()=>{
  const patched=[];const objects={[APPS+'box1-workloads-dev']:synced('box1-workloads-dev','openshift-gitops'),[APPS+name+'-ci']:{...synced(name+'-ci','box1-ci'),status:{sync:{status:'OutOfSync',revision:'0'.repeat(40)},health:{status:'Healthy'}}}};
  const w=workflow({get:async p=>objects[p]??null,request:async(m,p)=>{patched.push([m,p]);return {};}},{data:{id,name,sourceRevision:sha,profile:'artifact',onboardingPR:{merged:true,mergeCommit:merge}}});
  w.content=await contents();w.kube.get=async p=>objects[p]??ready[p]??null;
  await w.platform();
  assert.deepEqual(patched,[['PATCH',APPS+name+'-ci']]);assert(w.data.serviceSyncRequestedAt);
});

test('build barrier: the consumer must match the merged token scope; the release identity must exist',async()=>{
  const w=workflow({get:async p=>ready[p]??null,request:async()=>({})},{data:{id,name,sourceRevision:sha,profile:'artifact',onboardingPR:{merged:true,mergeCommit:merge}}});
  const release=await source('.tekton/release.yaml');
  w.content=await contents({[`${name}@${sha}:.tekton/release.yaml`]:release.replace(`value: "${consumer}"`,'value: other-os')});
  await assert.rejects(w.buildBarrier(),/token scope must be the consumer declared in .tekton\/release.yaml/);
  w.content=await contents({[`${name}@${sha}:.tekton/release.yaml`]:release.replace('value: "Containerfile"','value: ../Containerfile')});
  await assert.rejects(w.buildBarrier(),/must declare a consumer-repository/);
  w.content=await contents({[`${name}@${sha}:.tekton/release.yaml`]:null});
  await assert.rejects(w.buildBarrier(),/has no .tekton\/release.yaml/);
  const missing=workflow({get:async p=>p.includes('rolebindings')?null:ready[p]??null},{data:{...w.data,consumer:{repository:consumer,path:'Containerfile'}}});
  await assert.rejects(missing.buildBarrier(),/wait did not complete: initial bundle build prerequisites/);
  assert.throws(()=>PROFILES.artifact.buildCredential(workflow(undefined,{data:{id,name,sourceRevision:sha,profile:'artifact'}})),/consumer repository is not recorded/);
});

test('build results: a failed or skipped gate, or no consumer PR, is never recorded as built',()=>{
  const w=workflow(undefined,{data:{id,name,sourceRevision:sha,profile:'artifact',consumer:{repository:consumer,path:'Containerfile'}}});
  const results=overrides=>PROFILES.artifact.buildResults(w,{metadata:{name:'onb-x'},status:{results:runResults(overrides)}});
  assert.deepEqual(results({}).consumerPR,{outcome:'opened',url:prUrl});
  assert.deepEqual(results({'consumer-outcome':'current','consumer-pr':'current'}).consumerPR,{outcome:'current',url:null});
  for(const policy of ['fail','disabled','unavailable'])assert.throws(()=>results({'gate-policy':policy}),/did not pass the security gate/);
  assert.throws(()=>results({'consumer-outcome':'superseded','consumer-pr':'superseded'}),/was not proposed to its consumer/);
  assert.throws(()=>results({'consumer-pr':'https://github.com/box1-org/other-os/pull/1'}),/not a PR in the declared consumer/);
  assert.throws(()=>results({'image-digest':'not-published'}),/immutable image digest/);
});

test('verify: digest in box1-ci/<name>-bundle, gate recorded, consumer PR open, merged or already pinned',async()=>{
  const base={id,name,sourceRevision:sha,profile:'artifact',imageDigest:digest,pipelineName:'onb-x',onboardingPR:{merged:true,url:'u'},consumer:{repository:consumer,path:'Containerfile'},gate:{enforcement:'gate',policy:'pass'},consumerPR:{outcome:'opened',url:prUrl}};
  const pr=state=>async()=>({html_url:prUrl,base:{repo:{full_name:'box1-org/'+consumer}},...state});
  const kube={get:async p=>ready[p]??null};
  const merged=workflow(kube,{data:structuredClone(base)});merged.github=pr({state:'closed',merged:true});await merged.verify();assert.equal(merged.data.consumerPR.state,'merged');
  const closed=workflow(kube,{data:structuredClone(base)});closed.github=pr({state:'closed',merged:false});await assert.rejects(closed.verify(),/closed without merging/);
  const current=workflow(kube,{data:{...structuredClone(base),consumerPR:{outcome:'current',url:null}}});
  current.github=async p=>{assert.equal(p,`/repos/box1-org/${consumer}`);return {default_branch:'trunk'};};
  current.content=async(repo,file,ref)=>repo===consumer&&file==='Containerfile'&&ref==='trunk'?`COPY --from=r/box1-ci/${name}-bundle@${digest} / /x/\n`:null;
  await current.verify();assert.equal(current.data.consumerPR.state,'current');assert.equal(current.outputs.deploymentUrl,`https://github.com/box1-org/${consumer}/blob/trunk/Containerfile`);
  const unpublished=workflow({get:async p=>p.includes('imagestreams')?{status:{tags:[{items:[{image:'sha256:'+'9'.repeat(64)}]}]}}:null},{data:structuredClone(base)});unpublished.github=pr({state:'open'});
  await assert.rejects(unpublished.verify(),/wait did not complete: bundle digest and consumer PR/);
  const ungated=workflow(kube,{data:{...structuredClone(base),gate:{enforcement:'observe',policy:'pass'}}});await assert.rejects(ungated.verify(),/not recorded as a pass in gate mode/);
});

test('catalog completion needs the verified bundle, not a deployment image',()=>{
  const done={bundleImage:'x@'+digest,artifactVerifiedAt:'t',onboardingPR:{merged:true},gate:{policy:'pass'},consumerPR:{outcome:'opened'}};
  assert.equal(PROFILES.artifact.catalogComplete(done),true);
  for(const key of ['bundleImage','artifactVerifiedAt','onboardingPR','gate','consumerPR'])assert.equal(PROFILES.artifact.catalogComplete({...done,[key]:undefined}),false,key);
  assert.equal(PROFILES.artifact.catalogComplete({...done,deploymentImage:'y',bundleImage:undefined}),false);
});

test('the quarkus-monorepo template runs the delivery phases with the artifact profile',async()=>{
  const template=YAML.parse(await fs.readFile(path.resolve(__dirname,'../templates/quarkus-monorepo/template.yaml'),'utf8'));
  const registered=await fs.readFile(path.resolve(__dirname,'../plugins/box1-onboarding/index.cjs'),'utf8');
  const operationFor=action=>registered.match(new RegExp(`action\\('${action}','([a-zA-Z]+)'`))?.[1];
  const steps=template.spec.steps,actions=steps.map(s=>s.action);
  assert.deepEqual(actions.filter(a=>a.startsWith('box1:development:')).map(operationFor),DELIVERY_PHASES);
  for(const step of steps.filter(s=>s.action.startsWith('box1:development:')||s.action==='box1:repository:ensure'))assert.equal(step.input.profile,'artifact',step.id);
  assert(actions.indexOf('box1:catalog:submit')<actions.indexOf('box1:development:provision'));assert.equal(actions.at(-1),'box1:catalog:verify');
  assert.deepEqual(steps.slice(0,2).map(s=>[s.id,s.action]),[['fetchApplication','fetch:template'],['fetchModules','fetch:template']]);
});

test('the build credential request reaches the GitHub App token endpoint with the consumer scope',async()=>{
  const {privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
  const app={getString:k=>({appId:'1',privateKey:privateKey.export({type:'pkcs1',format:'pem'})})[k]};
  const w=workflow(undefined,{data:{id,name,sourceRevision:sha,profile:'artifact',consumer:{repository:consumer,path:'Containerfile'}}});
  w.config={getConfigArray:()=>[{getConfigArray:()=>[app]}]};const calls=[];
  w.github=async(p,method,body)=>{calls.push([p,method,body]);return p.endsWith('/installation')?{id:7}:{token:'t'};};
  await w.buildToken();
  assert.deepEqual(calls[1],['/app/installations/7/access_tokens','POST',{repositories:[name,consumer],permissions:{contents:'write',pull_requests:'write'}}]);
  const s=new Workflow({ctx:{input:{name:'orders-api'},logger:{info(){}}},config:w.config,credentials:{},kube:{}});s.github=w.github;calls.length=0;
  await s.buildToken();assert.deepEqual(calls[1][2],{repositories:['orders-api'],permissions:{contents:'read'}},'service keeps the read-only source credential');
});
