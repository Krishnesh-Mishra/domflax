// Copy the root README + LICENSE into the published `domflax` package so they
// appear on the npm page and never drift. Run from prepublishOnly (and anytime).
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = join(root, 'packages', 'domflax');

for (const file of ['README.md', 'LICENSE']) {
  copyFileSync(join(root, file), join(pkg, file));
  console.log(`synced ${file} -> packages/domflax/${file}`);
}
