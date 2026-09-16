'use client';
import { useEffect,useMemo,useState } from 'react';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import { ProviderSettings } from '@/components/provider-settings';
import { IntegrationsPanel } from '@/components/integrations-panel';
import { AgentReview } from '@/components/agent-review';
import { InstallAppButton } from '@/components/install-app-button';

type Project={id:string;name:string;description:string|null;github_repo?:string|null;vercel_url?:string|null};
type File={path:string;content:string;version:number};type Chat={id:string;title:string;updated_at:string};type Message={id:string;role:'user'|'assistant'|'system';content:string;created_at:string};
async function prepareImage(file: globalThis.File){
 const bitmap=await createImageBitmap(file);
 const scale=Math.min(1,1600/Math.max(bitmap.width,bitmap.height));
 const canvas=document.createElement("canvas");
 canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);
 canvas.getContext("2d")!.drawImage(bitmap,0,0,canvas.width,canvas.height);
 const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error("Image compression failed")),"image/jpeg",0.8));
 return {mimeType:"image/jpeg",data:await new Promise<string>(resolve=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(",")[1]||"");r.readAsDataURL(blob)})};
}
function fileDot(path:string){
 const ext=(path.split('.').pop()||'').toLowerCase();
 const map:Record<string,string>={ts:'#4f7dff',tsx:'#4f7dff',js:'#f2c94c',jsx:'#f2c94c',json:'#8a93a8',css:'#9b5cff',md:'#8a93a8',html:'#ff7a59',sql:'#3ecf8e',env:'#ff6b7d'};
 return map[ext]||'#6b7488';
}

