import * as fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {loadConfig, hash} from '../src/memory.mjs';
import {embeddingSettings} from '../src/embeddings.mjs';
import {configureEmbeddings} from '../src/management.mjs';

const MODEL = 'axiom-qwen3-embedding:latest';
// Official Qwen/Qwen3-Embedding-0.6B-GGUF Q8_0 LFS SHA-256, not a registry alias.
const WEIGHTS_SHA256 = '06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439';

async function local(endpoint, route, body) {
  const response = await fetch(endpoint + route, {method: body ? 'POST' : 'GET', headers: body ? {'content-type': 'application/json'} : undefined, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(`Ollama ${route} returned HTTP ${response.status}.`);
  return response.json();
}
async function importModel(endpoint, modelFile) {
  const child = spawn('ollama', ['create', MODEL, '-f', modelFile], {env: {...process.env, OLLAMA_HOST: endpoint}, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']});
  let stderr = '';
  child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-32768); });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`Ollama import failed (${signal || code}): ${stderr}`)));
  });
}

async function main() {
  const flags = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--disable') flags.disable = true;
    else if (['--config', '--endpoint', '--model-file'].includes(name) && args[i + 1] && !args[i + 1].startsWith('--')) flags[name.slice(2)] = args[++i];
    else throw new Error('Usage: node scripts/setup-embeddings.mjs [--config path] --model-file Qwen3-Embedding-0.6B-Q8_0.gguf [--endpoint http://127.0.0.1:11434], or --disable.');
  }
  const config = await loadConfig(flags.config);
  const before = await fs.readFile(config.configPath);
  if (flags.disable) {
    await configureEmbeddings(config, {...config.embeddings, enabled: false}, hash(before));
    console.log(JSON.stringify({enabled: false, restartRequired: true, note: 'No models or cache were deleted. Existing inference expires through its idle keep-alive.'}, null, 2));
    return;
  }
  if (!flags['model-file']) throw new Error('Supply --model-file with the official Qwen3-Embedding-0.6B-Q8_0.gguf. Setup does not download models.');
  const file = path.resolve(flags['model-file']);
  if (/["\r\n]/.test(file)) throw new Error('Model path cannot contain quotes or line breaks.');
  const settings = {enabled: true, endpoint: flags.endpoint || 'http://127.0.0.1:11434', model: MODEL, modelDigest: '0'.repeat(64), keepAlive: '2m'};
  settings.endpoint = embeddingSettings({embeddings: settings}).endpoint;
  const checksum = createHash('sha256');
  for await (const chunk of createReadStream(file)) checksum.update(chunk);
  if (checksum.digest('hex') !== WEIGHTS_SHA256) throw new Error('Model checksum does not match the official Qwen Q8_0 artifact. Nothing was imported or configured.');
  await local(settings.endpoint, '/api/version');
  let tags = await local(settings.endpoint, '/api/tags');
  const existing = tags.models?.find(item => item.name === MODEL || item.model === MODEL);
  if (existing) {
    const show = await local(settings.endpoint, '/api/show', {model: MODEL});
    if (show.remote_host || !new RegExp('^FROM[ \\t]+[^\\r\\n]*sha256[-:]' + WEIGHTS_SHA256 + '[" \\t]*$', 'mi').test(show.modelfile || '')) throw new Error('The Axiom model name already exists with different or unverified weights. Existing models were not overwritten.');
  } else {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-model-setup-'));
    try {
      const modelFile = path.join(temporary, 'Modelfile');
      await fs.writeFile(modelFile, `FROM "${file.replaceAll('\\', '/')}"\r\nPARAMETER num_ctx 2048\r\nPARAMETER num_batch 256\r\n`);
      await importModel(settings.endpoint, modelFile);
    } finally { await fs.rm(temporary, {recursive: true, force: true}); }
    tags = await local(settings.endpoint, '/api/tags');
  }
  const installed = tags.models?.find(item => item.name === MODEL || item.model === MODEL);
  if (!installed || !/^[a-f0-9]{64}$/i.test(installed.digest || '')) throw new Error('The imported local model has no verifiable manifest digest. Configuration was not changed.');
  settings.modelDigest = installed.digest.toLowerCase();
  await configureEmbeddings(config, settings, hash(before));
  console.log(JSON.stringify({...settings, restartRequired: true, note: 'Weights imported without inference. Run axiom-memory index-embeddings to populate the private cache, then restart Axiom and cached harness sessions.'}, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
