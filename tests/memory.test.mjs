import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {get as httpGet} from 'node:http';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {loadConfig, catalog, readNote, writeNote, search, policies, backup, restore, isProtectedPath, locked, hash} from '../src/memory.mjs';
import {createServer} from '../src/server.mjs';
import {serializeWorkspaceIcons} from '../src/workspace-icons.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'shared-brain-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const config = {vault:path.join(root,'vault'),backupDir:path.join(root,'backups'),projects:[{id:'alpha',root:path.join(root,'alpha')},{id:'beta',root:path.join(root,'beta')}]};
  config.indexPath=path.join(root,'search-cache.json');
  await fs.mkdir(path.join(config.vault,'Owner'),{recursive:true});
  await fs.writeFile(path.join(config.vault,'Owner','Policies.md'),'# Policies\r\nNever deploy automatically.\r\n');
  await fs.writeFile(path.join(config.vault,'Owner','Preferences.md'),'# Preferences\r\nCite evidence.\r\n');
  await fs.mkdir(path.join(config.vault,'Agents'),{recursive:true});
  await fs.writeFile(path.join(config.vault,'Agents','Workspace icons.md'),serializeWorkspaceIcons({global:'library',alpha:'boxes',beta:'anvil',__unmapped:'folder-search'}));
  return {root,config};
}

test('configuration defaults to private Axiom directory and respects overrides', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-config-'));
  const previous = { local: process.env.LOCALAPPDATA, config: process.env.SHARED_BRAIN_CONFIG };
  t.after(async () => {
    if (previous.local === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous.local;
    if (previous.config === undefined) delete process.env.SHARED_BRAIN_CONFIG; else process.env.SHARED_BRAIN_CONFIG = previous.config;
    await fs.rm(root, {recursive: true, force: true});
  });
  process.env.LOCALAPPDATA = root;
  delete process.env.SHARED_BRAIN_CONFIG;
  const file = path.join(root, 'Axiom', 'config.json');
  const override = path.join(root, 'override.json');
  const content = JSON.stringify({vault: path.join(root, 'vault'), backupDir: path.join(root, 'backup')});
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, content);
  await fs.writeFile(override, content);
  assert.equal((await loadConfig()).configPath, file);
  process.env.SHARED_BRAIN_CONFIG = override;
  assert.equal((await loadConfig()).configPath, override);
  assert.equal((await loadConfig(file)).configPath, file);
  await fs.rm(file);
  delete process.env.SHARED_BRAIN_CONFIG;
  await assert.rejects(loadConfig(), {code: 'ENOENT'});
});

test('owner writes, path traversal, and junction escapes cannot mutate protected content',async t=>{
  const {root,config}=await fixture(t);
  for(const file of ['Owner/Policies.md','Home.md','Agents/../Owner/Policies.md','Agents\\escape.md','Agents/C:escape.md','Agents/NUL.md']) {
    await assert.rejects(writeNote(config,file,'replaced','new'));
  }
  await fs.mkdir(path.join(config.vault,'Agents'),{recursive:true});
  await fs.symlink(path.join(config.vault,'Owner'),path.join(config.vault,'Agents','linked'),'junction');
  await assert.rejects(writeNote(config,'Agents/linked/Policies.md','replaced','new'),/Links and junctions/);
  await assert.rejects(readNote(config,'Agents/linked/Policies.md'),/Links and junctions/);
  const note=await readNote(config,'Owner/Policies.md');
  assert.match(note.content,/Never deploy automatically/);
  assert.equal(isProtectedPath(config,path.join(config.vault,'Owner','Policies.md'),root),true);
  assert.equal(isProtectedPath(config,path.join(config.vault,'Agents','Workspace icons.md'),root),true);
  if (process.platform === 'win32') {
    assert.equal(isProtectedPath(config,path.join(config.vault,'agents','new.md'),root),false);
  }
  assert.equal(isProtectedPath(config,path.join(config.vault,'Agents','new.md'),root),false);
});

test('stale revisions and concurrent updates cannot silently overwrite an accepted write',async t=>{
  const {config}=await fixture(t);
  const first=await writeNote(config,'Agents/Memory/value.md','# Value\nFirst','new');
  const updates=await Promise.allSettled([
    writeNote(config,first.path,'# Value\nSecond',first.revision),
    writeNote(config,first.path,'# Value\nThird',first.revision)
  ]);
  assert.equal(updates.filter(result=>result.status==='fulfilled').length,1);
  const current=await readNote(config,first.path);
  assert.match(current.content,/(Second|Third)$/);
  await assert.rejects(writeNote(config,first.path,'lost update',first.revision),/Revision conflict/);
  const retained=await fs.readdir(path.join(config.backupDir,'history'));
  assert.equal(retained.length,1);
});

