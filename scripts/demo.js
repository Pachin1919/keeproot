import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {normalizeStateDir} from '../src/paths.js';
import {RUNTIME_HANDSHAKE_TIMEOUTS} from '../src/runtime-location.js';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const usage=`Keeproot fictional demonstration (Atlas Runtime; source or explicit installation)
  npm run demo -- --python <trusted-python-3.11+> [--serve]
  npm run demo -- --python <trusted-python-3.11+> --resume <demo-id> --serve
  node scripts/demo.js --install-root <explicit-installation> [--python <trusted-python>] [--resume <demo-id>] --serve
  npm run demo -- --help
Creates a new sample in test/.tmp and development state in .atlas/demo.
--resume reopens the same saved sample without recreating its Work or Result.
Preserves previous demonstrations. --serve uses an available loopback port;
it does not open a browser. Ctrl+C closes the server and retains results.
This is not real-Vault acceptance or a different-product Host test.`;

function options(args){
  const result={serve:false,python:null,resume:null,installRoot:null};
  for(let i=0;i<args.length;i++){
    if(args[i]==='--help')result.help=true;
    else if(args[i]==='--serve')result.serve=true;
    else if(args[i]==='--python' && args[i+1] && !args[i+1].startsWith('--'))result.python=path.resolve(args[++i]);
    else if(args[i]==='--resume' && args[i+1] && !args[i+1].startsWith('--'))result.resume=args[++i];
    else if(args[i]==='--install-root' && args[i+1] && !args[i+1].startsWith('--'))result.installRoot=path.resolve(args[++i]);
    else throw Error(`Unknown or incomplete demo argument: ${args[i]}`);
  }
  return result;
}

function demoScope(installRoot){
  if(!installRoot)return {boundary:repo,stateParent:path.join(repo,'.atlas/demo'),sampleParent:path.join(repo,'test/.tmp'),runtimeRoot:repo,nodePath:process.execPath,nodeArgs:[],installRoot:null};
  const root=normalizeStateDir(path.resolve(installRoot),path.resolve(installRoot));
  // Allow all three bounded commands plus installation hashing and process startup.
  const locateBudget=Object.values(RUNTIME_HANDSHAKE_TIMEOUTS).reduce((total,budget)=>total+budget,0)+30000;
  const located=spawnSync(process.execPath,[path.join(repo,'scripts/runtime-manager.js'),'locate','--install-root',root],{cwd:repo,encoding:'utf8',windowsHide:true,timeout:locateBudget,maxBuffer:2*1024*1024});
  let receipt;try{receipt=JSON.parse(located.stdout??'');}catch{}
  if(located.error || located.status!==0 || receipt?.status!=='ready' || path.resolve(receipt.install_root??'')!==root)throw Error(`Explicit demo installation is unavailable: ${receipt?.message??receipt?.status??located.error?.message??'invalid receipt'}${receipt?.next_step?` Next: ${receipt.next_step}`:''}`);
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'atlas-install.json'),'utf8'));
  if(path.resolve(manifest.runtime_path??'')!==path.join(root,'runtime') || path.resolve(manifest.state_path??'')!==path.join(root,'state'))throw Error('Demo installation paths do not match the selected root.');
  return {boundary:root,stateParent:path.join(root,'state/demos'),sampleParent:path.join(root,'demo-samples'),runtimeRoot:manifest.runtime_path,nodePath:manifest.node_path,nodeArgs:manifest.node_args??[],installRoot:root,runtimeSha256:manifest.runtime_sha256};
}

function demoPython(scope,python){
  return python??(scope.installRoot?path.join(scope.installRoot,'desktop-ui/venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'):null);
}

function demoEnvironment(scope,stateDir,python){
  const env={...process.env,ATLAS_STATE_DIR:stateDir,ATLAS_CONTENT_PYTHON:python,ATLAS_PYTHON:python};
  delete env.ATLAS_HOME;delete env.ATLAS_DESKTOP_PYTHON;delete env.ATLAS_TEST_PYTHON;
  if(scope.installRoot)env.ATLAS_HOME=scope.installRoot;
  return env;
}

