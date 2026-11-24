import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');

const { run } = await import(new URL('./solve.js', import.meta.url).href);

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const raw = readFileSync(join(inDir, 'cases.json'), 'utf8');
const parsed = JSON.parse(raw);
const done = [];
for (const entry of parsed) done.push(run(entry.input));
writeFileSync(join(outDir, 'answers.json'), JSON.stringify(done));
