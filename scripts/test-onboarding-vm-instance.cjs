// vm-instance onboarding profile (box1-docs#138): one more VM of an approved OS image.
// Run after `npm run validate`, which renders .validation/vm-instance/<name>/.
const test=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');const YAML=require('yaml');
const {PROFILES,RESOLVE_OUTPUTS,VM_INSTANCE_SOURCES,Workflow,validateVmInstanceBundle,validateVmBundle,validateBundle,filesAt}=require('../plugins/box1-onboarding/workflow.cjs');
const name='site-west',ns='site-west-dev',source='site-gateway-os',id='0c6f1c2e-3f8e-4b47-9d0a-6a3c1c8f5e21';
const sha='c'.repeat(40),merge='d'.repeat(40),gitops='e'.repeat(40),newer='f'.repeat(40);
const image='sha256:'+'a'.repeat(64),disk='sha256:'+'b'.repeat(64),firstDisk='sha256:'+'9'.repeat(64),ZERO='sha256:'+'0'.repeat(64);
const APPS='/apis/argoproj.io/v1alpha1/namespaces/openshift-gitops/applications/';
const RUNS='/apis/tekton.dev/v1/namespaces/box1-ci/pipelineruns';
const IS='/apis/image.openshift.io/v1/namespaces/box1-ci/imagestreams/';
const rendered=path.resolve(__dirname,'../.validation/vm-instance',name);
const bundle=()=>filesAt(path.join(rendered,'gitops'));
const edit=(files,file,from,to)=>{const copy=structuredClone(files);const key=`workloads/${name}/${file}`;assert(copy[key].content.includes(from),'fixture text missing: '+from);copy[key].content=copy[key].content.replace(from,to);return copy;};
const recordedSource={name:source,revision:sha,imageDigest:image,diskDigest:disk,gitopsRevision:gitops,buildPipelineRun:'box1-ci/site-gateway-os-release-abcde',firstReleaseDiskDigest:firstDisk};
const record=extra=>({id,name,namespace:ns,profile:'vm-instance',templateVersion:'1.0.0',sourceRevision:sha,sourceUrl:'https://github.com/box1-org/'+source,source:recordedSource,...extra});