export function loadProductDemo(id,{installRoot=null}={}){
  if(typeof id!=='string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id))throw Error('Resume requires the UUID demo-id printed by this script.');
  const scope=demoScope(installRoot);
  const state=normalizeStateDir(scope.boundary,path.join(scope.stateParent,id));
  const workspace=normalizeStateDir(scope.boundary,path.join(scope.sampleParent,`product-demo-${id}`,'workspace'));
  const file=path.join(state,'demo.json'),stat=fs.lstatSync(file);
  if(!stat.isFile() || stat.isSymbolicLink() || stat.size>16384)throw Error('Demo manifest must be a bounded regular file.');
  const demo=JSON.parse(fs.readFileSync(file,'utf8'));
  const projectId=/^PRJ-[a-f0-9-]{36}$/i,boardId=/^BRD-[a-f0-9-]{36}$/i;
  if((demo.installation_root??null)!==scope.installRoot)throw Error('Demo manifest does not match the selected installation.');
  if(demo.schema!=='atlas.product-demo.v1' || demo.phase!=='ready' || path.resolve(demo.state_dir??'')!==state || path.resolve(demo.workspace??'')!==workspace || path.resolve(demo.project_path??'')!==path.join(workspace,'示例项目') || !projectId.test(demo.project_id) || !boardId.test(demo.board_id) || demo.board_href!==`/projects/${demo.project_id}/boards/${demo.board_id}`)throw Error('Demo manifest does not match its repository sample and identity. Partial preparation remains available for manual diagnosis.');
  return {...demo,demo_id:id};
}

export function prepareProductDemo({python,installRoot=null}){
  // Validate both parents before creating anything, including test/.tmp.
  const id=crypto.randomUUID();
  const scope=demoScope(installRoot);python=demoPython(scope,python);
  const stateDir=normalizeStateDir(scope.boundary,path.join(scope.stateParent,id));
  const sampleDir=normalizeStateDir(scope.boundary,path.join(scope.sampleParent,`product-demo-${id}`));
  if(!python || !fs.lstatSync(python).isFile())throw Error('Provide --python with a trusted Python 3.11+ executable.');
  const probe=spawnSync(python,['--version'],{encoding:'utf8',windowsHide:true,timeout:15000});
  const version=/Python (\d+)\.(\d+)/.exec(`${probe.stdout??''}\n${probe.stderr??''}`);
  if(probe.status!==0 || !version || Number(version[1])<3 || Number(version[1])===3 && Number(version[2])<11)throw Error('Demo requires Python 3.11+; no sample was created.');
  fs.mkdirSync(path.dirname(stateDir),{recursive:true});fs.mkdirSync(stateDir);
  fs.mkdirSync(path.dirname(sampleDir),{recursive:true});fs.mkdirSync(sampleDir);
  const workspace=path.join(sampleDir,'workspace'),projectPath=path.join(workspace,'示例项目');
  const data=path.join(projectPath,'01_资料'),results=path.join(projectPath,'02_成果');
  fs.mkdirSync(data,{recursive:true});fs.mkdirSync(results);
  for(const name of ['本期.csv','补充.csv','演示说明.md'])fs.copyFileSync(path.join(repo,'fixtures/product-demo',name),path.join(data,name),fs.constants.COPYFILE_EXCL);
  const inbox=path.join(sampleDir,'待入材料');fs.mkdirSync(inbox);
  const importSource=path.join(inbox,'新线索.txt');
  fs.copyFileSync(path.join(repo,'fixtures/product-demo/新线索.txt'),importSource,fs.constants.COPYFILE_EXCL);
  const manifest={schema:'atlas.product-demo.v1',demo_id:id,sample_kind:'fictional_preconfigured',state_dir:stateDir,workspace,project_path:projectPath,import_source:importSource,phase:'sample_created'};
  if(scope.installRoot)Object.assign(manifest,{installation_root:scope.installRoot,runtime_sha256:scope.runtimeSha256});
  const manifestFile=path.join(stateDir,'demo.json');
  const record=phase=>{manifest.phase=phase;fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2));};
  record('sample_created');
  const env=demoEnvironment(scope,stateDir,python);
  const host=['--actor','agent','--agent','Demo fixture','--model','deterministic-sample','--tool','atlas-product-demo','--client-run-id',id];
  const cli=(args,caller=false)=>{
    const result=spawnSync(scope.nodePath,[...scope.nodeArgs,path.join(scope.runtimeRoot,'bin/atlas.js'),...args,...(caller?host:[]),'--json'],{cwd:scope.runtimeRoot,env,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:2*1024*1024});
    let receipt;try{receipt=JSON.parse(result.stdout??'');}catch{}
    if(result.error || result.status!==0 || !receipt?.ok){manifest.failed_command=args.slice(0,2).join(' ');record('interrupted');throw Error(`${manifest.failed_command}: ${receipt?.error?.message??result.error?.message??result.stderr?.slice(0,1000)??'invalid receipt'}. State retained at ${manifestFile}`);}
    return receipt.data;
  };
  const root=cli(['root','adopt','--path',workspace,'--type','project_workspace','--content-policy','bounded_content']);
  const project=cli(['project','create','--name','示例：合并两份地区数据','--path','示例项目']);
  manifest.project_id=project.project_id;
  cli(['project','attach-root',project.project_id,'--root',root.root_id,'--path','示例项目','--reason','Explicit fictional demonstration workspace.']);record('project_registered');
  const started=cli(['table-work','start','--project',project.project_id,'--source',path.join(data,'本期.csv'),'--source',path.join(data,'补充.csv'),'--intent','虚构示例：按id合并去重，不代表Host推断或真人认可。'],true);
  manifest.work_id=started.session_id;record('work_started');
  const prepared=cli(['table-work','prepare',started.session_id,'--base-revision',String(started.revision)],true);
  const mappingFile=path.join(stateDir,'mapping.json');
  fs.writeFileSync(mappingFile,JSON.stringify({mapping:prepared.sources.flatMap(source=>['id','region','amount'].map(column=>({source_key:source.source_key,column,canonical:column})))}),{flag:'wx'});
  const aligned=cli(['table-work','align',started.session_id,'--request-file',mappingFile,'--base-revision',String(prepared.revision)],true);
  const recipeFile=path.join(stateDir,'recipe.json');
  fs.writeFileSync(recipeFile,JSON.stringify({combine:'concatenate',deduplicate_columns:'id',sort_column:'id',sort_direction:'asc'}),{flag:'wx'});
  const configured=cli(['table-work','recipe',started.session_id,'--request-file',recipeFile,'--base-revision',String(aligned.revision)],true);
  const preview=cli(['table-work','preview',started.session_id,'--base-revision',String(configured.revision)],true);
  if(preview.preview.result_summary.rows!==3)throw Error(`Unexpected demo Preview; state retained at ${manifestFile}`);
  const saved=cli(['table-work','save',started.session_id,'--base-revision',String(preview.revision),'--folder','02_成果','--file-name','地区数据_合并.csv','--format','csv','--request-key',`demo-save-${id}`,'--reason','Run the explicitly preconfigured fictional demo; preserve all source files.'],true);
  if(saved.status!=='executed' || !saved.verification?.sha256)throw Error(`Demo Save was not verified; state retained at ${manifestFile}`);
  manifest.save_id=saved.save_id;manifest.result_resource_id=saved.resource_id;manifest.result_path=path.join(results,'地区数据_合并.csv');record('result_saved');
  const board=cli(['board','create','--project',project.project_id,'--title','示例交付：资料 → 处理 → 成果']);
  manifest.board_id=board.board_id;
  const boardFile=path.join(stateDir,'board.json');
  fs.writeFileSync(boardFile,JSON.stringify({title:board.title,blocks:[
    {type:'material_reference',resource_id:started.sources[0].resource_id,version_policy:'follow_latest'},
    {type:'text',text:'这是虚构演示：两份CSV共4条输入，按id去重后3条记录，金额合计200。方案已预置，不代表真人语义签收。'},
    {type:'result_preview',save_id:saved.save_id,version_policy:'pinned_version'},
  ]}),{flag:'wx'});
  const completed=cli(['board','save',board.board_id,'--project',project.project_id,'--base-revision',String(board.revision),'--request-file',boardFile]);
  manifest.board_revision=completed.revision;
  manifest.board_href=`/projects/${project.project_id}/boards/${board.board_id}`;
  manifest.manifest_path=manifestFile;record('ready');
  return manifest;
}

