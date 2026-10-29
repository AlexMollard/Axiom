import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {search} from '../src/memory.mjs';
import {corpus, queries} from '../tests/fixtures/retrieval/corpus.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-retrieval-bench-'));
const k = 5;
const eligible = n => ['work', 'global'].includes(n.project) && !['stale', 'retired', 'superseded', 'archived'].includes(n.status) && !/^Agents\/(Handovers|Proposals)\//.test(n.path);
function content(n) {
  return `---\r\nproject: ${n.project}\r\n${n.status ? `status: ${n.status}\r\n` : ''}${n.conflicts_with ? `conflicts_with: ${n.conflicts_with}\r\n` : ''}---\r\n# ${n.title}\r\n${n.body.replace(/\n/g, '\r\n')}\r\n`;
}
function oldRank(query) {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) || [])].filter(w => !['the','and','for','this','that','with','from','have','please','what','how','can','you'].includes(w));
  if (!words.length) return [];
  return corpus.filter(eligible).map(n => {
    const text = content(n).toLowerCase(), title = n.title.toLowerCase();
    const hits = words.filter(word => text.includes(word) || title.includes(word));
    return {path: n.path, score: hits.length / words.length * 10 + hits.filter(word => title.includes(word)).length + (text.includes(query.toLowerCase().trim()) ? 5 : 0), hits: hits.length};
  }).filter(n => n.hits).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, k).map(n => n.path);
}
function metrics(results) {
  let precision = 0, returnedPrecision = 0, recall = 0, mrr = 0, leaks = 0;
  let positives = 0, negatives = 0, correctNegatives = 0;
  for (let i = 0; i < queries.length; i++) {
    const relevant = new Set(queries[i].relevant), found = results[i].slice(0, k), hits = found.filter(p => relevant.has(p));
    leaks += found.filter(p => !eligible(corpus.find(n => n.path === p))).length;
    if (!relevant.size) { negatives++; if (!found.length) correctNegatives++; continue; }
    positives++;
    precision += hits.length / k;
    returnedPrecision += found.length ? hits.length / found.length : 0;
    recall += hits.length / relevant.size;
    const rank = found.findIndex(p => relevant.has(p));
    mrr += rank < 0 ? 0 : 1 / (rank + 1);
  }
  return {
    positiveQueries: positives, negativeQueries: negatives,
    precisionAtK: precision / positives, precisionOfReturnedAtK: returnedPrecision / positives,
    recallAtK: recall / positives, mrrAtK: mrr / positives,
    negativeQueryPassRate: negatives ? correctNegatives / negatives : null, scopeLeaks: leaks
  };
}
try {
  const before = process.memoryUsage(), firstPassMs = [], warmMs = [], firstQueryColdMs = [];
  let results;
  for (let run = 0; run < 3; run++) {
    const vault = path.join(root, `vault-${run}`);
    const config = {vault, backupDir: path.join(root, `backup-${run}`), projects: [{id: 'work', root: path.join(root, 'work')}, {id: 'home', root: path.join(root, 'home')}]};
    for (const n of corpus) {
      const file = path.join(vault, n.path);
      await fs.mkdir(path.dirname(file), {recursive: true});
      await fs.writeFile(file, content(n));
    }
    for (let pass = 0; pass < 2; pass++) {
      const passResults = [];
      for (const q of queries) {
        const start = performance.now();
        const result = await search(config, q.query, {cwd: path.join(root, 'work'), limit: k});
        (pass ? warmMs : firstPassMs).push(performance.now() - start);
        if (!pass && q === queries[0]) firstQueryColdMs.push(firstPassMs.at(-1));
        passResults.push(result.items.map(item => item.path));
      }
      results = passResults;
    }
  }
  console.log(JSON.stringify({corpus: 'shared fictional fixture', notes: corpus.length, queries: queries.length, k, baseline: {...metrics(queries.map(q => oldRank(q.query))), method: 'Original substring ranking with the current eligibility policy; ranking quality only, not historical runtime performance.'}, fts: metrics(results), cases: queries.map((q, i) => ({...q, actual: results[i]})), latency: {scope: 'Three independent temporary vaults in one process. Only firstQueryColdMs includes construction for each vault; later first-pass queries reuse its index. Second pass is warm. Milliseconds, not a process-cold benchmark.', firstQueryColdMs, firstPassMs, warmPassMs: warmMs}, memory: {scope: 'Whole process before and after all runs, not isolated index memory or peak RAM.', before, after: process.memoryUsage()}}, null, 2));
} finally { await fs.rm(root, {recursive: true, force: true}); }
