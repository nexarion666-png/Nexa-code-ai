'use client';
import { useEffect,useMemo,useState } from 'react';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import { ProviderSettings } from '@/components/provider-settings';
import { IntegrationsPanel } from '@/components/integrations-panel';
import { AgentReview } from '@/components/agent-review';
import { InstallAppButton } from '@/components/install-app-button';

type Project={id:string;name:string;description:string|null;github_repo?:string|null;vercel_url?:string|null};
type File={path:string;content:string;version:number};type Chat={id:string;title:string;updated_at:string};type Message={id:string;role:'user'|'assistant'|'system';content:string;created_at:string};
export function Workspace({initialProjects=[]}:{initialProjects?:Project[]}){
 const supabase=useMemo(()=>createSupabaseBrowserClient(),[]);const [projects,setProjects]=useState(initialProjects),[project,setProject]=useState<Project|null>(initialProjects[0]??null),[files,setFiles]=useState<File[]>([]),[selected,setSelected]=useState(''),[draft,setDraft]=useState(''),[chats,setChats]=useState<Chat[]>([]),[chatId,setChatId]=useState(''),[messages,setMessages]=useState<Message[]>([]),[prompt,setPrompt]=useState(''),[image,setImage]=useState<globalThis.File|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState('Ready'),[newName,setNewName]=useState(''),[runId,setRunId]=useState<string>(),[mobileView,setMobileView]=useState<'chat'|'code'|'files'|'tools'>('chat'),[mobileMenuOpen,setMobileMenuOpen]=useState(false);
 const selectedFile=files.find(f=>f.path===selected);
 async function loadProjects(){
  try{
   const r=await fetch('/api/projects');
   const d=await r.json().catch(()=>({}));
   if(!r.ok){setNotice(d.error||'Could not load projects.');return}
   const loaded=d.projects||[];
   if(loaded.length){setProjects(loaded);if(!project)setProject(loaded[0]);return}
   setNotice('Creating your first project…');
   const cr=await fetch('/api/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'My Nexa Project',description:'Default project created by Nexa Code AI.'})});
   const cd=await cr.json().catch(()=>({}));
   if(!cr.ok){setNotice(cd.error||'Create a project to begin.');return}
   setProjects([cd.project]);setProject(cd.project);
  }catch(e){setNotice(e instanceof Error?e.message:'Could not load projects.')}
 }
 async function loadProject(p:Project){setProject(p);setNotice('Loading project…');const [fr,cr]=await Promise.all([fetch(`/api/projects/${p.id}/files`),fetch(`/api/projects/${p.id}/chats`)]);const fd=await fr.json(),cd=await cr.json();const fs=fd.files||[];setFiles(fs);setSelected(fs[0]?.path||'');setChats(cd.chats||[]);if(cd.chats?.[0])loadChat(cd.chats[0].id);else setMessages([]);setNotice('Ready')}
 async function loadChat(id:string){setChatId(id);const r=await fetch(`/api/chats/${id}/messages`);if(r.ok)setMessages((await r.json()).messages||[])}
 useEffect(()=>{loadProjects()},[]);useEffect(()=>{if(project)loadProject(project)},[project?.id]);useEffect(()=>{if(selectedFile)setDraft(selectedFile.content)},[selectedFile?.path,selectedFile?.version]);
 async function createProject(){const name=newName.trim();if(!name)return;setBusy(true);const r=await fetch('/api/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name})});const d=await r.json();setBusy(false);if(!r.ok)return setNotice(d.error||'Could not create project.');setNewName('');setProjects(p=>[d.project,...p]);setProject(d.project)}
 async function saveFile(){if(!project||!selected)return;setBusy(true);const r=await fetch(`/api/projects/${project.id}/files`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({path:selected,content:draft,version:selectedFile?.version??1})});const d=await r.json();setBusy(false);if(!r.ok)return setNotice(d.error||'Could not save file.');setFiles(fs=>fs.map(f=>f.path===selected?d.file:f));setNotice('Saved')}
 async function newChat(){if(!project)return;const r=await fetch(`/api/projects/${project.id}/chats`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'New chat'})});const d=await r.json();if(!r.ok)return setNotice(d.error||'Could not create chat.');setChats(c=>[d.chat,...c]);await loadChat(d.chat.id)}
 async function ensureChat(){if(chatId)return chatId;if(!project)return null;const r=await fetch(`/api/projects/${project.id}/chats`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'New chat'})});const d=await r.json();if(!r.ok){setNotice(d.error||'Could not create chat.');return null;}setChats(c=>[d.chat,...c]);setChatId(d.chat.id);setMessages([]);return d.chat.id}
