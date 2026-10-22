import type { Env } from './types';
const error = (message: string, status: number) => Response.json({ error: { message, type: 'router_error' } }, { status });
export default {
 async fetch(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/api/') && !path.startsWith('/v1/')) return env.ASSETS.fetch(request);
  if (path === '/api/health') return Response.json({ status: 'ok' });
  if (!env.ROUTER_API_KEY) return error('Set ROUTER_API_KEY on the Worker.', 503);
  if (request.headers.get('Authorization') !== `Bearer ${env.ROUTER_API_KEY}`) return error('Invalid router API key.', 401);
  if (path === '/api/connections' && request.method === 'GET') return Response.json({ providers: { openrouter: Boolean(env.OPENROUTER_API_KEY), ollama: Boolean(env.OLLAMA_BASE_URL) }, gateway: Boolean(env.CF_ACCOUNT_ID && env.CF_GATEWAY_ID) });
  if (path === '/v1/models' && request.method === 'GET') return Response.json({ object: 'list', data: [ ...(env.OPENROUTER_API_KEY ? [{id:'openrouter/openai/gpt-4o-mini',object:'model',owned_by:'openrouter'}] : []), ...(env.OLLAMA_BASE_URL ? [{id:'ollama/llama3.2',object:'model',owned_by:'ollama'}] : []) ] });
  if (!['/api/chat','/v1/chat/completions'].includes(path)) return error('Route not found.',404);
  if (request.method !== 'POST') return error('Use POST.',405);
  if (Number(request.headers.get('content-length')) > 1048576) return error('Request too large.',413);
  let body: Record<string, unknown>;
  try { const text = await request.text(); if (text.length > 1048576) return error('Request too large.',413); body = JSON.parse(text); } catch { return error('Expected JSON.',400); }
  if (!body || typeof body !== 'object' || typeof body.model !== 'string' || !Array.isArray(body.messages) || !body.messages.length) return error('Provide model and nonempty messages.',400);
  const slash = body.model.indexOf('/'), provider = body.model.slice(0,slash), model = body.model.slice(slash+1);
  if (slash < 1 || !model || !['openrouter','ollama'].includes(provider)) return error('Use openrouter/<model> or ollama/<model>.',400);
  if (body.stream !== undefined && typeof body.stream !== 'boolean') return error('stream must be boolean.',400);
  const headers = new Headers({'Content-Type':'application/json'});
  let endpoint: string;
  if (provider === 'openrouter') {
   if (!env.OPENROUTER_API_KEY) return error('OpenRouter is not configured.',503);
   headers.set('Authorization',`Bearer ${env.OPENROUTER_API_KEY}`);
   endpoint = env.CF_ACCOUNT_ID && env.CF_GATEWAY_ID ? `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(env.CF_ACCOUNT_ID)}/${encodeURIComponent(env.CF_GATEWAY_ID)}/openrouter/chat/completions` : 'https://openrouter.ai/api/v1/chat/completions';
   if (env.CF_ACCOUNT_ID && env.CF_GATEWAY_ID && env.CF_AIG_TOKEN) headers.set('cf-aig-authorization',`Bearer ${env.CF_AIG_TOKEN}`);
  } else {
   if (!env.OLLAMA_BASE_URL) return error('Ollama is not configured.',503);
   try { const base = new URL(env.OLLAMA_BASE_URL); if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) return error('OLLAMA_BASE_URL requires HTTPS without credentials or query parameters.',503); endpoint = `${base.href.replace(/\/$/,'')}/chat/completions`; } catch { return error('Invalid Ollama URL.',503); }
   if (env.OLLAMA_API_KEY) headers.set('Authorization',`Bearer ${env.OLLAMA_API_KEY}`);
  }
  try {
   const upstream = await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({...body,model}),redirect:'error',signal:AbortSignal.timeout(120000)});
   if (!upstream.ok) { await upstream.body?.cancel(); return error(`Provider returned HTTP ${upstream.status}. Check credentials, model and quota.`,502); }
   return new Response(upstream.body,{headers:{'Content-Type':upstream.headers.get('Content-Type') || 'application/json','Cache-Control':'no-store'}});
  } catch { return error('Provider unreachable or request timed out.',502); }
 }
};
