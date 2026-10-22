import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { exportImage, createPackage } from '../packages/core/src/index.js';
const input = resolve(process.argv[2]),
  output = resolve(process.argv[3]);
mkdirSync(output, { recursive: true });
const entries = JSON.parse(readFileSync(join(input, 'index.json'), 'utf8'));
const report = [];
for (const entry of entries) {
  const bytes = readFileSync(join(input, entry.file)),
    width = bytes.readUInt32LE(0),
    height = bytes.readUInt32LE(4);
  const image = {
    width,
    height,
    rgba: new Uint8Array(bytes.buffer, bytes.byteOffset + 8, bytes.length - 8),
  };
  const start = performance.now(),
    result = exportImage(image, { orientation: 'wall', longEdgeM: 8 }),
    bundle = createPackage(result);
  const dest = join(output, entry.name);
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'homeland.blueprintx'), result.blueprint);
  writeFileSync(join(dest, 'preview.png'), bundle.png);
  writeFileSync(join(dest, 'bundle.zip'), bundle.zip);
  const row = {
    name: entry.name,
    seconds: (performance.now() - start) / 1000,
    summary: result.summary,
    verification: result.verification,
    sha256: createHash('sha256').update(result.blueprint).digest('hex'),
  };
  report.push(row);
  writeFileSync(join(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(row));
}
