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
 const supabase=useMemo(()=>createSupabaseBrowserClient(),[]);const [projects,setProjects]=useState(initialProjects),[project,setProject]=useState<Project|null>(initialProjects[0]??null),[files,setFiles]=useState<File[]>([]),[selected,setSelected]=useState(''),[draft,setDraft]=useState(''),[chats,setChats]=useState<Chat[]>([]),[chatId,setChatId]=useState(''),[messages,setMessages]=useState<Message[]>([]),[prompt,setPrompt]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('Ready'),[newName,setNewName]=useState(''),[runId,setRunId]=useState<string>();
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
 async function send(){if(!project||!prompt.trim()||busy)return;const content=prompt.trim();setPrompt('');setBusy(true);setNotice('Preparing chat…');let activeChatId=chatId;try{activeChatId=await ensureChat();if(!activeChatId)throw new Error('Could not create a chat.');setNotice('Autonomous agent working…');const temp=crypto.randomUUID();setMessages(m=>[...m,{id:crypto.randomUUID(),role:'user',content,created_at:new Date().toISOString()},{id:temp,role:'assistant',content:'',created_at:new Date().toISOString()}]);const r=await fetch(`/api/projects/${project.id}/agent`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({request:content,chatId:activeChatId})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Agent run failed.');setRunId(d.runId);setMessages(m=>m.map(x=>x.id===temp?{...x,content:d.summary}:x));setNotice(`Completed ${d.iterations?.length||1} agent step(s).`);await loadChat(activeChatId)}catch(e){setNotice(e instanceof Error?e.message:'Agent run failed.')}finally{setBusy(false)}}
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
 return <div className="app"><aside className="sidebar"><div className="brand">Nexa Code AI</div><div className="section-label">PROJECTS</div><div className="project-create"><input value={newName} onChange={e=>setNewName(e.target.value)} placeholder="New project" onKeyDown={e=>e.key==='Enter'&&createProject()}/><button onClick={createProject}>+</button></div><div className="project-list">{projects.map(p=><button key={p.id} className={p.id===project?.id?'active':''} onClick={()=>setProject(p)}>{p.name}</button>)}</div><div className="section-label">CHATS</div><button className="side-action" onClick={newChat} disabled={!project}>＋ New chat</button><div className="chat-list">{chats.map(c=><button key={c.id} className={c.id===chatId?'active':''} onClick={()=>loadChat(c.id)}>{c.title}</button>)}</div><button className="side-action logout" onClick={signOut}>Sign out</button></aside>
 <main className="main"><header className="header"><div><strong>{project?.name||'Nexa Code AI'}</strong><div className="muted">Autonomous coding workspace · {notice}</div></div><div className="header-actions"><InstallAppButton/><button className="quick-action" onClick={downloadProject} disabled={!project||busy}>Download ZIP</button><button className="quick-action mobile-file-download" onClick={downloadCurrentFile} disabled={!selectedFile||busy}>Download file</button><button className="quick-action mobile-github" onClick={mobileGithub} disabled={!project||busy}>GitHub</button><button className="mobile-new-chat" onClick={newChat} disabled={!project||busy}>＋ New chat</button><button onClick={()=>project&&loadProject(project)}>Refresh</button></div></header><section className="workspace"><aside className="files"><div className="panel-title"><strong>Explorer</strong><span>{files.length}</span></div>{files.map(f=><button key={f.path} className={`file ${selected===f.path?'selected':''}`} onClick={()=>setSelected(f.path)}>{f.path}</button>)}</aside><section className="editor"><div className="editor-head"><strong>{selected||'No file selected'}</strong>{selected&&<button onClick={saveFile} disabled={busy}>Save</button>}</div><textarea className="code-editor" value={draft} onChange={e=>setDraft(e.target.value)} spellCheck={false}/><div className="chat-area"><div className="messages">{messages.map(m=><div key={m.id} className={`message ${m.role}`}><div className="message-role">{m.role==='user'?'You':'Nexa'}</div><div className="message-body">{m.content}</div></div>)}{!messages.length&&<div className="welcome"><h2>Build with Nexa.</h2><p>Describe a feature, refactor, bug fix, architecture decision, GitHub change, or deployment task.</p></div>}</div><div className="composer"><textarea value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder="Tell Nexa what to build or change…" onKeyDown={e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey))send()}}/><button className="primary send" onClick={send} disabled={busy||!project||!prompt.trim()}>Send</button></div><div className="muted hint">Ctrl/Cmd + Enter · bounded 3-step autonomous agent · no automatic code execution/testing</div></div></section></section></main>
 <aside className="inspector"><div className="card"><div className="card-title">Agent</div><div className="status-dot">● Autonomous · up to 3 steps</div><AgentReview runId={runId}/></div><div className="card"><div className="card-title">AI Gateway</div><ProviderSettings/></div><div className="card"><div className="card-title">GitHub & Vercel</div><IntegrationsPanel projectId={project?.id} onNotice={setNotice}/></div><div className="card"><div className="card-title">Project memory</div><p>Persistent chats, files, decisions and context are stored with the project.</p></div></aside></div>
}
