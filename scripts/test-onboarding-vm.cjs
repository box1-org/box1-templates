// virtual-machine onboarding profile (box1-docs#55). Run after `npm run validate`,
// which renders .validation/rhel-image-vm/<name>/gitops.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const YAML=require('yaml');
const {DELIVERY_PHASES,PROFILES,Workflow,validateVmBundle,validateBundle,validateProfile,filesAt}=require('../plugins/box1-onboarding/workflow.cjs');
const name='vm-golden-check',ns=name+'-dev',id='0b4c4f6e-6d0a-4b9a-9c1e-2f7c3a1d5e10',sha='b'.repeat(40),digest='sha256:'+'1'.repeat(64),disk='sha256:'+'2'.repeat(64),ZERO='sha256:'+'0'.repeat(64);
const bundleDir=path.resolve(__dirname,'../.validation/rhel-image-vm',name,'gitops');
function workflow(kube={},profile='virtual-machine'){const outputs={};const w=new Workflow({ctx:{input:{name,sourceRevision:sha,profile},workspacePath:'unused',logger:{info(){}},output:(k,v)=>outputs[k]=v},config:{},credentials:{},kube});w.outputs=outputs;w.data={id,name,namespace:ns,sourceRevision:sha,profile};w.renew=async()=>{};w.save=async(phase,extra={})=>{w.data={...w.data,...extra,phase:phase??w.data.phase};};return w;}
const bundle=()=>filesAt(bundleDir);
const edit=(files,file,from,to)=>{const copy=structuredClone(files);const key=`workloads/${name}/${file}`;assert(copy[key].content.includes(from),'fixture text missing: '+from);copy[key].content=copy[key].content.replace(from,to);return copy;};

