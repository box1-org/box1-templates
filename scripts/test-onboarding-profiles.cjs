// Profile dispatch table (box1-docs#136): the extension point and its verification
// scenarios. The test-only profiles below are added to PROFILES for the duration of a
// test and removed again; they are never registered in the Hub.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {DELIVERY_PHASES,PROFILES,Workflow,profileInputSchema}=require('../plugins/box1-onboarding/workflow.cjs');
const sha='a'.repeat(40),digest='sha256:'+'1'.repeat(64),disk='sha256:'+'2'.repeat(64);

function workflow(name,profile,{data,input={},kube={get:async()=>null,request:async()=>({})},catalog}={}){
  const outputs={},logs=[];
  const ctx={input:{name,sourceRevision:sha,...(profile?{profile}:{}),...input},workspacePath:'unused',logger:{info:m=>logs.push(m)},output:(k,v)=>{outputs[k]=v;},getInitiatorCredentials:async()=>({})};
  const w=new Workflow({ctx,config:{},credentials:{},kube,catalog});
  Object.assign(w,{outputs,logs});w.renew=async()=>{};
  w.data=data===undefined?{id:'id-1',name,namespace:name+'-dev',sourceRevision:sha,...(profile&&profile!=='service'?{profile}:{})}:data;
  w.saves=[];w.save=async(phase,extra={})=>{w.saves.push(phase);w.data={...(w.data||{}),...extra,phase:phase??w.data?.phase,history:[...(w.data?.history||[]),...(phase?[{phase}]:[])]};};
  return w;
}
async function withProfile(name,entry,fn){PROFILES[name]=entry;try{return await fn();}finally{delete PROFILES[name];}}
const catalogDouble=name=>{const calls=[];let entity=null;return {calls,getEntityByRef:async ref=>{calls.push('get '+ref);return entity;},addLocation:async l=>{calls.push('add '+l.target);entity={metadata:{annotations:{'github.com/project-slug':'box1-org/'+name}}};}};};
const forbidden=label=>()=>{throw new Error('must not run: '+label);};

// A profile with a source repository and a build, but no GitOps workload (the shape of #137's artifact).
const noWorkload=()=>({
  templateVersion:'0.1.0',commitMessage:'Create test artifact',
  recordFields:w=>({profile:w.profile}),markerFields:w=>({profile:w.profile}),
  validateBundle:null,buildBarrier:null,platformChecks:null,
  buildSpec:null,buildResults:async()=>({imageDigest:digest}),
  promotionUpdates:null,
  verify:async w=>{await w.save('ARTIFACT_VERIFIED',{artifactVerifiedAt:'now'});w.ctx.output('imageDigest',w.data.imageDigest);},
  catalogComplete:data=>Boolean(data?.imageDigest&&data.artifactVerifiedAt),
});
// A profile with a GitOps workload but no source repository and no build (the shape of #138's vm-instance).
const noSource=()=>({
  templateVersion:'0.1.0',commitMessage:null,sourceRepository:false,
  initialRecord:async w=>({sourceRevision:w.ctx.input.sourceRevision}),
  recordFields:w=>({profile:w.profile}),markerFields:()=>({}),
  validateBundle:files=>files,buildBarrier:null,
  platformChecks:w=>({namespace:async()=>(await w.kube.get('/api/v1/namespaces/'+w.ns))?true:w.ns+' Namespace Active'}),
  buildSpec:null,buildResults:async()=>({imageDigest:digest,diskDigest:disk}),
  promotionUpdates:async(w,files)=>({'workloads/x.yaml':{content:'promoted '+w.data.imageDigest,mode:'100644'},...files}),
  verify:async w=>{await w.save('DEPLOYMENT_READY',{deploymentImage:'x@'+w.data.imageDigest});},
  catalogComplete:data=>Boolean(data?.deploymentImage),
});

test('an unknown profile is rejected before any work',()=>{
  assert.throws(()=>workflow('orders-api','mainframe'),/^Error: Unsupported onboarding profile$/);
  assert.throws(()=>workflow('orders-api','constructor'),/Unsupported onboarding profile/,'inherited object keys are not profiles');
});

test('a profile that differs from the stored record is rejected by every phase that checks it',async()=>{
  await withProfile('test-artifact',noWorkload(),async()=>{
    const w=workflow('site-gateway','test-artifact',{data:{id:'id-1',sourceRevision:sha}});
    // verify has never checked the profile (unchanged); provision and promote do.
    for(const phase of ['provision','promote'])await assert.rejects(w[phase](),/Onboarding profile does not match the original request/,phase);
    const vm=workflow('site-gateway','test-artifact',{data:{id:'id-1',sourceRevision:sha,profile:'virtual-machine'}});
    await assert.rejects(vm.provision(),/Onboarding profile does not match the original request/);
  });
  const service=workflow('orders-api','service',{data:{id:'id-1',sourceRevision:sha,profile:'virtual-machine'}});
  await assert.rejects(service.provision(),/Onboarding profile does not match the original request/);
});