export function Workspace({initialProjects=[]}:{initialProjects?:Project[]}){
 const supabase=useMemo(()=>createSupabaseBrowserClient(),[]);const [projects,setProjects]=useState(initialProjects),[project,setProject]=useState<Project|null>(initialProjects[0]??null),[files,setFiles]=useState<File[]>([]),[selected,setSelected]=useState(''),[draft,setDraft]=useState(''),[chats,setChats]=useState<Chat[]>([]),[chatId,setChatId]=useState(''),[messages,setMessages]=useState<Message[]>([]),[prompt,setPrompt]=useState(''),[image,setImage]=useState<globalThis.File|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState('Ready'),[newName,setNewName]=useState(''),[runId,setRunId]=useState<string>(),[mobileView,setMobileView]=useState<'chat'|'code'|'files'|'tools'>('chat'),[mobileMenuOpen,setMobileMenuOpen]=useState(false),[mode,setMode]=useState<"conversation"|"agent">("conversation");
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
 async function send(){
  if(!project||!prompt.trim()||busy)return;
  const content=prompt.trim();
  setPrompt('');
  setBusy(true);
  setNotice('Understanding your request…');
  let activeChatId=chatId;
  try{
   activeChatId=await ensureChat();
   const preparedImage=image?await prepareImage(image):undefined;
   if(!activeChatId)throw new Error('Could not create a chat.');


   setNotice(mode==='conversation'?'Thinking…':'Planning project changes…');
   const r=await fetch(mode==='conversation'?'/api/chat':`/api/projects/${project.id}/agent`,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify(mode==='conversation'?{message:content,chatId:activeChatId,history:messages.map(m=>({role:m.role,content:m.content}))}:{request:content,chatId:activeChatId,image:preparedImage})
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

 return <div className={`app mobile-${mobileView}`}><aside className="sidebar"><div className="brand"><span className="brand-mark" aria-hidden="true">✦</span><span>Nexa Code AI</span></div><div className="section-label">PROJECTS</div><div className="project-create"><input value={newName} onChange={e=>setNewName(e.target.value)} placeholder="New project" onKeyDown={e=>e.key==='Enter'&&createProject()}/><button onClick={createProject}>+</button></div><div className="project-list">{projects.map(p=><button key={p.id} className={p.id===project?.id?'active':''} aria-current={p.id===project?.id?'true':undefined} onClick={()=>setProject(p)}>{p.name}</button>)}</div><div className="section-label">CHATS</div><button className="side-action" onClick={newChat} disabled={!project}>＋ New chat</button><div className="chat-list">{chats.map(c=><button key={c.id} className={c.id===chatId?'active':''} aria-current={c.id===chatId?'true':undefined} onClick={()=>loadChat(c.id)}>{c.title}</button>)}</div><div className="sidebar-divider" aria-hidden="true"></div><button className="side-action danger" onClick={deleteProject} disabled={!project||busy}>Delete project</button><button className="side-action logout" onClick={signOut}>Sign out</button></aside>
 <main className="main"><header className="header"><div className="mobile-header-title"><button className="mobile-menu-button" aria-label="Open workspace menu" aria-expanded={mobileMenuOpen} onClick={()=>setMobileMenuOpen(v=>!v)}>☰</button><span className="header-project-icon" aria-hidden="true">📁</span><div><strong>{project?.name||'Nexa Code AI'}</strong><div className="muted">Autonomous coding workspace · <span className="status-pill"><span className={`status-dot-sm ${busy?'busy':/error|fail|could not/i.test(notice)?'error':/approved|success|saved|implemented|ready/i.test(notice)?'success':''}`} aria-hidden="true"></span>{notice}</span></div></div></div><div className="header-actions"><InstallAppButton/><button className="quick-action" onClick={downloadProject} disabled={!project||busy}>Download ZIP</button><button className="quick-action mobile-file-download" onClick={downloadCurrentFile} disabled={!selectedFile||busy}>Download file</button><button className="quick-action mobile-github" onClick={mobileGithub} disabled={!project||busy}>GitHub</button><button className="mobile-new-chat" onClick={newChat} disabled={!project||busy}>＋ New chat</button><button onClick={()=>project&&loadProject(project)}>Refresh</button></div></header>{mobileMenuOpen&&<><button className="mobile-menu-backdrop" aria-label="Close workspace menu" onClick={()=>setMobileMenuOpen(false)}/><aside className="mobile-menu" aria-label="Workspace menu"><div className="mobile-menu-head"><strong>Nexa Code AI</strong><button onClick={()=>setMobileMenuOpen(false)} aria-label="Close menu">×</button></div><div className="section-label">PROJECTS</div><div className="project-create"><input value={newName} onChange={e=>setNewName(e.target.value)} placeholder="New project" onKeyDown={e=>e.key==='Enter'&&createProject()}/><button onClick={createProject}>+</button></div><div className="project-list mobile-project-list">{projects.map(p=><button key={p.id} className={p.id===project?.id?'active':''} aria-current={p.id===project?.id?'true':undefined} onClick={()=>{loadProject(p);setMobileMenuOpen(false)}}>{p.name}</button>)}</div><div className="section-label">CHATS</div><button className="side-action" onClick={()=>{newChat();setMobileMenuOpen(false)}} disabled={!project}>＋ New chat</button><div className="chat-list mobile-chat-list">{chats.map(c=><button key={c.id} className={c.id===chatId?'active':''} aria-current={c.id===chatId?'true':undefined} onClick={()=>{loadChat(c.id);setMobileView('chat');setMobileMenuOpen(false)}}>{c.title}</button>)}</div><div className="sidebar-divider" aria-hidden="true"></div><button className="side-action danger" onClick={deleteProject} disabled={!project||busy}>Delete project</button><button className="side-action logout" onClick={signOut}>Sign out</button></aside></>}<nav className="mobile-nav" aria-label="Workspace navigation"><button className={mobileView==='chat'?'active':''} aria-current={mobileView==='chat'?'true':undefined} onClick={()=>setMobileView('chat')}>Chat</button><button className={mobileView==='code'?'active':''} aria-current={mobileView==='code'?'true':undefined} onClick={()=>setMobileView('code')}>Code</button><button className={mobileView==='files'?'active':''} aria-current={mobileView==='files'?'true':undefined} onClick={()=>setMobileView('files')}>Files</button><button className={mobileView==='tools'?'active':''} aria-current={mobileView==='tools'?'true':undefined} onClick={()=>setMobileView('tools')}>Tools</button></nav><section className="workspace"><aside className="files"><div className="panel-title"><strong>Explorer</strong><span>{files.length}</span></div>{files.map(f=><button key={f.path} className={`file ${selected===f.path?'selected':''}`} aria-current={selected===f.path?'true':undefined} onClick={()=>{setSelected(f.path);setMobileView('code')}}><span className="file-dot" style={{background:fileDot(f.path)}} aria-hidden="true"></span><span className="file-name">{f.path}</span></button>)}</aside><section className="editor"><div className="code-pane"><div className="editor-head">{selected&&<span className="file-badge" style={{background:fileDot(selected)}} aria-hidden="true">{(selected.split('.').pop()||'').slice(0,2).toUpperCase()}</span>}<strong>{selected||'No file selected'}</strong>{selected&&<button onClick={saveFile} disabled={busy}>Save</button>}</div><textarea className="code-editor" value={draft} onChange={e=>setDraft(e.target.value)} spellCheck={false}/></div><div className="chat-area"><div className="chat-header"><div className="chat-header-info"><span className="chat-header-dot" aria-hidden="true"></span><strong>{chats.find(c=>c.id===chatId)?.title||'New chat'}</strong></div><span className="chat-header-status">{notice}</span></div><div className="messages">{messages.map(m=><div key={m.id} className={`message ${m.role}`}><div className="message-role">{m.role==='user'?'You':'Nexa'}</div><div className="message-body">{m.content}</div></div>)}{!messages.length&&<div className="welcome"><h2>Build with Nexa.</h2><p>Describe a feature, refactor, bug fix, architecture decision, GitHub change, or deployment task.</p></div>}{busy&&<div className="typing-indicator" role="status" aria-label="Nexa is working"><span></span><span></span><span></span></div>}</div><div className="composer"><div className="mode-switch" role="group" aria-label="Response mode"><button type="button" onClick={()=>setMode("conversation")} aria-pressed={mode==="conversation"} className={`mode-btn ${mode==="conversation"?"active":""}`}>Conversation</button><button type="button" onClick={()=>setMode("agent")} aria-pressed={mode==="agent"} className={`mode-btn ${mode==="agent"?"active":""}`}>Agent</button></div><textarea value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder="Tell Nexa what to build or change…" onKeyDown={e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey))send()}}/><div className="composer-row"><label className="quick-action attach" style={{cursor:"pointer"}}>📎 Image<input type="file" accept="image/*" hidden onChange={e=>setImage(e.target.files?.[0]||null)}/></label>{image&&<span className="muted">{image.name}</span>}<button className="primary send" onClick={send} disabled={busy||!project||!prompt.trim()}><span className="send-label">Send</span><span className="send-icon" aria-hidden="true">➤</span></button></div></div><div className="muted hint">Ctrl/Cmd + Enter · bounded 3-step autonomous agent · no automatic code execution/testing</div></div></section></section></main>
 <aside className="inspector"><div className="card"><div className="card-title">Agent</div><div className="status-dot">● Autonomous · up to 3 steps</div><AgentReview runId={runId} onApproved={async () => { if (project) { const r = await fetch("/api/projects/" + project.id + "/files"); const d = await r.json(); if (r.ok) { const fs = d.files || []; setFiles(fs); setSelected(fs.find((f:any) => f.path === selected)?.path || fs[0]?.path || ""); } } }}/></div><div className="card"><div className="card-title">AI Gateway</div><ProviderSettings/></div><div className="card"><div className="card-title">GitHub & Vercel</div><IntegrationsPanel projectId={project?.id} onNotice={setNotice}/></div><div className="card"><div className="card-title">Project memory</div><p>Persistent chats, files, decisions and context are stored with the project.</p></div></aside></div>
}
