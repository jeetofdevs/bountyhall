// Builds public/vendor/near-wallet.js: the NEAR wallet selector (Meteor,
// MyNearWallet, Intear) bundled for the browser, exposed as window.BountyhallNear.
// Dependencies are installed into a temporary folder with pinned versions, so
// they never enter package.json. Run: npm run build:wallet
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const V = '10.1.4';
const PKGS = [
  `@near-wallet-selector/core@${V}`, `@near-wallet-selector/modal-ui@${V}`, `@near-wallet-selector/my-near-wallet@${V}`,
  `@near-wallet-selector/meteor-wallet@${V}`, `@near-wallet-selector/intear-wallet@${V}`,
  'buffer@6.0.3', 'util@0.12.5', 'process@0.11.10', 'esbuild@0.25.10',
];

const dir = mkdtempSync(join(tmpdir(), 'bh-wallet-'));
try {
  writeFileSync(join(dir, 'package.json'), '{"private":true}');
  execFileSync('npm', ['install', '--no-audit', '--no-fund', ...PKGS], { cwd: dir, stdio: 'inherit' });
  writeFileSync(join(dir, 'shim.js'), "import { Buffer } from 'buffer';\nimport process from 'process';\nexport { Buffer, process };\n");
  writeFileSync(join(dir, 'entry.js'), `
import { setupWalletSelector } from '@near-wallet-selector/core';
import { setupModal } from '@near-wallet-selector/modal-ui';
import { setupMyNearWallet } from '@near-wallet-selector/my-near-wallet';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
import { setupIntearWallet } from '@near-wallet-selector/intear-wallet';
window.BountyhallNear = {
  async connect({ network, contractId }) {
    const selector = await setupWalletSelector({ network, modules: [setupMeteorWallet(), setupMyNearWallet(), setupIntearWallet()] });
    const modal = setupModal(selector, { contractId });
    return { selector, modal };
  },
};
`);
  const out = join(ROOT, 'public', 'vendor');
  mkdirSync(out, { recursive: true });
  execFileSync(join(dir, 'node_modules', '.bin', 'esbuild'), [
    'entry.js', '--bundle', '--minify', '--format=iife', '--platform=browser', '--target=es2020',
    '--inject:shim.js', '--define:global=globalThis', '--legal-comments=eof', `--outfile=${join(out, 'near-wallet.js')}`,
  ], { cwd: dir, stdio: 'inherit' });
  copyFileSync(join(dir, 'node_modules', '@near-wallet-selector', 'modal-ui', 'styles.css'), join(out, 'near-wallet.css'));
  console.log('wrote public/vendor/near-wallet.js and near-wallet.css');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