async function serveInstalledDemo(demo,{python,installRoot}){
  const stored=loadProductDemo(demo.demo_id,{installRoot});
  for(const field of ['installation_root','state_dir','workspace','project_path','project_id','board_id','board_href']){
    if(demo[field]!==stored[field])throw Error(`Demo UI identity does not match its manifest: ${field}`);
  }
  const scope=demoScope(installRoot);python=demoPython(scope,python);
  const expectedState=normalizeStateDir(scope.boundary,path.join(scope.stateParent,demo.demo_id));
  if(path.resolve(demo.state_dir)!==expectedState || demo.installation_root!==scope.installRoot)throw Error('Demo UI state does not match its selected installation.');
  const child=spawn(scope.nodePath,[...scope.nodeArgs,path.join(scope.runtimeRoot,'bin/atlas.js'),'ui','--no-open','--port','0','--json'],{cwd:scope.runtimeRoot,env:demoEnvironment(scope,expectedState,python),stdio:['ignore','pipe','pipe'],windowsHide:true});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  const close=async()=>{
    if(child.exitCode!==null || child.signalCode!==null)return;
    child.kill('SIGINT');
    let timer;
    await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>{child.kill();resolve();},5000);})]);
    clearTimeout(timer);
  };
  let output='',errors='';
  child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-2048);});
  try{
    const receipt=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Installed demo UI did not start within 60 seconds.')),60000);
      const fail=error=>{clearTimeout(timer);reject(error);};
      child.once('error',fail);
      child.once('exit',code=>fail(Error(`Installed demo UI exited before startup (${code}): ${errors}`)));
      child.stdout.on('data',chunk=>{
        output+=chunk;if(output.length>65536){fail(Error('Installed demo UI returned excessive startup output.'));return;}
        let value;try{value=JSON.parse(output);}catch{return;}
        if(value?.ok!==true || value.command!=='ui.start' || value.protocol_version!=='atlas-cli.v1'){fail(Error('Installed demo UI returned an invalid startup receipt.'));return;}
        clearTimeout(timer);resolve(value);
      });
    });
    const origin=new URL(receipt.data.url);
    if(origin.protocol!=='http:' || origin.hostname!=='127.0.0.1')throw Error('Installed demo UI must use loopback HTTP.');
    return {url:new URL(demo.board_href,origin).href,close};
  }catch(error){await close();throw error;}
}

