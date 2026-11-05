// Return a kubectl to render Kustomize trees: the one on PATH, or a pinned, verified download.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 'v1.35.0';
const SHA256 = 'a2e984a18a0c063279d692533031c1eff93a262afcc0afdc517375432d060989';
const cached = path.resolve(import.meta.dirname, '../node_modules/.cache/box1-tools/kubectl');

export async function resolveKubectl() {
  try {
    execFileSync('kubectl', ['version', '--client'], { stdio: 'ignore' });
    return 'kubectl';
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (fs.existsSync(cached)) return cached;
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('kubectl is required on PATH');
  const response = await fetch(`https://dl.k8s.io/release/${VERSION}/bin/linux/amd64/kubectl`);
  if (!response.ok) throw new Error(`kubectl download returned HTTP ${response.status}`);
  const binary = Buffer.from(await response.arrayBuffer());
  const actual = crypto.createHash('sha256').update(binary).digest('hex');
  if (actual !== SHA256) throw new Error(`kubectl checksum mismatch: ${actual}`);
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  fs.writeFileSync(cached, binary, { mode: 0o755 });
  return cached;
}