// The source's approved workload in box1-workloads-dev (rendered like rhel-image-vm after a day-2 release).
function sourceFiles({revision=sha,os=image,dvDigest=firstDisk,profile='virtual-machine'}={}){
  return {
    'namespace.yaml':`apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${source}-dev\n  labels:\n    box1.org/workload-profile: ${profile}\n`,
    'virtualmachine.yaml':`# comment\n---\napiVersion: kubevirt.io/v1\nkind: VirtualMachine\nmetadata:\n  name: "${source}"\n  annotations:\n    box1.org/os-image-digest: ${os}\n    box1.org/source-revision: ${revision}\n    box1.org/build-pipelinerun: box1-ci/site-gateway-os-release-abcde\nspec:\n  runStrategy: Always\n`,
    'datavolume.yaml':`---\napiVersion: cdi.kubevirt.io/v1beta1\nkind: DataVolume\nmetadata:\n  name: ${source}-root\nspec:\n  source:\n    registry:\n      url: docker://image-registry.openshift-image-registry.svc:5000/box1-ci/${source}-disk@${dvDigest}\n`,
  };
}
const streams=({revision=sha,os=image,diskTag=disk}={})=>({
  [IS+source]:{status:{tags:[{tag:'development',items:[{image:os}]},{tag:revision,items:[{image:os}]}]}},
  [IS+source+'-disk']:{status:{tags:[{tag:'1'.repeat(40),items:[{image:firstDisk}]},...(diskTag?[{tag:revision,items:[{image:diskTag}]}]:[])]}},
  [`/apis/image.openshift.io/v1/namespaces/box1-ci/imagestreamimages/${source}-disk@${diskTag}`]:{image:{dockerImageMetadata:{Config:{Labels:{'box1.org/bootc-image':`box1-ci/${source}@${os}`}}}}},
});
// GitHub double: box1-workloads-dev main and the source workload; `taken` paths exist.
function github({taken=[],files=sourceFiles()}={}){
  const calls=[];
  const fn=async(p,method='GET',body,options={})=>{
    calls.push(method+' '+p);
    if(p==='/repos/box1-org/box1-workloads-dev/git/ref/heads/main')return {object:{sha:gitops}};
    const found=taken.find(t=>p.includes(t));if(found)return {path:found};
    if(options.missing)return null;
    throw new Error('unexpected GitHub call '+p);
  };
  fn.calls=calls;fn.files=files;return fn;
}
function workflow({kube,data,input={},gh=github(),catalog}={}){
  const outputs={},logs=[];
  const ctx={input:{name,sourceRevision:sha,profile:'vm-instance',...input},workspacePath:rendered,logger:{info:m=>logs.push(m)},output:(k,v)=>{outputs[k]=v;},getInitiatorCredentials:async()=>({})};
  const w=new Workflow({ctx,config:{},credentials:{},kube:kube||cluster(),catalog});
  Object.assign(w,{outputs,logs});w.renew=async()=>{};
  w.data=data===undefined?record():data;
  w.github=gh;
  w.content=async(repo,file,ref='main')=>{assert.equal(repo,'box1-workloads-dev');const m=file.match(new RegExp(`^workloads/${source}/(.+)$`));if(m){assert.equal(ref,gitops,'the source is read at one pinned box1-workloads-dev commit');return gh.files[m[1]]??null;}return (w.live||{})[file]??null;};
  w.saves=[];w.save=async(phase,extra={})=>{w.saves.push(phase);w.data={...(w.data||{}),...extra,phase:phase??w.data?.phase,history:[...(w.data?.history||[]),...(phase?[{phase}]:[])]};};
  w.wait=async(label,_s,observe)=>{for(let i=0;i<5;i++){const r=await observe();if(r===true)return;w.lastWait=r;}throw new Error('wait did not complete: '+label+': '+w.lastWait);};
  return w;
}
// Kubernetes double. `objects` answer GETs; metadata() answers metadata-only GETs and is
// the only way the plugin may look at a Secret.
function cluster(objects={},{secrets={}}={}){
  const calls=[];
  const kube={calls,objects:{...streams(),...objects},
    async get(p){calls.push('GET '+p);assert(!/\/secrets\//.test(p),'Secrets must be read as metadata only: '+p);return structuredClone(kube.objects[p]??null);},
    async metadata(p){calls.push('META '+p);const v=secrets[p];if(v instanceof Error)throw v;return v===undefined?null:structuredClone(v);},
    async request(method,p,body){calls.push(method+' '+p);if(kube.handle)return kube.handle(method,p,body);return {};}};
  return kube;
}
const secretPath=`/api/v1/namespaces/${ns}/secrets/${name}-cloud-init`;
const assembled={metadata:{name:name+'-cloud-init',labels:{'box1.org/instance':name,'box1.org/cloud-init':'userdata'}}};
const deployKey={['/api/v1/namespaces/box1-ci/secrets/vm-instance-status-ssh']:{metadata:{name:'vm-instance-status-ssh'}}};
const readyObjects=()=>{
  const o={
    ['/api/v1/namespaces/'+ns]:{status:{phase:'Active'}},
    [`/api/v1/namespaces/${ns}/serviceaccounts/${name}-updater`]:{},
    '/api/v1/namespaces/box1-ci/serviceaccounts/ci-observe':{},
    '/api/v1/namespaces/box1-ci/serviceaccounts/ci-vm-deploy':{},
    [`/apis/rbac.authorization.k8s.io/v1/namespaces/box1-ci/rolebindings/${name}-image-puller`]:{roleRef:{name:'system:image-puller'},subjects:[{kind:'Group',name:'system:serviceaccounts:'+ns}]},
    [`/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings/${name}-status-reader`]:{roleRef:{name:name+'-status-reader'},subjects:[{kind:'ServiceAccount',name:'ci-vm-deploy',namespace:'box1-ci'}]},
    [APPS+name]:{spec:{destination:{namespace:ns}},status:{sync:{status:'Synced',revision:merge},health:{status:'Healthy'}}},
    [`/apis/kubevirt.io/v1/namespaces/${ns}/virtualmachines/${name}`]:{metadata:{annotations:{'box1.org/os-image-digest':image}},status:{conditions:[{type:'Ready',status:'True'}]}},
    [`/apis/kubevirt.io/v1/namespaces/${ns}/virtualmachineinstances/${name}`]:{status:{conditions:[{type:'AgentConnected',status:'True'}]}},
    [`/apis/cdi.kubevirt.io/v1beta1/namespaces/${ns}/datavolumes/${name}-root`]:{status:{phase:'Succeeded'}},
  };
  for(const n of [ns,'openshift-gitops']){
    o[`/apis/rbac.authorization.k8s.io/v1/namespaces/${n}/roles/${name}-release-observer`]={metadata:{name:name+'-release-observer'}};
    o[`/apis/rbac.authorization.k8s.io/v1/namespaces/${n}/rolebindings/${name}-release-observer`]={roleRef:{name:name+'-release-observer'},subjects:[{name:'ci-observe',namespace:'box1-ci'}]};
  }
  return o;
};

test('vm-instance is one table entry: no source repository, no build, the 1.5.0 hooks',async()=>{
  const p=PROFILES['vm-instance'];
  assert.equal(p.sourceRepository,false);assert.equal(p.commitMessage,null);assert.equal(p.templateVersion,'1.0.0');
  assert.equal(p.buildSpec,null);assert.equal(p.buildBarrier,null);assert.equal(typeof p.buildResults,'function');
  for(const key of ['initialRecord','resolveSource','catalogEntity','bootedDigest'])assert.equal(typeof p[key],'function',key);
  for(const other of ['service','virtual-machine','artifact'])for(const key of ['resolveSource','catalogEntity'])assert(!Object.hasOwn(PROFILES[other],key),`${other} keeps the default ${key}`);
  assert.deepEqual(VM_INSTANCE_SOURCES,['site-gateway-os']);
  assert.deepEqual(RESOLVE_OUTPUTS,['sourceRevision','sourceUrl','imageDigest','diskDigest']);
  const w=workflow({data:null,input:{owner:'o',visibility:'private',description:'d'}});
  await assert.rejects(w.repository(),/The vm-instance onboarding profile has no source repository/);
  assert.deepEqual(p.recordFields(w),{profile:'vm-instance'});assert.equal(w.applicationName(),name);
});

test('other profiles refuse box1:development:resolve-source',async()=>{
  const w=workflow({input:{profile:'virtual-machine',source},data:null});
  await assert.rejects(w.resolveSource(),/The virtual-machine onboarding profile has no external source to resolve/);
});

test('bundle validation: the rendered template is the instance bundle, and neither a VM nor a service bundle',async()=>{
  const files=await bundle();
  assert.deepEqual(Object.keys(files).sort(),[`applications/${name}.yaml`,...['admin-access','catalog-info','datavolume','deploy-access','kustomization','namespace','onboarding','site','updater','virtualmachine'].map(f=>`workloads/${name}/${f}.yaml`)]);
  assert.equal(validateVmInstanceBundle(files,name),files);
  assert.throws(()=>validateVmBundle(files,name));assert.throws(()=>validateBundle(files,name));
});

test('bundle validation mirrors the #139 and #140 rules',async()=>{
  const files=await bundle();
  const rejects=(changed,pattern)=>assert.throws(()=>validateVmInstanceBundle(changed,name),pattern);
  rejects(edit(files,'virtualmachine.yaml','box1.org/source-image: site-gateway-os','box1.org/source-image: vm-golden-check'),/not on the vm-instance allowlist/);
  rejects(edit(files,'virtualmachine.yaml','          cloudInitNoCloud:\n            secretRef:\n','          cloudInitNoCloud:\n            userData: "#cloud-config"\n            secretRef:\n'),/cloudinitdisk must be cloudInitNoCloud with only secretRef/);
  rejects(edit(files,'virtualmachine.yaml','              name: "site-west-cloud-init"\n','              name: "site-west-cloud-init"\n            networkDataSecretRef:\n              name: net\n'),/only secretRef/);
  rejects(edit(files,'virtualmachine.yaml','name: "site-west-cloud-init"','name: "site-east-cloud-init"'),/only secretRef.name: site-west-cloud-init/);
  rejects(edit(files,'virtualmachine.yaml','        firmware:\n','        firmware:\n          serial: "ds=nocloud;s=http://10.0.0.1/"\n'),/firmware serial or a ds= serial/);
  rejects(edit(files,'virtualmachine.yaml','              qemuGuestAgent:\n                users: [cloud-user]','              noCloud: {}'),/through the guest agent, for cloud-user only/);
  rejects(edit(files,'virtualmachine.yaml','users: [cloud-user]','users: [cloud-user, root]'),/for cloud-user only/);
  rejects(edit(files,'virtualmachine.yaml','  runStrategy: Halted','  runStrategy: Always'),/must be Halted with zero digests/);
  rejects(edit(files,'datavolume.yaml','box1-ci/site-gateway-os-disk@','box1-ci/site-west-disk@'),/zero site-gateway-os-disk digest/);
  rejects(edit(files,'kustomization.yaml','  - virtualmachine.yaml\n','  - virtualmachine.yaml\n  - datavolume.yaml\n'),/the DataVolume is listed only by the first promotion/);
  rejects(edit(files,'site.yaml','  siteId: "site_ds9"','  siteId: "site_ds9"\n  clientSecret: "x"'),/may only hold siteId/);
  rejects(edit(files,'site.yaml','  siteId: "site_ds9"','  siteId: "Site-DS9"'),/siteId does not match the #140 pattern/);
  rejects(edit(files,'site.yaml','  keycloakTokenUrl: "https://','  keycloakTokenUrl: "http://'),/keycloakTokenUrl does not match/);
  rejects(edit(files,'site.yaml','    box1.org/instance: "site-west"','    box1.org/instance: "site-east"'),/labelled box1.org\/instance: site-west/);
  rejects(edit(files,'site.yaml','  keycloakClientId: "site-west"\n',''),/must set keycloakClientId/);
  rejects(edit(files,'admin-access.yaml','  key1:','  userdata:'),/Only SSH public keys/);
  rejects(edit(files,'onboarding.yaml','  - "site-west-cloud-init"','  - "site-west-admin-ssh"'),/Invalid Role site-west-cloud-init-observer/);
  rejects(edit(files,'onboarding.yaml','  name: developer-hub-onboarding\n','  name: default\n'),/Invalid RoleBinding site-west-cloud-init-observer/);
  rejects(edit(files,'deploy-access.yaml','  - get\n  - update','  - get\n  - update\n  - create'),/Invalid Role site-west-status-reader/);
  rejects(edit(files,'catalog-info.yaml','  type: vm-instance','  type: service'),/vm-instance Component that depends on its source/);
  const extra=structuredClone(files);extra[`workloads/${name}/onboarding.yaml`].content+=`---\napiVersion: pipelinesascode.tekton.dev/v1alpha1\nkind: Repository\nmetadata:\n  name: ${name}\n  namespace: box1-ci\nspec:\n  url: https://github.com/box1-org/${name}\n`;
  rejects(extra,/Unexpected generated resource for a VM instance: Repository/);
  const cloudInit=structuredClone(files);cloudInit[`workloads/${name}/admin-access.yaml`].content+=`---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: ${name}-cloud-init\n  namespace: ${ns}\ntype: Opaque\nstringData:\n  userdata: "#cloud-config"\n`;
  rejects(cloudInit,/assembled outside Git/);
});

test('resolve-source: the source must be on the allowlist and the name must be free',async()=>{
  const w=workflow({data:null,input:{source:'vm-golden-check'}});
  await assert.rejects(w.resolveSource(),/Source image vm-golden-check is not on the vm-instance allowlist/);
  const self=workflow({data:null,input:{name:source,source}});
  await assert.rejects(self.resolveSource(),/must not be named after its source/);
  for(const [taken,label] of [[`/contents/workloads/${name}?`,'box1-workloads-dev/workloads/site-west'],[`/contents/ci/${name}?`,'box1-workloads-dev/ci/site-west'],[`/repos/box1-org/${name}`,'repository box1-org/site-west']]){
    const c=workflow({data:null,input:{source},gh:github({taken:[taken]})});
    await assert.rejects(c.resolveSource(),new RegExp(`collides with an existing workload: ${label}`));
  }
  const ns_=workflow({data:null,input:{source},kube:cluster({['/api/v1/namespaces/'+ns]:{}})});
  await assert.rejects(ns_.resolveSource(),/collides with an existing workload: namespace site-west-dev/);
  const app=workflow({data:null,input:{source},kube:cluster({[APPS+name]:{}})});
  await assert.rejects(app.resolveSource(),/collides with an existing workload: Argo CD Application site-west/);
});

test('resolve-source: the approved revision and the disk built for it, not the first-release DataVolume',async()=>{
  const w=workflow({data:null,input:{source}});
  await w.resolveSource();
  assert.deepEqual(w.outputs,{sourceRevision:sha,sourceUrl:'https://github.com/box1-org/'+source,imageDigest:image,diskDigest:disk});
  assert.notEqual(w.outputs.diskDigest,firstDisk,'the source DataVolume is the first release disk; it would boot an older OS');
  assert.deepEqual(w.saves,[],'resolve-source creates no record');
  assert(!w.kube.calls.some(c=>/^(POST|PUT|PATCH|DELETE) (?!.*leases)/.test(c)),'read-only apart from the Lease');
});

test('resolve-source refuses a source that is not ready to be adopted',async()=>{
  const cases=[
    [{gh:github({files:sourceFiles({os:ZERO})})},/has no approved OS digest yet/],
    [{gh:github({files:sourceFiles({profile:'service'})})},/is not a virtual-machine workload/],
    [{gh:github({files:{...sourceFiles(),'datavolume.yaml':undefined}})},/has no workloads\/site-gateway-os\/datavolume.yaml/],
    [{kube:cluster(streams({diskTag:null}))},/box1-ci\/site-gateway-os-disk:c{40} does not exist/],
    [{kube:cluster({[IS+source]:{status:{tags:[{tag:sha,items:[{image:'sha256:'+'7'.repeat(64)}]}]}}})},/is not the approved OS digest/],
    [{kube:cluster({[`/apis/image.openshift.io/v1/namespaces/box1-ci/imagestreamimages/${source}-disk@${disk}`]:{image:{dockerImageMetadata:{Config:{Labels:{'box1.org/bootc-image':`box1-ci/${source}@sha256:${'7'.repeat(64)}`}}}}}})},/was built from box1-ci\/site-gateway-os@sha256:7{64}, not the approved/],
  ];
  for(const [options,pattern] of cases){const w=workflow({data:null,input:{source},...options});await assert.rejects(w.resolveSource(),pattern);}
});

test('resolve-source resumes from the record, so a later source release does not change an instance in flight',async()=>{
  const w=workflow({input:{source},gh:github({files:sourceFiles({revision:newer})})});
  await w.resolveSource();
  assert.equal(w.outputs.sourceRevision,sha);assert.equal(w.outputs.diskDigest,disk);
  assert.deepEqual(w.github.calls,[],'a resumed request reads nothing from GitHub');
  const other=workflow({input:{source:'site-gateway-os'},data:record({source:{...recordedSource,name:'other-os'}})});
  await assert.rejects(other.resolveSource(),/was requested from source other-os/);
  const vm=workflow({input:{source,profile:'vm-instance'},data:record({profile:'virtual-machine'})});
  await assert.rejects(vm.resolveSource(),/Onboarding profile does not match the original request/);
});

test('provision creates the REQUESTED record from the rendered bundle and the approved source',async()=>{
  const w=workflow({data:null});const prs=[];
  w.pullRequest=async(stage,files)=>{prs.push([stage,Object.keys(files).sort()]);};
  await w.provision();
  assert.deepEqual(w.saves,['REQUESTED']);
  assert.equal(w.data.profile,'vm-instance');assert.equal(w.data.sourceRevision,sha);assert.equal(w.data.templateVersion,'1.0.0');
  assert.deepEqual(w.data.source,recordedSource);
  assert.equal(prs.length,1);assert.equal(prs[0][0],'onboarding');assert(prs[0][1].includes(`workloads/${name}/catalog-info.yaml`));
  assert(prs[0][1].every(f=>f===`applications/${name}.yaml`||f.startsWith(`workloads/${name}/`)),'the onboarding PR touches only this instance');
});

test('provision refuses when the source was released after the template rendered, and records nothing',async()=>{
  const w=workflow({data:null,gh:github({files:sourceFiles({revision:newer})}),kube:cluster(streams({revision:newer}))});
  await assert.rejects(w.provision(),/approved revision of site-gateway-os changed from c{40} to f{40} after this request was rendered/);
  assert.deepEqual(w.saves,[]);
});

test('platform readiness: the cloud-init Secret is checked by metadata only and keeps the VM Halted until it exists',async()=>{
  const checks=PROFILES['vm-instance'].platformChecks;
  const run=async secrets=>{const w=workflow({kube:cluster({...readyObjects()},{secrets})});const results={};for(const [k,fn] of Object.entries(checks(w)))results[k]=await fn();return {w,results};};
  const missing=await run({});
  assert.match(missing.results.cloud_init_secret,/Secret site-west-dev\/site-west-cloud-init is missing: create it with box1-docs runbooks\/vm-cloud-init-identity.md \(approval required\).*stays Halted/);
  for(const [k,v] of Object.entries(missing.results))if(k!=='cloud_init_secret')assert.equal(v,true,k);
  assert(missing.w.kube.calls.includes('META '+secretPath));
  const forbidden=Object.assign(new Error('HTTP 403'),{status:403});
  assert.match((await run({[secretPath]:forbidden})).results.cloud_init_secret,/Role site-west-cloud-init-observer is not in effect/);
  assert.match((await run({[secretPath]:{metadata:{name:name+'-cloud-init'}}})).results.cloud_init_secret,/was not assembled by the/);
  assert.equal((await run({[secretPath]:assembled})).results.cloud_init_secret,true);
  assert(!Object.keys(checks(workflow())).includes('pac_repository'),'an instance has no PaC Repository');
});

test('a missing cloud-init Secret stops before promotion: no promotion PR, the VM stays Halted',async()=>{
  const w=workflow({kube:cluster({...readyObjects()}),data:record({onboardingPR:{merged:true,mergeCommit:merge},applicationsSyncedAt:'t'})});
  const prs=[];w.pullRequest=async stage=>{prs.push(stage);};
  await assert.rejects(w.buildPhase(),/wait did not complete: development platform readiness: condition=cloud_init_secret state=Secret site-west-dev\/site-west-cloud-init is missing/);
  assert.equal(w.data.imageDigest,image,'the adopted digests are kept, so a resume does not repeat them');
  await assert.rejects(w.promote(),/Platform readiness has not completed/);
  assert.deepEqual(prs,[]);
});

test('build adopts the recorded digests without a PipelineRun, and refuses pruned images',async()=>{
  const w=workflow({kube:cluster({...readyObjects()},{secrets:{[secretPath]:assembled}}),data:record({onboardingPR:{merged:true,mergeCommit:merge},applicationsSyncedAt:'t'})});
  await w.buildPhase();
  assert.deepEqual(w.saves,['IMAGE_BUILT','PLATFORM_READY']);
  assert.equal(w.data.imageDigest,image);assert.equal(w.data.diskDigest,disk);
  assert.deepEqual(w.data.adoptedFrom,{source,revision:sha,gitopsRevision:gitops});
  assert(!w.kube.calls.some(c=>c.startsWith('POST')),'no PipelineRun and no credential Secret');
  const pruned=workflow({kube:cluster({[IS+source+'-disk']:{status:{tags:[]}}})});
  await assert.rejects(PROFILES['vm-instance'].buildResults(pruned,null),/box1-ci\/site-gateway-os-disk no longer holds/);
});

test('first promotion: only this instance, the #139 vm-instance contract',async()=>{
  const files=await bundle();
  const w=workflow({data:record({imageDigest:image,diskDigest:disk})});
  w.live=Object.fromEntries(Object.entries(files).map(([f,v])=>[f,v.content]));
  const updates=await PROFILES['vm-instance'].promotionUpdates(w,files);
  assert.deepEqual(Object.keys(updates).sort(),['datavolume','kustomization','virtualmachine'].map(f=>`workloads/${name}/${f}.yaml`));
  const vm=updates[`workloads/${name}/virtualmachine.yaml`].content,dv=updates[`workloads/${name}/datavolume.yaml`].content,k=updates[`workloads/${name}/kustomization.yaml`].content;
  assert.match(vm,new RegExp(`^    box1\\.org/os-image-digest: ${image}$`,'m'));
  assert.match(vm,/^    box1\.org\/build-pipelinerun: box1-ci\/site-gateway-os-release-abcde$/m);
  assert.match(vm,/^    box1\.org\/source-image: site-gateway-os$/m);
  assert.match(vm,new RegExp(`^    box1\\.org/source-revision: ${sha}$`,'m'));
  assert.match(vm,/^  runStrategy: Always$/m);
  assert.match(dv,new RegExp(`^      url: docker://image-registry\\.openshift-image-registry\\.svc:5000/box1-ci/site-gateway-os-disk@${disk}$`,'m'));
  assert.match(k,/^  - virtualmachine\.yaml\n  - datavolume\.yaml$/m);
  // Drift on main is refused rather than overwritten.
  w.live={[`workloads/${name}/virtualmachine.yaml`]:'changed by hand'};
  await assert.rejects(PROFILES['vm-instance'].promotionUpdates(w,files),/First-release GitOps content drifted/);
});

test('verify: VM, guest agent, Argo, then the booted digest through box1-bootc-status',async()=>{
  const kube=cluster({...readyObjects(),...{}},{secrets:deployKey});
  const created=[];
  kube.handle=(method,p,body)=>{if(method==='POST'&&p===RUNS){created.push(body);kube.objects[RUNS+'/'+body.metadata.name]={metadata:{...body.metadata},status:{conditions:[{type:'Succeeded',status:'True'}],results:[{name:'booted-digest',value:image}]}};return body;}return {};};
  const w=workflow({kube,data:record({imageDigest:image,diskDigest:disk,onboardingPR:{merged:true,url:'https://github.com/box1-org/box1-workloads-dev/pull/7'},promotionPR:{merged:true},promotionSync:{revision:merge,requestedAt:null}})});
  await w.verify();
  assert.equal(created.length,1);const run=created[0];
  assert.equal(run.metadata.name,`onb-${name}-boot-aaaaaaaa`);assert(run.metadata.name.length<=63);
  assert.equal(run.metadata.labels['box1.org/onboarding-id'],id);
  assert.equal(run.spec.taskRunTemplate.serviceAccountName,'ci-vm-deploy');
  const task=run.spec.pipelineSpec.tasks[0];
  assert.equal(task.taskRef.params.find(p=>p.name==='name').value,'box1-bootc-status');
  assert.deepEqual(Object.fromEntries(task.params.map(p=>[p.name,p.value])),{'application-name':name,'application-namespace':ns,'ssh-user':'box1-status','ssh-key-secret':'vm-instance-status-ssh'});
  assert.equal(w.data.phase,'DEPLOYMENT_READY');
  assert.equal(w.data.deploymentImage,`image-registry.openshift-image-registry.svc:5000/box1-ci/${source}@${image}`);
  assert.equal(w.data.bootedDigest.digest,image);
  assert.equal(w.outputs.sourceUrl,'https://github.com/box1-org/'+source);
  assert.match(w.outputs.pipelineUrl,/PipelineRun\/onb-site-west-boot-aaaaaaaa$/);
  assert(PROFILES['vm-instance'].catalogComplete(w.data));
  assert(!PROFILES['vm-instance'].catalogComplete({...w.data,bootedDigest:undefined}),'catalog needs the booted digest');
});

test('verify fails when the guest booted another digest, and when no deploy key is provisioned',async()=>{
  const data=()=>record({imageDigest:image,diskDigest:disk,onboardingPR:{merged:true,url:'u'},promotionPR:{merged:true}});
  const kube=cluster({...readyObjects()},{secrets:deployKey});
  kube.handle=(method,p,body)=>{kube.objects[RUNS+'/'+body.metadata.name]={metadata:body.metadata,status:{conditions:[{type:'Succeeded',status:'True'}],results:[{name:'booted-digest',value:firstDisk}]}};return body;};
  const w=workflow({kube,data:data()});
  await assert.rejects(w.verify(),/booted sha256:9{64}, not the approved sha256:a{64}/);
  assert.notEqual(w.data.phase,'DEPLOYMENT_READY');
  const nokey=workflow({kube:cluster({...readyObjects()}),data:data()});
  await assert.rejects(nokey.verify(),/deploy key Secret box1-ci\/vm-instance-status-ssh does not exist. Creating it is an approval item/);
});

test('verify retries a failed booted-digest check under a new name, at most three times',async()=>{
  const kube=cluster({...readyObjects()},{secrets:deployKey});
  const first=`onb-${name}-boot-aaaaaaaa`;
  kube.objects[RUNS+'/'+first]={metadata:{name:first,labels:{'box1.org/onboarding-id':id}},status:{conditions:[{type:'Succeeded',status:'False',message:'ssh refused'}]}};
  kube.handle=(method,p,body)=>{kube.objects[RUNS+'/'+body.metadata.name]={metadata:body.metadata,status:{conditions:[{type:'Succeeded',status:'True'}],results:[{name:'booted-digest',value:image}]}};return body;};
  const w=workflow({kube,data:record({imageDigest:image,onboardingPR:{merged:true,url:'u'},promotionPR:{merged:true},bootedDigestCheck:{pipelineName:first,attempt:1}})});
  await w.verify();
  assert.equal(w.data.bootedDigest.pipelineRun,first+'-r2');
  const other=cluster({...readyObjects()},{secrets:deployKey});other.objects[RUNS+'/'+first]={metadata:{name:first,labels:{'box1.org/onboarding-id':'someone-else'}}};
  await assert.rejects(workflow({kube:other,data:record({imageDigest:image})}).verify(),/PipelineRun ownership mismatch/);
});

test('catalog: the instance entity comes from its GitOps bundle, with no source repository',async()=>{
  const target=`https://github.com/box1-org/box1-workloads-dev/tree/main/workloads/${name}/catalog-info.yaml`;
  const calls=[];let entity=null;
  // Like Backstage: managed-by-location in tree/ form, the registered URL kept as the origin.
  const registered=url=>({spec:{type:'vm-instance'},metadata:{annotations:{'box1.org/workload-profile':'vm-instance','backstage.io/managed-by-location':'url:'+url.replace('/blob/','/tree/'),'backstage.io/managed-by-origin-location':'url:'+url}}});
  const catalog={getEntityByRef:async ref=>{calls.push('get '+ref);return entity;},addLocation:async l=>{calls.push('add '+l.target);entity=registered(l.target);}};
  // Catalog actions pass only `name`: the record names the profile.
  const w=workflow({catalog,input:{profile:undefined,sourceRevision:undefined},data:record({onboardingPR:{merged:true},promotionPR:{merged:true},deploymentImage:'x',imageDigest:image,bootedDigest:{digest:image}})});
  assert.equal(w.profile,'service');
  await w.registerCatalog();
  assert.deepEqual(calls,['get component:default/site-west','add '+target,'get component:default/site-west']);
  assert.equal(w.outputs.entityRef,'component:default/site-west');assert.equal(w.outputs.catalogInfoUrl,target);
  assert.equal(w.data.phase,'COMPLETE');
  // A resumed run finds the entity registered by 1.5.0 under the blob/ URL and keeps it.
  entity=registered(`https://github.com/box1-org/box1-workloads-dev/blob/main/workloads/${name}/catalog-info.yaml`);
  calls.length=0;
  await workflow({catalog,input:{profile:undefined},data:w.data}).catalogSubmit();
  assert.deepEqual(calls,['get component:default/site-west']);
  entity=registered(`https://github.com/box1-org/box1-workloads-dev/tree/main/workloads/site-east/catalog-info.yaml`);
  await assert.rejects(workflow({catalog,input:{profile:undefined},data:w.data}).catalogSubmit(),/is not this VM instance/);
  entity=registered(`https://github.com/box1-org/other-repo/blob/main/workloads/${name}/catalog-info.yaml`);
  await assert.rejects(workflow({catalog,input:{profile:undefined},data:w.data}).catalogSubmit(),/is not this VM instance/);
  entity={spec:{type:'service'},metadata:{annotations:{'github.com/project-slug':'box1-org/site-west'}}};
  await assert.rejects(workflow({catalog,input:{profile:undefined},data:w.data}).catalogSubmit(),/is not this VM instance/);
  await assert.rejects(workflow({catalog,input:{profile:undefined},data:{...w.data,bootedDigest:undefined}}).registerCatalog(),/Catalog completion requires a verified development deployment/);
});

test('the whole delivery sequence for one instance, without a repository or a build',async()=>{
  // The namespace and Application appear only once the onboarding PR has merged.
  const later=readyObjects();const kube=cluster({},{secrets:{[secretPath]:assembled,...deployKey}});
  kube.handle=(method,p,body)=>{if(method==='POST'&&p===RUNS){kube.objects[RUNS+'/'+body.metadata.name]={metadata:body.metadata,status:{conditions:[{type:'Succeeded',status:'True'}],results:[{name:'booted-digest',value:image}]}};}return body||{};};
  const w=workflow({kube,data:null});const prs=[];
  w.pullRequest=async(stage,files)=>{prs.push([stage,Object.keys(files).sort()]);Object.assign(kube.objects,later);w.live={...w.live,...Object.fromEntries(Object.entries(files).map(([f,v])=>[f,v.content]))};await w.save(stage==='onboarding'?'ONBOARDING_MERGED':'PROMOTION_MERGED',{[stage+'PR']:{merged:true,mergeCommit:merge,url:'https://github.com/box1-org/box1-workloads-dev/pull/1'}});};
  w.requestServiceSync=async()=>{await w.save('PLATFORM_APPS_SYNCED',{applicationsSyncedAt:'t'});};
  w.requestPromotionSync=async()=>{await w.save('PROMOTION_SYNC_REQUESTED',{promotionSync:{revision:merge,requestedAt:null}});};
  await w.delivery();
  assert.deepEqual(w.saves.filter(Boolean),['REQUESTED','ONBOARDING_MERGED','PLATFORM_APPS_SYNCED','IMAGE_BUILT','PLATFORM_READY','PROMOTION_MERGED','PROMOTION_SYNC_REQUESTED','DEPLOYMENT_READY']);
  assert.deepEqual(prs.map(([s])=>s),['onboarding','promotion']);
  assert.deepEqual(prs[1][1],['datavolume','kustomization','virtualmachine'].map(f=>`workloads/${name}/${f}.yaml`));
  assert(!kube.calls.some(c=>/POST .*\/secrets/.test(c)),'no credential Secret is created');
  assert.equal(kube.calls.filter(c=>c==='POST '+RUNS).length,1,'the only PipelineRun is the read-only booted-digest check');
  // A second run with the same name resumes: nothing is repeated.
  const before=kube.calls.length;w.pullRequest=async()=>{throw new Error('must not open another PR');};
  await w.provision();await w.platform();await w.buildPhase();
  assert.deepEqual(kube.calls.slice(before),[]);
});

test('Kube.metadata fails closed when the server returns more than metadata',async()=>{
  const {Kube}=require('../plugins/box1-onboarding/workflow.cjs');
  const k=new Kube();
  k.request=async()=>({kind:'Secret',metadata:{name:'x'},data:{userdata:'c2VjcmV0'}});
  await assert.rejects(k.metadata('/api/v1/namespaces/a/secrets/x'),/did not return metadata only for \/api\/v1\/namespaces\/a\/secrets$/);
  k.request=async(method,p,body,missing,accept)=>{assert.equal(accept,'application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1');return {kind:'PartialObjectMetadata',metadata:{name:'x'}};};
  assert.equal((await k.metadata('/api/v1/namespaces/a/secrets/x')).metadata.name,'x');
  k.request=async()=>null;assert.equal(await k.metadata('/p'),null);
});
