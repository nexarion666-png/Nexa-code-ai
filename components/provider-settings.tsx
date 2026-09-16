'use client';

import { useEffect, useState } from 'react';

type ProviderKey = { id: string; provider: string; label: string | null; enabled: boolean; priority: number };
const providerNames: Record<string, string> = { 'google-ai-studio': 'Google AI Studio', groq: 'Groq', openrouter: 'OpenRouter', huggingface: 'Hugging Face' };

export function ProviderSettings() {
  const [keys, setKeys] = useState<ProviderKey[]>([]);
  const [provider, setProvider] = useState('google-ai-studio');
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function load() { const r = await fetch('/api/provider-keys'); if (r.ok) setKeys((await r.json()).keys ?? []); }
  useEffect(() => { load(); }, []);

  async function add() {
    if (!key.trim()) return;
    setBusy(true); setMessage('Saving securely…');
    const r = await fetch('/api/provider-keys', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ provider, key, label }) });
    const d = await r.json(); setBusy(false);
    if (!r.ok) return setMessage(d.error ?? 'Could not save key.');
    setKey(''); setLabel(''); setMessage('Key encrypted and saved.'); await load();
  }
  async function toggle(item: ProviderKey) {
    await fetch('/api/provider-keys', { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify({ id:item.id, enabled:!item.enabled }) });
    load();
  }
  async function remove(id: string) {
    await fetch('/api/provider-keys', { method: 'DELETE', headers: {'content-type':'application/json'}, body: JSON.stringify({ id }) });
    load();
  }
  return <div className="provider-settings">
    <div className="provider-form">
      <select value={provider} onChange={e=>setProvider(e.target.value)}><option value="google-ai-studio">Google AI Studio</option><option value="groq">Groq</option><option value="openrouter">OpenRouter</option><option value="huggingface">Hugging Face</option></select>
      <input value={label} onChange={e=>setLabel(e.target.value)} placeholder="Label (optional)" />
      <input value={key} onChange={e=>setKey(e.target.value)} placeholder="API key" type="password" autoComplete="off" />
      <button className="primary" onClick={add} disabled={busy || !key.trim()}>Add key</button>
    </div>
    {keys.map(k => <div className="provider-key" key={k.id}><div><strong>{providerNames[k.provider] ?? k.provider}</strong><div className="muted">{k.label || 'Saved key'} · ••••••••</div></div><div className="provider-key-actions"><button onClick={()=>toggle(k)}>{k.enabled ? 'Enabled' : 'Disabled'}</button><button onClick={()=>remove(k.id)}>Remove</button></div></div>)}
    {message && <div className="muted">{message}</div>}
    <p className="muted">Keys are never returned to the browser after saving. The gateway can fall back across enabled user keys and server environment keys.</p>
  </div>;
}