test('search isolates project knowledge and excludes superseded decisions, proposals and handovers',async t=>{
  const {root,config}=await fixture(t);
  await writeNote(config,'Agents/Memory/Projects/alpha/current.md','---\r\nstatus: current\r\n---\r\n# Quartz deployment\r\nUse port 4318.','new');
  await writeNote(config,'Agents/Memory/Projects/alpha/old.md','---\r\nstatus: superseded\r\n---\r\n# Quartz deployment\r\nUse port 3000.','new');
  await writeNote(config,'Agents/Memory/Projects/beta/private.md','# Quartz beta\r\nBeta-only knowledge.','new');
  await writeNote(config,'Agents/Proposals/change.md','# Quartz proposal\r\nChange the policy.','new');
  await writeNote(config,'Agents/Handovers/session.md','# Quartz log\r\nSession details.','new');
  const result=await search(config,'Quartz deployment',{cwd:path.join(root,'alpha')});
  assert.deepEqual(result.items.map(item=>item.path),['Agents/Memory/Projects/alpha/current.md']);
  const other=await search(config,'Quartz',{cwd:path.join(root,'beta')});
  assert.deepEqual(other.items.map(item=>item.path),['Agents/Memory/Projects/beta/private.md']);
  const injected=await policies(config,path.join(root,'alpha'),'Quartz');
  assert.match(injected,/Never deploy automatically/);
  assert.match(injected,/Use port 4318/);
  assert.doesNotMatch(injected,/Use port 3000|Beta-only|Change the policy|Session details/);
});

test('policy loading reports missing required content instead of proceeding without owner rules',async t=>{
  const {config}=await fixture(t);
  await fs.unlink(path.join(config.vault,'Owner','Policies.md'));
  await assert.rejects(policies(config),/ENOENT/);
});

test('verified snapshots restore exact bytes and reject tampering or existing targets',async t=>{
  const {root,config}=await fixture(t);
  await writeNote(config,'Agents/Memory/findings.md','# Findings\r\nEvidence: exact bytes.','new');
  await fs.mkdir(path.join(config.vault,'.obsidian'));
  await fs.writeFile(path.join(config.vault,'.obsidian','app.json'),'{"readableLineLength":true}\r\n');
  const original=await fs.readFile(path.join(config.vault,'Agents','Memory','findings.md'));
  const saved=await backup(config);
  const target=path.join(root,'restored');
  const result=await restore(config,saved.snapshot,target);
  assert.equal(result.files,5);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(target,'.obsidian','app.json'),'utf8')),{readableLineLength:true});
  assert.deepEqual(await fs.readFile(path.join(target,'Agents','Memory','findings.md')),original);
  await assert.rejects(restore(config,saved.snapshot,target),/already exists/);
  await fs.writeFile(path.join(saved.snapshot,'vault','Agents','Memory','findings.md'),'tampered');
  await assert.rejects(restore(config,saved.snapshot,path.join(root,'second-restore')),/checksum mismatch/);
});

test('catalog reads current files and removes deleted entries without stale index results',async t=>{
  const {config}=await fixture(t);
  await writeNote(config,'Agents/Memory/transient.md','# Transient\r\nUnique retrievalneedle.','new');
  assert.equal((await search(config,'retrievalneedle')).items[0].title,'Transient');
  await fs.writeFile(path.join(config.vault,'Agents','Memory','transient.md'),'# Transient\r\nThe current fact is replacementneedle.');
  assert.equal((await search(config,'retrievalneedle')).count,0);
  assert.match((await search(config,'replacementneedle')).items[0].excerpt,/current fact is replacementneedle/);
  await fs.writeFile(config.indexPath,'{ corrupt derivative');
  assert.match((await search(config,'replacementneedle')).items[0].excerpt,/current fact is replacementneedle/);
  await fs.unlink(config.indexPath);
  assert.equal((await search(config,'replacementneedle')).items[0].revision,(await readNote(config,'Agents/Memory/transient.md')).revision);
  await fs.unlink(path.join(config.vault,'Agents','Memory','transient.md'));
  assert.equal((await search(config,'replacementneedle')).count,0);
  assert.equal((await catalog(config)).some(note=>note.title==='Transient'),false);
});

