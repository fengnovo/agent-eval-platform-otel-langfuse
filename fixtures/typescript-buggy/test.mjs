import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync(
  new URL('./src/math.ts', import.meta.url),
  'utf8',
);
assert.match(
  source,
  /return\s+a\s*\+\s*b\s*;/,
  'add() should return numeric a + b directly',
);
