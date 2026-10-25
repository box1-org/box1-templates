// Copy the canonical plugin into its GitOps ConfigMap transport and update rollout checksum.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..');
const hub=path.resolve(root,'../box1-gitops/platform/developer-hub');
const target=path.join(hub,'onboarding/plugin');fs.mkdirSync(target,{recursive:true});
let source='';
for(const name of ['package.json','index.cjs','workflow.cjs']) {
 const content=fs.readFileSync(path.join(root,'plugins/box1-onboarding',name));source+=content;
 fs.writeFileSync(path.join(target,name),content);
}
const checksum=crypto.createHash('sha256').update(source).digest('hex');
const backstage=path.join(hub,'backstage.yaml');
let text=fs.readFileSync(backstage,'utf8');
text=text.replace(/box1.org\/onboarding-plugin-sha: .+/, 'box1.org/onboarding-plugin-sha: '+checksum);
fs.writeFileSync(backstage,text);
console.log('Packaged onboarding plugin '+checksum);