for(const profile of ['service','virtual-machine']){
  test(`${profile}: resume after PLATFORM_READY and IMAGE_BUILT repeats no platform or build work`,async()=>{
    const calls=[];const kube={get:async p=>{calls.push(p);return null;},request:async(m,p)=>{calls.push(m+' '+p);return {};}};
    const w=workflow('resume-check',profile,{kube});
    Object.assign(w.data,{onboardingPR:{merged:true,mergeCommit:'c'.repeat(40)},applicationsSyncedAt:'t',imageDigest:digest,diskDigest:disk,phase:'PLATFORM_READY',history:[{phase:'IMAGE_BUILT'},{phase:'PLATFORM_READY'}]});
    w.wait=forbidden('wait');w.build=forbidden('build');w.requestServiceSync=forbidden('requestServiceSync');
    await w.platform();await w.buildPhase();
    assert.deepEqual(calls,[]);assert.deepEqual(w.saves,[]);
  });
  test(`${profile}: a catalog step without a profile input completes from the stored record`,async()=>{
    const cat=catalogDouble('catalog-check');
    const w=workflow('catalog-check',undefined,{catalog:cat,input:{sourceRevision:undefined}});
    Object.assign(w.data,{...(profile==='service'?{}:{profile}),onboardingPR:{merged:true},promotionPR:{merged:true},deploymentImage:'image@'+digest});
    assert.equal(w.profile,'service','catalog actions have no profile input');
    await w.registerCatalog();
    assert.deepEqual(w.saves,['CATALOG_SUBMITTING','CATALOG_SUBMITTED','CATALOG_REGISTERING','COMPLETE']);
    assert.equal(w.outputs.entityRef,'component:default/catalog-check');
    delete w.data.deploymentImage;await assert.rejects(w.registerCatalog(),/Catalog completion requires a verified development deployment/);
  });
}

test('a test-only profile is one table entry: it joins the action enum and supplies its record and marker fields',async()=>{
  assert.deepEqual(profileInputSchema().enum,['service','virtual-machine','artifact']);
  await withProfile('test-artifact',noWorkload(),async()=>{
    assert.deepEqual(profileInputSchema().enum,['service','virtual-machine','artifact','test-artifact']);
    // Repository: record and marker fields come from the entry.
    const r=workflow('site-gateway','test-artifact',{data:null,input:{owner:'user:default/mike',visibility:'private',description:'Test artifact'}});
    r.ctx.workspacePath=fs.mkdtempSync(path.join(os.tmpdir(),'box1-profile-'));fs.mkdirSync(path.join(r.ctx.workspacePath,'application'));
    let marker;r.github=async(p,method,body,options={})=>{if(p.endsWith('/contents/.box1/onboarding.json')&&method==='PUT'){marker=JSON.parse(Buffer.from(body.content,'base64').toString());return {};}if(p.includes('/git/ref/heads/main'))throw new Error('stop after marker');if(options.missing)return null;if(p==='/orgs/box1-org/repos')return {description:body.description,size:0};return {};};
    await assert.rejects(r.repository(),/stop after marker/);
    assert.equal(r.data.templateVersion,'0.1.0');assert.equal(r.data.profile,'test-artifact');
    assert.deepEqual(Object.keys(marker),['id','name','namespace','owner','templateVersion','profile']);
  });
  assert.equal(PROFILES['test-artifact'],undefined,'the test profile is removed again');
});

