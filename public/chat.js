const $ = (id) => document.getElementById(id);
const auth = () => ({ Authorization: `Bearer ${$('router-key').value}`, 'Content-Type': 'application/json' });
$('base-url').textContent = `${location.origin}/v1`;
let history = [];
function message(role, text) {
 const el = document.createElement('div'); el.className = 'message';
 const label = document.createElement('strong'); label.textContent = role;
 const content = document.createElement('span'); content.textContent = text;
 el.append(label, content); $('chat-messages').append(el); return content;
}
$('connect').onclick = async () => {
 try {
  const res = await fetch('/api/connections', { headers: auth() }); const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Connection failed');
  $('connection-status').textContent = `OpenRouter: ${data.providers.openrouter ? 'configured' : 'missing key'} · Ollama: ${data.providers.ollama ? 'configured' : 'missing URL'} · AI Gateway: ${data.gateway ? 'enabled for OpenRouter' : 'disabled'}. Configuration does not verify provider access.`;
 } catch (err) { $('connection-status').textContent = err.message; }
};
$('chat-form').onsubmit = async (event) => {
 event.preventDefault(); const text = $('user-input').value.trim(); if (!text) return;
 const button = $('send-button'); if (button.disabled) return;
 button.disabled = true; $('chat-status').textContent = 'Routing…';
 message('you', text); const output = message('assistant', '');
 const pending = [...history, { role: 'user', content: text }];
 try {
  const res = await fetch('/v1/chat/completions', { method: 'POST', headers: auth(), body: JSON.stringify({ model: $('model').value.trim(), messages: pending, stream: true }) });
  if (!res.ok) { const data = await res.json(); throw new Error(data.error?.message || 'Request failed'); }
  if (!res.body) throw new Error('Provider returned no body');
  let answer = '';
  if (!(res.headers.get('content-type') || '').includes('text/event-stream')) {
   const data = await res.json(); if (data.error) throw new Error(data.error.message || 'Provider error');
   answer = data.choices?.[0]?.message?.content || ''; output.textContent = answer;
  } else {
   const reader = res.body.getReader(), decoder = new TextDecoder(); let buffer = '', ended = false;
   const consume = () => {
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
     const frame = buffer.slice(0,boundary); buffer = buffer.slice(boundary+2);
     const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
     if (!data) continue;
     if (data === '[DONE]') { ended = true; return; }
     const chunk = JSON.parse(data); if (chunk.error) throw new Error(chunk.error.message || 'Provider error');
     answer += chunk.choices?.[0]?.delta?.content || ''; output.textContent = answer;
     $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
    }
   };
   try {
    while (!ended) { const {done,value} = await reader.read(); buffer += decoder.decode(value,{stream:!done}); buffer = buffer.replace(/\r\n/g,'\n'); if (done) buffer += '\n\n'; consume(); if (done) break; }
   } finally { await reader.cancel(); reader.releaseLock(); }
  }
  if (!answer) throw new Error('No text response returned. Use a chat model in this playground.');
  history = [...pending,{role:'assistant',content:answer}]; $('user-input').value = ''; $('chat-status').textContent = 'Complete';
 } catch(err) { $('chat-status').textContent = err.message; }
 finally { button.disabled = false; }
};
function validateLibrary(value) {
 if (!Array.isArray(value) || value.length > 200) throw new Error('Expected an array of up to 200 entries.');
 return value.map(item => {
  if (!item || !['mcp','repo','skill'].includes(item.type) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 120 || typeof item.url !== 'string') throw new Error('Each entry needs type (mcp, repo, skill), name, and HTTPS url.');
  const url = new URL(item.url); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use HTTPS URLs without embedded credentials.');
  return {type:item.type,name:item.name,url:url.href};
 });
}
let library = [];
try { library = validateLibrary(JSON.parse(localStorage.getItem('relay-library') || '[]')); } catch { $('library-status').textContent = 'Saved library could not be read. Import a valid library to replace it.'; }
function render() {
 $('library-items').replaceChildren();
 if (!library.length) { const p = document.createElement('p'); p.textContent = 'No integrations yet. Import a JSON library to get started.'; $('library-items').append(p); }
 library.forEach((entry,index) => {
  const card = document.createElement('article'), type = document.createElement('small'), title = document.createElement('h3'), link = document.createElement('a'), remove = document.createElement('button');
  type.textContent = entry.type.toUpperCase(); title.textContent = entry.name; link.textContent = 'Open source ↗'; link.href = entry.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; remove.textContent = 'Remove';
  remove.onclick = () => { const next = library.filter((_,i) => i !== index); try { localStorage.setItem('relay-library',JSON.stringify(next)); library = next; render(); } catch { $('library-status').textContent = 'Browser storage is unavailable.'; } };
  card.append(type,title,link,document.createElement('br'),remove); $('library-items').append(card);
 });
}
$('import').onchange = async (event) => {
 try {
  const file = event.target.files[0]; if (!file) return; if (file.size > 262144) throw new Error('Import must be under 256 KB.');
  const next = validateLibrary(JSON.parse(await file.text())); localStorage.setItem('relay-library',JSON.stringify(next)); library = next; render(); $('library-status').textContent = `Imported ${library.length} definitions. Previous library replaced.`;
 } catch(err) { $('library-status').textContent = err.message; }
 event.target.value = '';
};
$('export').onclick = () => { const url = URL.createObjectURL(new Blob([JSON.stringify(library,null,2)],{type:'application/json'})); const a = document.createElement('a'); a.href = url; a.download = 'relay-library.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000); };
render();