export async function serveProductDemo(demo,{python,installRoot=null}){
  if(installRoot)return serveInstalledDemo(demo,{python,installRoot});
  if(demo.installation_root)throw Error('Provide the explicit install-root to serve this installed sample.');
  // These are current UI assembly dependencies, not a separate execution engine.
  const [{Registry},{createResourceControl},{Intake},{PreferenceRules},{startAtlasUiServer}]=await Promise.all([
    import('../src/registry.js'),import('../src/resource-control.js'),import('../src/intake.js'),import('../src/preference-rules.js'),import('../src/ui-server.js'),
  ]);
  const previous=process.env.ATLAS_CONTENT_PYTHON;process.env.ATLAS_CONTENT_PYTHON=python;
  const registry=new Registry({stateDir:demo.state_dir});
  const resourceControl=createResourceControl({stateDir:demo.state_dir,registry});
  const intake=new Intake({stateDir:demo.state_dir});
  const rules=new PreferenceRules({stateDir:demo.state_dir});
  let server;
  try{server=await startAtlasUiServer({stateDir:demo.state_dir,registry,resourceControl,intake,rules,projectRoot:repo,host:'127.0.0.1',port:0});}
  catch(error){rules.dispose();intake.dispose();resourceControl.dispose();registry.dispose();if(previous===undefined)delete process.env.ATLAS_CONTENT_PYTHON;else process.env.ATLAS_CONTENT_PYTHON=previous;throw error;}
  return {url:`${server.workspace_url.replace(/\/$/,'')}${demo.board_href}`,close:async()=>{await server.close();rules.dispose();intake.dispose();resourceControl.dispose();registry.dispose();if(previous===undefined)delete process.env.ATLAS_CONTENT_PYTHON;else process.env.ATLAS_CONTENT_PYTHON=previous;}};
}

async function main(){
  const input=options(process.argv.slice(2));
  if(input.help){console.log(usage);return;}
  if(input.resume && !input.installRoot && (!input.python || !fs.lstatSync(input.python).isFile()))throw Error('Provide --python when reopening the HTML demonstration.');
  const demo=input.resume ? loadProductDemo(input.resume,input) : prepareProductDemo(input);
  console.log(JSON.stringify(demo));
  if(!input.serve)return;
  const session=await serveProductDemo(demo,input);console.log(`Keeproot HTML demo: ${session.url}\nCtrl+C closes the server; files and state remain.`);
  let stopping=false;
  const stop=async()=>{if(stopping)return;stopping=true;await session.close();};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
