#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const iconsDir = path.join(root, 'node_modules', 'lucide-react', 'dist', 'esm');
const dynamicImportsPath = path.join(iconsDir, 'dynamicIconImports.mjs');
const outputPath = path.join(root, 'src', 'lucide-icons.json');

const rawImports = await fs.readFile(dynamicImportsPath, 'utf8');
const canonical = [];
for (const match of rawImports.matchAll(/^\s*"([^"]+)":\s*\(\)\s*=>\s*import\('\.\/icons\/([^/'"]+)\.mjs'\)/gm)) {
  const [, name, target] = match;
  if (name === target) canonical.push(name);
}
if (!canonical.length) {
  throw new Error('Could not find canonical icons in lucide-react dynamicIconImports.mjs.');
}
canonical.sort();

const catalog = Object.create(null);
for (const name of canonical) {
  const filePath = path.join(iconsDir, 'icons', `${name}.mjs`);
  const source = await fs.readFile(filePath, 'utf8');
  const match = source.match(/const __iconData = (\{[\s\S]*?\});\s*\r?\n__iconData\.node;/);
  if (!match) {
    throw new Error(`Could not extract __iconData from ${filePath}`);
  }
  const iconData = vm.runInNewContext(`(${match[1]})`);
  if (!iconData || !Array.isArray(iconData.node)) {
    throw new Error(`Invalid __iconData.node in ${filePath}`);
  }
  catalog[name] = iconData.node.map(([tag, attrs]) => {
    const cleanAttrs = {};
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k !== 'key') cleanAttrs[k] = v;
    }
    return [tag, cleanAttrs];
  });
}

await fs.writeFile(outputPath, JSON.stringify(catalog) + '\r\n', 'utf8');
console.log(`Generated ${canonical.length} canonical Lucide icons in ${path.relative(root, outputPath)}`);