async function fileToBase64(file:globalThis.File){return new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(",")[1]||"");reader.onerror=reject;reader.readAsDataURL(file)})}
 async function send(){
  if(!project||!prompt.trim()||busy)return;
  const content=prompt.trim();
  setPrompt('');
  setBusy(true);
  setNotice('Understanding your request…');
  let activeChatId=chatId;
  try{
   activeChatId=await ensureChat();
   if(!activeChatId)throw new Error('Could not create a chat.');


   setNotice('Planning project changes…');
   const r=await fetch(`/api/projects/${project.id}/agent`,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({request:content,chatId:activeChatId,image:image?{mimeType:image.type,data:await fileToBase64(image)}:undefined})
   });
   const d=await r.json();
   if(!r.ok)throw new Error(d.error||'Agent run failed.');
   setRunId(d.runId);
   setNotice('Proposal ready for review…');
   await loadChat(activeChatId);
   setNotice('Complete');
  }catch(e){
   const error=e instanceof Error?e.message:'Request failed.';
   setNotice(error);
   setMessages(m=>m.map(x=>x.role==='assistant'&&x.content===''?{...x,content:error}:x));
  }finally{
   setBusy(false);
  }
 }
 async function downloadProject(){
  if(!project)return;
  setNotice('Preparing project ZIP…');
  try{
    const r=await fetch(`/api/projects/${project.id}/download`);
    if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(d.error||'Could not download project.')}
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download=`${project.name.replace(/[^a-z0-9._-]+/gi,'-')||'nexa-project'}.zip`;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
    setNotice('Project ZIP downloaded.');
  }catch(e){setNotice(e instanceof Error?e.message:'Could not download project.')}
 }
 function downloadCurrentFile(){
  if(!selectedFile)return;
  const blob=new Blob([selectedFile.content],{type:'text/plain;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=selectedFile.path.split('/').pop()||'file';document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
  setNotice(`Downloaded ${selectedFile.path}.`);
 }
 async function mobileGithub(){
  if(!project)return;
  if(project.github_repo){
    setNotice('Pushing project to GitHub…');
    const r=await fetch('/api/github/publish',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({projectId:project.id,repo:project.github_repo,branch:'main',message:'Update from Nexa Code AI'})});
    const d=await r.json().catch(()=>({}));
    setNotice(r.ok?`Pushed ${d.result?.files||0} file(s) to ${project.github_repo}.`:d.error||'GitHub push failed.');
  }else{
    location.href='/api/github/connect';
  }
 }
 async function signOut(){await supabase.auth.signOut();location.href='/login'}
async function deleteProject(){if(!project||busy)return;const confirmed=window.confirm(`Delete "${project.name}" and all of its files, chats, and memory? This cannot be undone.`);if(!confirmed)return;setBusy(true);const r=await fetch(`/api/projects/${project.id}`,{method:"DELETE"});const d=await r.json();if(!r.ok){setBusy(false);return setNotice(d.error||"Could not delete project.")}const remaining=projects.filter(p=>p.id!==project.id);setProjects(remaining);setProject(remaining[0]||null);setFiles([]);setChats([]);setMessages([]);setSelected("");setChatId("");setDraft("");setMobileMenuOpen(false);setBusy(false);setNotice("Project deleted")}

 return <div className={`app mobile-${mobileView}`}><aside className="sidebar"><div className="brand">Nexa Code AI</div><div className="section-label">PROJECTS</div><div className="project-create"><input value={newName} onChange={e=>setNewName(e.target.value)} placeholder="New project" onKeyDown={e=>e.key==='Enter'&&createProject()}/><button onClick={createProject}>+</button></div><div className="project-list">{projects.map(p=><button key={p.id} className={p.id===project?.id?'active':''} onClick={()=>setProject(p)}>{p.name}</button>)}</div><div className="section-label">CHATS</div><button className="side-action" onClick={newChat} disabled={!project}>＋ New chat</button><div className="chat-list">{chats.map(c=><button key={c.id} className={c.id===chatId?'active':''} onClick={()=>loadChat(c.id)}>{c.title}</button>)}</div><button className="side-action danger" onClick={deleteProject} disabled={!project||busy}>Delete project</button><button className="side-action logout" onClick={signOut}>Sign out</button></aside>
  <div className="composer"><textarea value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder="Ask the building agent..."/><label className="quick-action" style={{cursor:"pointer"}}>📎 Image<input type="file" accept="image/*" hidden onChange={e=>setImage(e.target.files?.[0]||null)}/></label>{image&&<span className="muted">📷 {image.name}</span>}<button className="primary send" onClick={send} disabled={busy||!project||!prompt.trim()}>Send</button></div>
 <aside className="inspector"><div className="card"><div className="card-title">Agent</div><div className="status-dot">● Autonomous · up to 3 steps</div><AgentReview runId={runId} onApproved={async () => { if (project) { const r = await fetch("/api/projects/" + project.id + "/files"); const d = await r.json(); if (r.ok) { const fs = d.files || []; setFiles(fs); setSelected(fs.find((f:any) => f.path === selected)?.path || fs[0]?.path || ""); } } }}/></div><div className="card"><div className="card-title">AI Gateway</div><ProviderSettings/></div><div className="card"><div className="card-title">GitHub & Vercel</div><IntegrationsPanel projectId={project?.id} onNotice={setNotice}/></div><div className="card"><div className="card-title">Project memory</div><p>Persistent chats, files, decisions and context are stored with the project.</p></div></aside></div>
}
