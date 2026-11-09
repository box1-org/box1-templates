// Supplements the characterisation test (box1-docs#136 review pass 1): paths that the
// fixture does not observe. Uses only Workflow methods that exist in 1.2.0 as well, and
// passes on both 1.2.0 (main 5663eb3) and the dispatch-table code.
const test=require('node:test');const assert=require('node:assert/strict');
const {Workflow}=require('../plugins/box1-onboarding/workflow.cjs');
const sha='a'.repeat(40),digest='sha256:'+'1'.repeat(64);

function workflow(profile,kube={get:async()=>null,request:async()=>({})}){
  const name='sync-check';
  const w=new Workflow({ctx:{input:{name,sourceRevision:sha,...(profile==='service'?{}:{profile})},workspacePath:'unused',logger:{info(){}},output(){}},config:{},credentials:{},kube});
  w.data={id:'id-1',name,namespace:name+'-dev',sourceRevision:sha,...(profile==='service'?{}:{profile}),onboardingPR:{merged:true,mergeCommit:'c'.repeat(40)},history:[]};
  w.renew=async()=>{};w.saves=[];
  w.save=async(phase,extra={})=>{w.saves.push(phase);w.data={...w.data,...extra,phase:phase??w.data.phase,history:[...w.data.history,...(phase?[{phase}]:[])]};};
  return w;
}

for(const profile of ['service','virtual-machine']){
  test(`${profile}: a fresh platform phase requests the Application sync, then waits for build prerequisites`,async()=>{
    const w=workflow(profile);const events=[];
    w.requestServiceSync=async()=>{events.push('requestServiceSync');await w.save('PLATFORM_SYNC_REQUESTED',{serviceSyncRequestedAt:'2026-11-08T00:00:00.000Z'});};
    w.wait=async label=>{events.push('wait '+label);};
    await w.platform();
    assert.deepEqual(events,['requestServiceSync','wait '+(profile==='service'?'initial build prerequisites':'initial VM build prerequisites')]);
    // A retry after the request does not repeat it.
    events.length=0;await w.platform();assert.deepEqual(events,['wait '+(profile==='service'?'initial build prerequisites':'initial VM build prerequisites')]);
  });
  test(`${profile}: the build phase awaits the requested Application sync before platform readiness`,async()=>{
    const w=workflow(profile);const events=[];w.data.serviceSyncRequestedAt='2026-11-08T00:00:00.000Z';
    w.awaitApplicationSync=async(app,revision,label)=>{events.push(`awaitApplicationSync ${app} ${revision.slice(0,4)} ${label}`);};
    w.platformReady=async()=>{events.push('platformReady');};
    w.build=async()=>{events.push('build');await w.save('IMAGE_BUILT',{imageDigest:digest});};
    await w.buildPhase();
    assert.deepEqual(events.filter(e=>e!=='build'),['awaitApplicationSync sync-check cccc sync-check','platformReady']);
    assert(events.includes('build'));assert(w.data.applicationsSyncedAt);assert.equal(w.data.phase,'PLATFORM_READY');
  });
  test(`${profile}: rejected build results fail before the credential Secret is deleted`,async()=>{
    const writes=[];let run=null,secret=null;
    const kube={get:async p=>p.includes('/pipelineruns/')?run:p.includes('/secrets/')?secret:null,request:async(method,p,body)=>{writes.push(method+' '+p.split('/').slice(-1)[0]);
      if(method==='POST'&&p.endsWith('/secrets')){secret={...body,metadata:{...body.metadata,uid:'s'},data:{'git-provider-token':'eA=='}};return secret;}
      if(method==='POST'&&p.endsWith('/pipelineruns')){run={...body,metadata:{...body.metadata,uid:'r'},status:{conditions:[{type:'Succeeded',status:'True'}],results:profile==='service'?[]:[{name:'image-digest',value:digest}]}};return run;}
      if(method==='PUT'){secret=body;return body;}if(method==='DELETE'){secret=null;}return {};}};
    const w=workflow(profile,kube);w.github=async()=>({sha});w.buildToken=async()=>({token:'t',expires_at:'2999-01-01T00:00:00Z'});w.wait=async(_l,_s,fn)=>{assert.equal(await fn(),true);};
    await assert.rejects(w.build(),profile==='service'?/immutable image digest/:/immutable VM disk digest/);
    assert.deepEqual(writes,['POST secrets','POST pipelineruns','PUT onb-sync-check-aaaaaaaa-git']);
    assert.equal(w.data.imageDigest,undefined);
  });
}