test('profiles: service stays the default with its original record values',()=>{
 assert.equal(validateProfile('service'),'service');assert.equal(validateProfile('virtual-machine'),'virtual-machine');
 assert.throws(()=>validateProfile('mainframe'),/Unsupported onboarding profile/);
 assert.deepEqual(PROFILES.service,{templateVersion:'1.1.0',commitMessage:'Create Quarkus service from the Box1 golden path'});
 const w=new Workflow({ctx:{input:{name},logger:{info(){}}},config:{},credentials:{},kube:{}});assert.equal(w.profile,'service');assert.equal(w.vm,false);
});
test('a phase must run with the profile recorded for the onboarding',async()=>{
 const w=workflow();w.data.profile=undefined;await assert.rejects(w.provision(),/profile does not match/);
 const s=workflow({}, 'service');s.data.profile=undefined;s.requireProfile();
 const mixed=workflow({}, 'service');mixed.data.profile='virtual-machine';assert.throws(()=>mixed.requireProfile(),/profile does not match/);
});
test('the rendered template bundle passes the VM bundle check, and not the service one',async()=>{
 const files=await bundle();validateVmBundle(files,name);
 assert.throws(()=>validateBundle(files,name),/Onboarding must add one Application/);
});
test('VM bundle check rejects unsafe or off-contract changes',async()=>{
 const files=await bundle();
 const rejects=(changed,pattern)=>assert.throws(()=>validateVmBundle(changed,name),pattern);
 rejects(edit(files,'kustomization.yaml','  - virtualmachine.yaml\n','  - virtualmachine.yaml\n  - datavolume.yaml\n'),/DataVolume is listed only by the first promotion/);
 rejects(edit(files,'virtualmachine.yaml','runStrategy: Halted','runStrategy: Always'),/must be Halted/);
 rejects(edit(files,'virtualmachine.yaml','  runStrategy: Halted','  runStrategy: Halted\n  dataVolumeTemplates: []'),/no dataVolumeTemplates/);
 rejects(edit(files,'datavolume.yaml','-disk@'+ZERO,'-disk:latest'),/zero disk digest/);
 rejects(edit(files,'admin-access.yaml','key1: "ssh-ed25519','password: "hunter2'),/Only SSH public keys/);
 rejects(edit(files,'updater.yaml','type: kubernetes.io/service-account-token','type: kubernetes.io/service-account-token\ndata:\n  token: c2VjcmV0'),/carry no data/);
 rejects(edit(files,'onboarding.yaml','name: "system:serviceaccounts:'+ns+'"','name: "system:serviceaccounts"'),/registry pull binding/);
 rejects(edit(files,'onboarding.yaml','  - get\n---','  - get\n  - delete\n---'),/get-only/);
 rejects(edit(files,'virtualmachine.yaml','users: [cloud-user]','users: [root]'),/admin-ssh Secret through the guest agent/);
 rejects(edit(files,'virtualmachine.yaml','serial: regtoken','serial: other'),/update disks by serial/);
 rejects(edit(files,'namespace.yaml','box1.org/workload-profile: virtual-machine','box1.org/workload-profile: service'),/virtual-machine profile/);
 const extra=structuredClone(files);extra[`workloads/${name}/onboarding.yaml`].content+='\n---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: sneaky\n  namespace: '+ns+'\n';rejects(extra,/Unexpected generated resource for a VM workload: Deployment/);
 const escalate=structuredClone(files);escalate[`workloads/${name}/onboarding.yaml`].content+='\n---\napiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRoleBinding\nmetadata:\n  name: escalated\n';rejects(escalate,/Unexpected generated resource/);
});
test('VM repository marker records the profile; service marker keeps its original shape',async()=>{
 for(const profile of ['virtual-machine','service']){
  const w=workflow({},profile);w.data=null;const puts=[];
  w.ctx.input={...w.ctx.input,owner:'user:default/mike',visibility:'private',description:'A RHEL 10 image mode virtual machine'};
  w.save=async(phase,extra={})=>{w.data={...(w.data||{}),...extra,phase:phase??w.data?.phase};};
  w.github=async(p,method,body)=>{if(p.endsWith('/contents/.box1/onboarding.json')&&method==='PUT'){puts.push(JSON.parse(Buffer.from(body.content,'base64').toString()));return {};}if(p===`/repos/box1-org/${name}`&&method!=='PATCH')return null;if(p==='/orgs/box1-org/repos')return {description:body.description,size:0};return {};};
  w.content=async()=>null;w.data=null;
  w.data=undefined;
  // Stop after the marker is written: the skeleton commit is covered by the existing service tests.
  w.github=((orig)=>async(p,method,body)=>{if(p.includes('/git/ref/heads/main'))throw new Error('stop');return orig(p,method,body);})(w.github);
  await assert.rejects(w.repository(),/stop|ENOENT/);
  assert.equal(w.data.templateVersion,PROFILES[profile].templateVersion);
  const marker=puts[0];
  if(profile==='service'){assert.deepEqual(Object.keys(marker),['id','name','namespace','owner','templateVersion']);assert.equal(w.data.profile,undefined);}
  else{assert.equal(marker.profile,'virtual-machine');assert.equal(w.data.profile,'virtual-machine');}
 }
});
test('VM build barrier waits for the bootc release identity and privileged binding',async()=>{
 const got={};const kube={get:async p=>got[p]};const w=workflow(kube);const states=[];w.wait=async(_l,_s,fn)=>{states.push(await fn());};
 await w.buildBarrier();assert.equal(states.at(-1),ns+' Namespace Active');
 got['/api/v1/namespaces/'+ns]={status:{phase:'Active'}};got['/api/v1/namespaces/box1-ci/serviceaccounts/ci-bootc-release']={};
 got['/apis/rbac.authorization.k8s.io/v1/namespaces/box1-ci/rolebindings/ci-bootc-release-image-builder']={roleRef:{name:'system:image-builder'},subjects:[{name:'ci-bootc-release',namespace:'box1-ci'}]};
 await w.buildBarrier();assert.equal(states.at(-1),'bootc privileged build permission');
 got['/apis/rbac.authorization.k8s.io/v1/namespaces/box1-ci/rolebindings/ci-bootc-privileged-scc']={roleRef:{name:'system:openshift:scc:privileged'},subjects:[{name:'ci-bootc-release',namespace:'box1-ci'}]};
 await w.buildBarrier();assert.equal(states.at(-1),true);
});
test('VM platform readiness checks the updater, Group pull binding and VirtualMachine instead of a Deployment',async()=>{
 const w=workflow();const checks=w.vmPlatformChecks();
 assert.deepEqual(Object.keys(checks),['namespace','serviceaccounts','registry_pull','registry_push','observer_rbac','pac_repository','argo_application','virtual_machine']);
 const kube={get:async p=>p.endsWith(`/rolebindings/${name}-image-puller`)?{roleRef:{name:'system:image-puller'},subjects:[{kind:'Group',name:'system:serviceaccounts:'+ns}]}:p.endsWith(`/virtualmachines/${name}`)?{spec:{runStrategy:'Halted'}}:null};
 w.kube=kube;const fresh=w.vmPlatformChecks();assert.equal(await fresh.registry_pull(),true);assert.equal(await fresh.virtual_machine(),true);assert.match(await fresh.serviceaccounts(),new RegExp(ns+'/'+name+'-updater'));
});
test('VM first build runs bootc build, disk and channel as ci-bootc-release and keeps the disk digest',async()=>{
 const created=[];let run;const kube={
  get:async p=>{if(p.endsWith('/secrets/onb-'+name+'-'+sha.slice(0,8)+'-git'))return created.find(c=>c.kind==='Secret');if(p.includes('/pipelineruns/'))return run;return null;},
  request:async(method,p,body)=>{if(method==='POST'&&body.kind==='Secret'){const s={...body,metadata:{...body.metadata,uid:'s1'},data:{'git-provider-token':'eA=='}};created.push(s);return s;}
   if(method==='POST'&&body.kind==='PipelineRun'){created.push(body);run={...body,metadata:{...body.metadata,uid:'r1'},status:{conditions:[{type:'Succeeded',status:'True'}],results:[{name:'image-digest',value:digest},{name:'disk-digest',value:disk}]}};return run;}return {};}};
 const w=workflow(kube);w.github=async()=>({sha});w.buildToken=async()=>({token:'t',expires_at:new Date(Date.now()+3600e3).toISOString()});w.wait=async(_l,_s,fn)=>{await fn();};
 await w.build();
 const pr=created.find(c=>c.kind==='PipelineRun');
 assert.equal(pr.spec.taskRunTemplate.serviceAccountName,'ci-bootc-release');
 assert.deepEqual(pr.spec.pipelineSpec.tasks.map(t=>[t.name,t.taskRef.params.find(p=>p.name==='name').value,t.runAfter?.[0]]),[['build','box1-bootc-build',undefined],['disk','box1-bootc-disk','build'],['channel','box1-bootc-channel','disk']]);
 const params=Object.fromEntries(pr.spec.pipelineSpec.tasks.map(t=>[t.name,Object.fromEntries(t.params.map(p=>[p.name,p.value]))]));
 assert.equal(params.build['push-image'],'true');assert.equal(params.build['git-auth-secret'],'onb-'+name+'-'+sha.slice(0,8)+'-git');assert.equal(params.disk.channel,'development');assert.equal(params.channel['image-digest'],'$(tasks.build.results.image-digest)');
 assert.equal(w.data.imageDigest,digest);assert.equal(w.data.diskDigest,disk);
});
test('VM first build refuses a run without a disk digest',async()=>{
 const run={metadata:{labels:{'box1.org/onboarding-id':id}},status:{conditions:[{type:'Succeeded',status:'True'}],results:[{name:'image-digest',value:digest}]}};
 const w=workflow({get:async p=>p.includes('/pipelineruns/')?run:null,request:async()=>({})});w.data.pipelineName='onb-'+name+'-'+sha.slice(0,8);w.wait=async(_l,_s,fn)=>{await fn();};
 await assert.rejects(w.build(),/immutable VM disk digest/);
});
test('VM first promotion pins the disk, lists the DataVolume and starts the VM, and nothing else',async()=>{
 const files=await bundle();const w=workflow();w.data={...w.data,imageDigest:digest,diskDigest:disk,pipelineName:'onb-'+name+'-'+sha.slice(0,8),history:[{phase:'PLATFORM_READY'}]};
 w.content=async(_repo,file)=>files[file].content;let promoted;w.pullRequest=async(stage,updates)=>{assert.equal(stage,'promotion');promoted=updates;};w.requestPromotionSync=async()=>{};
 w.gitopsFiles=async()=>files;await w.promote();
 const base=`workloads/${name}/`;assert.deepEqual(Object.keys(promoted).sort(),[base+'datavolume.yaml',base+'kustomization.yaml',base+'virtualmachine.yaml']);
 const vm=YAML.parseAllDocuments(promoted[base+'virtualmachine.yaml'].content).map(d=>d.toJSON()).find(Boolean);
 assert.equal(vm.spec.runStrategy,'Always');assert.equal(vm.metadata.annotations['box1.org/os-image-digest'],digest);assert.equal(vm.metadata.annotations['box1.org/source-revision'],sha);assert.equal(vm.metadata.annotations['box1.org/build-pipelinerun'],'box1-ci/onb-'+name+'-'+sha.slice(0,8));
 assert.match(promoted[base+'datavolume.yaml'].content,new RegExp(name+'-disk@'+disk));
 assert.deepEqual(YAML.parse(promoted[base+'kustomization.yaml'].content).resources,['namespace.yaml','updater.yaml','admin-access.yaml','virtualmachine.yaml','datavolume.yaml','onboarding.yaml']);
 // Drift in box1-workloads-dev is refused.
 w.content=async()=>'drifted';await assert.rejects(w.promote(),/GitOps content drifted/);
});
test('VM verify waits for disk import, boot and guest agent, and fails at once on a failed import',async()=>{
 const state={app:{status:{sync:{status:'Synced'},health:{status:'Healthy'}}},vm:{metadata:{annotations:{'box1.org/os-image-digest':digest}},status:{conditions:[]}},dv:{status:{phase:'ImportInProgress',progress:'40%'}},vmi:null};
 const kube={get:async p=>p.includes('/applications/')?state.app:p.includes('/virtualmachines/')?state.vm:p.includes('/datavolumes/')?state.dv:p.includes('/virtualmachineinstances/')?state.vmi:null};
 const w=workflow(kube);w.data={...w.data,imageDigest:digest,pipelineName:'onb-x',onboardingPR:{url:'https://example/pr/1'},sourceUrl:'https://github.com/box1-org/'+name};
 const seen=[];w.wait=async(_l,_s,fn)=>{let r;for(let i=0;i<5;i++){r=await fn();seen.push(r);if(r===true)return;
  if(i===0)state.dv={status:{phase:'Succeeded'}};if(i===1)state.vm.status.conditions=[{type:'Ready',status:'True'}];if(i===2)state.vmi={status:{conditions:[{type:'AgentConnected',status:'True'}]}};}throw new Error(String(r));};
 await w.verify();
 assert.deepEqual(seen,['root disk imported (ImportInProgress 40%)','VirtualMachine Ready','guest agent connected',true]);
 assert.equal(w.data.deploymentImage,`image-registry.openshift-image-registry.svc:5000/box1-ci/${name}@${digest}`);
 assert.match(w.outputs.deploymentUrl,new RegExp(`/k8s/ns/${ns}/kubevirt.io~v1~VirtualMachine/${name}$`));
 const failed=workflow({get:async p=>p.includes('/datavolumes/')?{status:{phase:'Failed',conditions:[{message:'manifest unknown'}]}}:p.includes('/virtualmachines/')?state.vm:state.app});
 failed.data={...failed.data,imageDigest:digest};failed.wait=async(_l,_s,fn)=>{await fn();};
 await assert.rejects(failed.verify(),/Root disk import failed: manifest unknown/);
});
test('the VM template runs the same delivery phases with the virtual-machine profile',async()=>{
 const template=YAML.parse(await fs.readFile(path.resolve(__dirname,'../templates/rhel-image-vm/template.yaml'),'utf8'));
 const registered=await fs.readFile(path.resolve(__dirname,'../plugins/box1-onboarding/index.cjs'),'utf8');
 const operationFor=action=>registered.match(new RegExp(`action\\('${action}','([a-zA-Z]+)'`))?.[1];
 const steps=template.spec.steps;const actions=steps.map(s=>s.action);
 assert.deepEqual(actions.filter(a=>a.startsWith('box1:development:')).map(operationFor),DELIVERY_PHASES);
 for(const step of steps.filter(s=>s.action.startsWith('box1:development:')||s.action==='box1:repository:ensure'))assert.equal(step.input.profile,'virtual-machine',step.id);
 assert(actions.indexOf('box1:catalog:submit')<actions.indexOf('box1:development:provision'));assert.equal(actions.at(-1),'box1:catalog:verify');
 assert.match(registered,/profile:\{type:'string',enum:\['service','virtual-machine'\]/);
});
