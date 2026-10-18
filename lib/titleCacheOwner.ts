import path from "node:path";
import { mkdir, readdir, readFile, writeFile, link, unlink, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
type Owner = { pid: number; start: string; boot: string; directory: string };
async function processStart(pid: number): Promise<string | null> {
  try { const text = await readFile(`/proc/${pid}/stat`, "utf8"); return text.slice(text.lastIndexOf(")") + 2).split(" ")[19]; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
/** Complete immutable lease publication via link(exclusive); no stale-lock unlink race. */
export async function claimTitleCacheOwner(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const boot=(await readFile("/proc/sys/kernel/random/boot_id","utf8")).trim();
  const names=await readdir(root);
  for(const name of names){const match=/^candidate-(\d+)-(\d+)-[0-9a-f-]{36}\.json$/.exec(name);if(match&&await processStart(Number(match[1]))!==match[2])await unlink(path.join(root,name)).catch(e=>{if(e.code!=="ENOENT")throw e;});}
  if((await readdir(root)).filter(n=>n.startsWith("candidate-")).length>=8)throw new Error("タイトルrenderer開始待機が上限です。");
  const files = (await readdir(root)).filter(n=>/^lease-\d+\.json$/.test(n)).sort((a,b)=>Number(a.slice(6,-5))-Number(b.slice(6,-5)));
  let generation = 0;
  const stale: { file: string; owner: Owner }[] = [];
  for (const file of files) {
    const owner = JSON.parse(await readFile(path.join(root,file),"utf8")) as Owner;
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.start !== "string" || typeof owner.boot!=="string" || !/^owner-[0-9a-f-]{36}$/.test(owner.directory)) throw new Error("タイトルcache leaseが不正です。既存cacheを確認してください。");
    if (owner.boot===boot && await processStart(owner.pid) === owner.start) throw new Error("同じ保存先で別タイトルrendererが稼働中です。終了後に再試行してください。");
    stale.push({file,owner}); generation = Math.max(generation, Number(file.slice(6,-5))+1);
  }
  if (!Number.isSafeInteger(generation)) throw new Error("タイトルcache世代が上限です。");
  const start = await processStart(process.pid); if (!start) throw new Error("タイトルrenderer process identityを取得できません。");
  const knownDirs=new Set(stale.map(s=>s.owner.directory));
  if(names.some(n=>!/^lease-\d+\.json$/.test(n)&&!n.startsWith("candidate-")&&!knownDirs.has(n)))throw new Error("タイトルcacheに所有者不明のデータがあります。自動削除せず開始を停止しました。");
  const directory=`owner-${randomUUID()}`, owner:Owner={pid:process.pid,start,boot,directory};
  const candidate=path.join(root,`candidate-${process.pid}-${start}-${randomUUID()}.json`), lease=path.join(root,`lease-${generation}.json`);
  await writeFile(candidate,JSON.stringify(owner),{flag:"wx",mode:0o400});
  try { await link(candidate,lease); } catch(e) { if((e as NodeJS.ErrnoException).code==="EEXIST")throw new Error("タイトルrendererの開始が競合しました。再試行してください。");throw e; }
  finally { await unlink(candidate); }
  const own=path.join(root,directory);
  try {
    await mkdir(own,{mode:0o700});
    // These immutable old generations referred to processes proven dead before
    // our exclusive next-generation publication. Their UUID dirs are never reused.
    for (const {file,owner:old} of stale) { await rm(path.join(root,old.directory),{recursive:true,force:true});await unlink(path.join(root,file)); }
    return own;
  } catch(e) { await rm(own,{recursive:true,force:true});await unlink(lease);throw e; }
}
