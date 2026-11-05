import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root=path.resolve(import.meta.dirname,'..');
const hubRoot=process.env.BOX1_GITOPS_ROOT||path.resolve(root,'../box1-gitops');
const hub=path.join(hubRoot,'platform/developer-hub');
const names=['package.json','index.cjs','workflow.cjs'];
let source='';
for(const name of names){
  const canonical=fs.readFileSync(path.join(root,'plugins/box1-onboarding',name));
  const packaged=fs.readFileSync(path.join(hub,'onboarding/plugin',name));
  if(!canonical.equals(packaged)) throw new Error(`Packaged onboarding plugin drift: ${name}`);
  source+=canonical;
}
const expected=crypto.createHash('sha256').update(source).digest('hex');
const backstage=fs.readFileSync(path.join(hub,'backstage.yaml'),'utf8');
const actual=backstage.match(/box1\.org\/onboarding-plugin-sha:\s*([^\s]+)/)?.[1];
if(actual!==expected) throw new Error(`Packaged onboarding checksum drift: expected ${expected}, found ${actual||'missing'}`);
console.log(`Onboarding package is synchronized (${expected})`);