test('warm indexes revalidate replacements, isolate vaults and reflect completed edits under concurrency',async t=>{
  const {config:first}=await fixture(t), {config:second}=await fixture(t);
  const relative='Owner/Policies.md', file=path.join(first.vault,'Owner','Policies.md');
  const initial=await catalog(first);
  initial.find(note=>note.path===relative).title='caller mutation';
  assert.equal((await catalog(first)).find(note=>note.path===relative).title,'Policies');
  const saved=JSON.parse(await fs.readFile(first.indexPath,'utf8'));
  saved.entries[relative].content='# Forged\r\nforgedneedle';
  const replacement=first.indexPath+'.replacement';
  await fs.writeFile(replacement,JSON.stringify(saved));
  await fs.rename(replacement,first.indexPath);
  assert.equal((await search(first,'forgedneedle')).count,0);
  await fs.writeFile(path.join(second.vault,'Owner','Policies.md'),'# Other\r\nsecondvaultneedle');
  assert.equal((await search(second,'secondvaultneedle')).count,1);
  assert.equal((await search(first,'secondvaultneedle')).count,0);
  await fs.writeFile(file,'# Updated\r\nconcurrentfreshneedle');
  const results=await Promise.all([catalog(first),search(first,'concurrentfreshneedle'),search(first,'concurrentfreshneedle')]);
  assert.equal(results[0].find(note=>note.path===relative).title,'Updated');
  assert.equal(results[1].count,1);
  assert.equal(results[2].count,1);
  await fs.unlink(file);
  assert.equal((await catalog(first)).some(note=>note.path===relative),false);
});

test('Windows recovers a killed lock owner while protecting live and malformed locks', {skip: process.platform !== 'win32'}, async t=>{
  const {config}=await fixture(t);
  const lockPath=path.join(os.tmpdir(),`shared-brain-${hash(config.vault).slice(0,20)}.lock`);
  t.after(()=>fs.rm(lockPath,{force:true}));
  const moduleUrl=new URL('../src/memory.mjs',import.meta.url).href;
  const script=`import {locked} from ${JSON.stringify(moduleUrl)}; const config=JSON.parse(process.env.TEST_LOCK_CONFIG); await locked(config,async()=>{ console.log('ready'); await new Promise(()=>setInterval(()=>{},1000)); });`;
  async function owner() {
    const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,TEST_LOCK_CONFIG:JSON.stringify(config)},stdio:['ignore','pipe','pipe']});
    t.after(()=>{ if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    await new Promise((resolve,reject)=>{
      child.stdout.once('data',resolve);
      child.once('error',reject);
      child.once('exit',()=>reject(new Error('Lock owner exited before becoming ready')));
    });
    return child;
  }
  const child=await owner();
  await assert.rejects(locked(config,async()=>{}),/Another memory operation/);
  const exited=once(child,'exit'); child.kill('SIGKILL'); await exited;
  let release, entered;
  const gate=new Promise(resolve=>{release=resolve;});
  const acquired=new Promise(resolve=>{entered=resolve;});
  const attempt=()=>locked(config,async()=>{entered(); await gate; return 'recovered';});
  const attempts=[attempt(),attempt()].map(promise=>promise.then(value=>({value}),error=>({error})));
  await acquired;
  const rejected=await Promise.race(attempts);
  assert.match(rejected.error?.message || '',/Another memory operation/);
  release();
  const outcomes=await Promise.all(attempts);
  assert.equal(outcomes.filter(result=>result.value === 'recovered').length,1);
  await fs.writeFile(lockPath,'not valid metadata');
  await assert.rejects(locked(config,async()=>{}),/Another memory operation/);
  assert.equal(await fs.readFile(lockPath,'utf8'),'not valid metadata');
});

