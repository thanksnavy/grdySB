export interface Env {
 ASSETS: { fetch(request: Request): Promise<Response> };
 ROUTER_API_KEY?: string;
 OPENROUTER_API_KEY?: string;
 OLLAMA_BASE_URL?: string;
 OLLAMA_API_KEY?: string;
 CF_ACCOUNT_ID?: string;
 CF_GATEWAY_ID?: string;
 CF_AIG_TOKEN?: string;
}