test('a profile without a GitOps workload skips provision and promotion, and its catalog predicate needs no deploymentImage',async()=>{
  await withProfile('test-artifact',noWorkload(),async()=>{
    const cat=catalogDouble('site-gateway');
    const w=workflow('site-gateway','test-artifact',{catalog:cat});
    w.gitopsFiles=forbidden('gitopsFiles');w.pullRequest=forbidden('pullRequest');w.requestServiceSync=forbidden('requestServiceSync');
    w.requestPromotionSync=forbidden('requestPromotionSync');w.wait=forbidden('wait');
    await w.delivery();
    assert.deepEqual(w.saves,['IMAGE_BUILT','PLATFORM_READY','ARTIFACT_VERIFIED']);
    assert.equal(w.data.deploymentImage,undefined);assert.equal(w.outputs.imageDigest,digest);
    assert(w.logs.some(l=>/phase=provision state=skipped reason=profile_has_no_gitops_bundle/.test(l)));
    assert(w.logs.some(l=>/phase=promote state=skipped reason=profile_has_no_gitops_bundle/.test(l)));
    // Catalog actions pass only `name`; the record names the profile and its predicate.
    const c=workflow('site-gateway',undefined,{catalog:cat,data:w.data,input:{sourceRevision:undefined}});
    await c.registerCatalog();assert.equal(c.data.phase,'COMPLETE');
    const incomplete=workflow('site-gateway',undefined,{catalog:cat,data:{...w.data,artifactVerifiedAt:undefined}});
    await assert.rejects(incomplete.registerCatalog(),/Catalog completion requires a verified development deployment/);
    // A skipped phase still refuses another onboarding's source revision.
    const other=workflow('site-gateway','test-artifact',{data:{...w.data,sourceRevision:'f'.repeat(40)}});
    await assert.rejects(other.provision(),/Missing or mismatched repository checkpoint/);
  });
});

test('a profile without a source repository or build creates its record in provision and adopts its digests',async()=>{
  await withProfile('test-instance',noSource(),async()=>{
    const r=workflow('site-west','test-instance',{data:null,input:{owner:'o',visibility:'private',description:'d'}});
    await assert.rejects(r.repository(),/The test-instance onboarding profile has no source repository/);
    const kube={get:async p=>p==='/api/v1/namespaces/site-west-dev'?{}:null,request:async()=>({})};
    const w=workflow('site-west','test-instance',{data:null,kube});const prs=[];
    w.gitopsFiles=async()=>{w.checkpoint();return {'workloads/site-west/vm.yaml':{content:'vm',mode:'100644'}};};
    w.pullRequest=async(stage,files)=>{prs.push([stage,Object.keys(files).sort()]);await w.save(stage==='onboarding'?'ONBOARDING_MERGED':'PROMOTION_MERGED',{[stage+'PR']:{merged:true,mergeCommit:'c'.repeat(40)}});};
    w.requestServiceSync=async()=>{await w.save('PLATFORM_APPS_SYNCED',{applicationsSyncedAt:'t'});};w.requestPromotionSync=async()=>{};
    w.build=(orig=>async()=>{w.builds=(w.builds||0)+1;return orig.call(w);})(w.build);
    w.wait=async(_label,_s,observe)=>{assert.equal(await observe(),true);};
    await w.delivery();
    assert.equal(w.data.profile,'test-instance');assert.equal(w.data.sourceRevision,sha);assert.equal(w.data.templateVersion,'0.1.0');
    assert.equal(w.builds,1,'buildResults runs once without a PipelineRun');
    assert.equal(w.data.imageDigest,digest);assert.equal(w.data.diskDigest,disk);
    assert.deepEqual(prs,[['onboarding',['workloads/site-west/vm.yaml']],['promotion',['workloads/site-west/vm.yaml','workloads/x.yaml']]]);
    assert.deepEqual(w.saves,['REQUESTED','ONBOARDING_MERGED','PLATFORM_APPS_SYNCED','IMAGE_BUILT','PLATFORM_READY','PROMOTION_MERGED','DEPLOYMENT_READY']);
  });
});

test('a profile with no build at all never starts one',async()=>{
  await withProfile('test-nobuild',{...noWorkload(),buildResults:null},async()=>{
    const w=workflow('no-build','test-nobuild');w.save=async(phase)=>{(w.saves||=[]).push(phase);w.data.history=[...(w.data.history||[]),{phase}];};w.saves=[];
    w.build=forbidden('build');await w.buildPhase();assert.deepEqual(w.saves,['PLATFORM_READY']);
  });
});

test('every table entry declares the whole handler contract',()=>{
  const keys=['templateVersion','commitMessage','recordFields','markerFields','validateBundle','buildBarrier','platformChecks','buildSpec','buildResults','promotionUpdates','verify','catalogComplete'];
  for(const [name,entry] of Object.entries(PROFILES)){
    for(const key of keys)assert(Object.hasOwn(entry,key),`${name} must declare ${key} (null when absent)`);
    assert.equal(typeof entry.templateVersion,'string');assert.equal(typeof entry.catalogComplete,'function');
    // A PipelineRun build needs buildResults to read its digests; otherwise the Secret is left behind.
    if(entry.buildSpec)assert.equal(typeof entry.buildResults,'function',`${name}: buildSpec requires buildResults`);
    if(entry.sourceRepository!==false)assert.equal(typeof entry.commitMessage,'string',`${name}: a source repository needs a commitMessage`);
  }
  assert.deepEqual(DELIVERY_PHASES,['provision','platform','buildPhase','promote','verify']);
});