test('rendered wikilinks remain navigable and note HTML cannot execute active content',async t=>{
  const {config}=await fixture(t);
  await fs.writeFile(path.join(config.vault,'Home.md'),'# Home\r\n[[Owner/Policies|Approved policy]]\r\n<script>alert(1)</script>\r\n![remote](https://example.com/tracker.png)');
  const server=createServer(config);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  config.port=server.address().port;
  t.after(()=>{server.closeAllConnections(); return new Promise(resolve=>server.close(resolve));});
  const base=`http://127.0.0.1:${config.port}`;
  const rendered=await (await fetch(base+'/api/note?path=Home.md')).json();
  assert.match(rendered.html,/href="\/\?note=Owner%2FPolicies.md"/);
  assert.doesNotMatch(rendered.html,/<script|<img|src="https:/);
  assert.match(rendered.html,/Approved policy/);
  const foreignHostStatus=await new Promise((resolve,reject)=>{
    httpGet(base+'/api/catalog',{headers:{Host:'attacker.invalid'}},response=>{response.resume();resolve(response.statusCode);}).on('error',reject);
  });
  assert.equal(foreignHostStatus,403);
  assert.equal((await fetch(base+'/api/catalog',{headers:{Origin:'https://attacker.invalid'}})).status,403);
  assert.equal((await fetch(base+'/api/note?path=..%2Fsecret.md')).status,400);
  assert.equal((await fetch(base+'/api/note',{method:'POST',body:'overwrite'})).status,405);
});

test('human editor writes require same-origin CSRF, preserve revisions, and do not broaden agent ownership',async t=>{
  const {config}=await fixture(t);
  const server=createServer(config);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  config.port=server.address().port;
  t.after(()=>{server.closeAllConnections(); return new Promise(resolve=>server.close(resolve));});
  const base=`http://127.0.0.1:${config.port}`;
  const original=await readNote(config,'Owner/Policies.md');
  const body={path:original.path,content:'# Policies\nHuman-approved revision.\n',expectedRevision:original.revision};
  const session=await (await fetch(base+'/api/editor-session')).json();
  const headers={'Content-Type':'application/json',Origin:base,'X-Shared-Brain-CSRF':session.token};
  const request=(value,override={})=>fetch(base+'/api/note',{method:'PUT',headers:{...headers,...override},body:JSON.stringify(value)});
  assert.equal((await request(body,{'X-Shared-Brain-CSRF':''})).status,403);
  assert.equal((await request(body,{Origin:'https://attacker.invalid'})).status,403);
  assert.equal((await request(body,{Origin:''})).status,403);
  assert.equal((await request(body,{'Sec-Fetch-Site':'cross-site'})).status,403);
  assert.equal((await fetch(base+'/api/editor-session',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await readNote(config,original.path)).revision,original.revision);
  const preview=await fetch(base+'/api/preview',{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal(preview.status,200);
  assert.match((await preview.json()).html,/Human-approved revision/);
  assert.equal((await readNote(config,original.path)).revision,original.revision);
  const saved=await request(body);
  assert.equal(saved.status,200);
  const {note}=await saved.json();
  assert.equal(note.owner,'owner');
  assert.equal(note.content,'# Policies\r\nHuman-approved revision.\r\n');
  assert.equal((await request({...body,content:'stale overwrite'})).status,409);
  assert.equal((await readNote(config,original.path)).revision,note.revision);
  await assert.rejects(writeNote(config,note.path,'agent overwrite',note.revision),/restricted/);
  const created=await request({path:'Owner/Notes/New human note.md',content:'# Personal\nFrom the browser.',expectedRevision:'new'});
  assert.equal(created.status,200);
  const createdNote=(await created.json()).note;
  assert.equal(createdNote.owner,'owner');
  assert.equal((await request({path:createdNote.path,content:'duplicate',expectedRevision:'new'})).status,409);
  assert.equal((await request({path:'../escape.md',content:'escape',expectedRevision:'new'})).status,400);
  assert.equal((await request({path:'.obsidian/config.md',content:'hidden',expectedRevision:'new'})).status,400);
  const history=path.join(config.backupDir,'history');
  const files=await fs.readdir(history,{recursive:true});
  const retained=await Promise.all(files.filter(file=>file.endsWith('.md')).map(file=>fs.readFile(path.join(history,file),'utf8')));
  assert.ok(retained.includes(original.content));
});

test('linked CLI executes from an unrelated working directory', async t => {
  const {root, config} = await fixture(t);
  const original = await writeNote(config, 'Agents/Memory/Projects/alpha/linked.md', '# Linked CLI\r\nCanonical linked-entry evidence.\r\n', 'new');
  const configPath = path.join(root, 'config.json'), linked = path.join(root, 'linked-app');
  await fs.writeFile(configPath, JSON.stringify(config));
  await fs.symlink(path.dirname(path.dirname(fileURLToPath(import.meta.url))), linked, process.platform === 'win32' ? 'junction' : 'dir');
  const result = spawnSync(process.execPath, [path.join(linked, 'src', 'memory.mjs'), 'read', '--path', original.path], {cwd: root, env: {...process.env, SHARED_BRAIN_CONFIG: configPath}, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  const delivered = JSON.parse(result.stdout);
  assert.equal(delivered.path, original.path);
  assert.equal(delivered.revision, original.revision);
  assert.equal(delivered.content, original.content);
});
