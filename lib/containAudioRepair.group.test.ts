import { expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
it.skipIf(process.platform!=="linux")("leader close does not leave a TERM-resistant descendant alive; subreaper drains owned orphan",async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),"audio-aux-group-"));
 try {
  const source=await readFile(path.join(process.cwd(),"lib/containAudioRepair.ts"),"utf8");
  await writeFile(path.join(dir,"repair.cjs"),ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText);
  await writeFile(path.join(dir,"ffmpeg.js"),"module.exports={}");
  const descendant=`process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(path.join(dir,"descendant.pid"))},String(process.pid));setInterval(()=>{},1000)`;
  const leader=`require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  await writeFile(path.join(dir,"test.cjs"),`const {runBoundedAudioAux}=require('./repair.cjs');runBoundedAudioAux(process.execPath,['-e',${JSON.stringify(leader)}],{timeoutMs:500,termMs:100}).then(()=>process.exit(2),e=>{console.log(e.message)});`);
  // This dedicated ancestor adopts/reaps the orphan, rather than relying on
  // the test host's PID1. It observes the node runner's group cleanup first.
  const supervisor=`import ctypes,os,subprocess,time,json,signal\nctypes.CDLL(None).prctl(36,1,0,0,0)\np=subprocess.run([${JSON.stringify(process.execPath)},${JSON.stringify(path.join(dir,"test.cjs"))}],capture_output=True,text=True,timeout=5)\nend=time.monotonic()+2;reaped=[]\nwhile True:\n try:\n  pid,status=os.waitpid(-1,os.WNOHANG)\n  if pid: reaped.append(pid);continue\n except ChildProcessError: break\n if time.monotonic()>end: raise RuntimeError('owned descendant remained live')\n time.sleep(.01)\nprint(json.dumps({'exit':p.returncode,'stdout':p.stdout,'reaped':reaped}))\n`;
  const result=JSON.parse(execFileSync("python3",["-c",supervisor],{timeout:10000,encoding:"utf8"}));
  expect(result.exit).toBe(0);expect(result.stdout).toMatch(/timeout|live descendant/);
  const pid=Number(await readFile(path.join(dir,"descendant.pid"),"utf8"));expect(result.reaped).toContain(pid);expect(()=>process.kill(pid,0)).toThrow();
 } finally {await rm(dir,{recursive:true,force:true});}
},12000);
