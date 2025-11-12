import { connect } from "cloudflare:sockets";
import { DurableObject } from "cloudflare:workers";

/* ===== CONFIG ===== */
const PORTS = [443, 80];
const PROTOCOLS = ["vless", "trojan", "ss"];
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
const PRX_PER_PAGE = 24;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS,DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
  "Access-Control-Max-Age": "86400",
};

/* ===== ENTRY (wrap try/catch supaya tidak 1101) ===== */
export default {
  async fetch(request, env, ctx) {
    try { return await handleRequest(request, env, ctx); }
    catch (e) {
      const msg = (e && e.stack) ? e.stack : String(e);
      console.error("UNCAUGHT", msg);
      return new Response("1101 TRACE:\n" + msg, { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
  },
  async scheduled(controller, env, ctx) {
    try { ctx.waitUntil(refreshProxyList(env)); }
    catch (e) { console.error("CRON ERR", e?.stack || e); }
  }
};

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const upgrade = request.headers.get("Upgrade");

  /* --- DIAG --- */
  if (url.pathname === "/__diag") {
    const flags = {
      has_TUNNEL_DO: !!env.TUNNEL_DO,
      has_PRX_BANK_URL: !!env.PRX_BANK_URL,
      has_CF_API_EMAIL: !!env.CF_API_EMAIL,
      has_CF_GLOBAL_API_KEY: !!env.CF_GLOBAL_API_KEY,
      env_APP: `${env.APP_SERVICE_NAME || "?"}.${env.APP_ROOT_DOMAIN || "?"}`
    };
    let doProbe = "skip";
    try {
      if (env.TUNNEL_DO) {
        const id = env.TUNNEL_DO.idFromName("diag");
        const stub = env.TUNNEL_DO.get(id);
        const r = await stub.fetch("https://do/diag");
        doProbe = `${r.status} ${await r.text()}`;
      }
    } catch (e) { doProbe = "ERR " + (e?.message || e); }
    return new Response(JSON.stringify({ flags, doProbe }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  /* --- DO WS endpoint --- */
  if (url.pathname.startsWith("/ws/")) {
    if (upgrade !== "websocket") return new Response("Expected Upgrade: websocket", { status: 426 });
    if (!env.TUNNEL_DO) throw new Error("Binding TUNNEL_DO missing");
    const room = url.pathname.replace("/ws/", "") || "default";
    const id = env.TUNNEL_DO.idFromName(room);
    const stub = env.TUNNEL_DO.get(id);
    return stub.fetch(request);
  }

  /* --- WS TUNNEL langsung --- */
  if (upgrade === "websocket") {
    const m = url.pathname.match(/^\/Free-VPN-OrangLemah\/(.+[:=-]\d+)$/i);
    if (m) return websocketHandler(request, m[1]);
  }

  /* --- ROUTES --- */
  if (url.pathname.startsWith("/sub")) return handleSubPage(request, env);

  if (url.pathname.startsWith("/check")) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    const raw = new URL(request.url).searchParams.get("target") || "";
    let ip = "", port = "";
    if (raw.includes(":")) [ip, port] = raw.split(":"); else if (raw.includes("-")) [ip, port] = raw.split("-");
    ip = (ip || "").trim(); port = (port || "").trim();
    if (!ip || !/^[0-9a-fA-F:.]+$|^[a-zA-Z0-9.-]+$/.test(ip)) return json({ status: "INACTIVE", error: "Invalid IP" }, 400);
    const result = await checkPrxHealth(ip, port || "443", request.cf);
    return json(result);
  }

  if (url.pathname.startsWith("/api/v1")) {
    const p = url.pathname.replace("/api/v1", "");
    if (p.startsWith("/domains")) {
      const sub = p.replace("/domains", "");
      const api = new CloudflareApi(env);
      if (sub === "/get") return json(await api.getDomainList());
      if (sub === "/put") {
        const domain = url.searchParams.get("domain");
        const s = await api.registerDomain(domain);
        return new Response(String(s), { status: s, headers: CORS_HEADERS });
      }
      if (sub.startsWith("/delete")) {
        const id = url.searchParams.get("id");
        const pass = url.searchParams.get("password") || "";
        if (pass !== (env.OWNER_PASSWORD || "")) return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
        if (!id) return new Response("Domain ID is required", { status: 400, headers: CORS_HEADERS });
        const s = await api.deleteDomain(id);
        return new Response(String(s), { status: s, headers: CORS_HEADERS });
      }
    }

    if (p.startsWith("/sub")) {
      const fillerDomain = url.searchParams.get("domain") || `${env.APP_SERVICE_NAME}.${env.APP_ROOT_DOMAIN}`;
      const effectiveHost = (fillerDomain === `${env.APP_SERVICE_NAME}.${env.APP_ROOT_DOMAIN}`)
        ? fillerDomain : `${fillerDomain}.${env.APP_SERVICE_NAME}.${env.APP_ROOT_DOMAIN}`;

      const filterCC = (url.searchParams.get("cc")?.split(",") || []).filter(Boolean);
      const filterPort = (url.searchParams.get("port")?.split(",") || PORTS).map(Number);
      const filterVPN  = (url.searchParams.get("vpn")?.split(",") || PROTOCOLS);
      const limit = parseInt(url.searchParams.get("limit") || "10");
      const format = url.searchParams.get("format") || "raw";

      const prxList = await getPrxList(env);
      let work = prxList; if (filterCC.length) work = work.filter(p => filterCC.includes(p.country));
      shuffleArray(work);

      const uuid = crypto.randomUUID();
      const out = [];
      for (const prx of work) {
        for (const port of filterPort) {
          for (const vpn of filterVPN) {
            if (out.length >= limit) break;
            const u = new URL(`${vpn}://${fillerDomain}`);
            u.searchParams.set("encryption", "none");
            u.searchParams.set("type", "ws");
            u.searchParams.set("host", effectiveHost);
            u.port = String(port);
            if (vpn === "ss") {
              u.username = btoa(`none:${uuid}`);
              u.searchParams.set("plugin",
                `v2ray-plugin${port === 80 ? "" : ";tls"};mux=0;mode=websocket;path=/Free-VPN-OrangLemah/${prx.prxIP}-${prx.prxPort};host=${effectiveHost}`);
            } else {
              u.username = uuid; u.searchParams.delete("plugin");
            }
            u.searchParams.set("security", port === 443 ? "tls" : "none");
            u.searchParams.set("sni", (port === 80 && vpn === "trojan") ? "" : effectiveHost);
            u.searchParams.set("path", `/Free-VPN-oranglemah/${prx.prxIP}-${prx.prxPort}`);
            u.hash = `${out.length + 1} ${getFlagEmoji(prx.country)} ${prx.org} WS ${port === 443 ? "TLS" : "NTLS"} [${env.APP_SERVICE_NAME}]`;
            out.push(u.toString());
          }
        }
      }

      if (format === "raw") return new Response(out.join("\n"), { headers: CORS_HEADERS });
      if (format === "v2ray") return new Response(btoa(out.join("\n")), { headers: CORS_HEADERS });
      if (["clash", "sfa", "bfr"].includes(format)) {
        const r = await fetch(env.CONVERTER_URL, { method: "POST", body: JSON.stringify({ url: out.join(","), format, template: "cf" }) });
        if (!r.ok) return new Response(r.statusText, { status: r.status, headers: CORS_HEADERS });
        return new Response(await r.text(), { headers: CORS_HEADERS });
      }
      return new Response(out.join("\n"), { headers: CORS_HEADERS });
    }

    if (p.startsWith("/myip")) {
      return json({
        ip: request.headers.get("cf-connecting-ipv6") || request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip"),
        colo: request.headers.get("cf-ray")?.split("-")[1],
        ...request.cf,
      });
    }
  }

  return new Response(
    "CF DO VPN worker online.\nRoutes:\n- /__diag\n- /sub\n- /check?target=IP:PORT\n- /api/v1/domains/*, /api/v1/sub, /api/v1/myip\n- /ws/<room>\n- /Free-VPN-OrangLemah/<ip:port>",
    { headers: { "Content-Type": "text/plain; charset=utf-8" } }
  );
}

/* ===== Durable Object (tanpa WebSocketRequestResponsePair) ===== */
export class TunnelDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sessions = new Map();
    this.ctx.getWebSockets().forEach(ws => {
      const att = ws.deserializeAttachment();
      if (att) this.sessions.set(ws, att);
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/diag") return new Response("DO OK", { status: 200 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    const id = crypto.randomUUID();
    server.serializeAttachment({ id, connectedAt: Date.now() });
    this.sessions.set(server, { id });

    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, msg) {
    const s = this.sessions.get(ws) || { id: "unknown" };
    this.sessions.forEach((_, other) => { try { other.send(`[DO] ${msg} from:${s.id}`); } catch {} });
  }
  async webSocketClose(ws){ this.sessions.delete(ws); }
  async webSocketError(ws){ this.sessions.delete(ws); }
}

/* ===== Sub page / helper / tcp / cache / utils (unchanged) ===== */
async function handleSubPage(request, env) { /* …(same as sebelumnya)… */ }
async function websocketHandler(request, ipPort) { /* …(same as sebelumnya)… */ }
async function handleTCPOutBound(remoteSocketWrapper, addressRemote, portRemote, rawClientData, webSocket, responseHeader, log){ /* … */ }
async function remoteSocketToWS(remoteSocket, webSocket, responseHeader, retry, log){ /* … */ }
function makeReadableWebSocketStream(wsServer, earlyDataHeader, log){ /* … */ }
function safeCloseWebSocket(socket){ /* … */ }
async function checkPrxHealth(prxIP, prxPort, cf) { /* … */ }
async function refreshProxyList(env) { /* … */ }
function parsePrxText(text) { /* … */ }
async function getPrxList(env) { /* … */ }
function shuffleArray(a){ let i=a.length; while(i){ const r=(Math.random()*i--)|0; [a[i],a[r]]=[a[r],a[i]]; } }
function base64ToArrayBuffer(b64){ if(!b64) return {}; try{ b64=b64.replace(/-/g,"+").replace(/_/g,"/"); const dec=atob(b64); const buf=Uint8Array.from(dec,c=>c.charCodeAt(0)); return { earlyData: buf.buffer }; }catch(e){ return { error:e }; } }
function getFlagEmoji(cc){ return cc.toUpperCase().split("").map(ch=>String.fromCodePoint(127397 + ch.charCodeAt(0))).join(""); }
function json(obj, status=200){ return new Response(JSON.stringify(obj), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }); }

class CloudflareApi {
  constructor(env){
    this.email = env.CF_API_EMAIL;
    this.key = env.CF_GLOBAL_API_KEY;
    this.service = env.APP_SERVICE_NAME;
    this.headers = {
      "Authorization": `Bearer ${this.key}`,
      "X-Auth-Email": this.email,
      "X-Auth-Key": this.key,
      "Content-Type": "application/json",
    };
  }
  async _account(){ return (globalThis.ACCOUNT_ID || "7e6b4320b3200424e6b2ae7ba87e8805"); }
  async getDomainList(){
    const u = `https://api.cloudflare.com/client/v4/accounts/${await this._account()}/workers/domains`;
    const r = await fetch(u, { headers: this.headers }); if (!r.ok) return [];
    const j = await r.json(); return (j.result||[]).filter(d=>d.service===this.service).map(d=>({ id:d.id, hostname:d.hostname }));
  }
  async registerDomain(domain){
    try{
      domain = String(domain||"").toLowerCase(); if (!domain.includes(".")) return 400;
      if ((await this.getDomainList()).some(d=>d.hostname===domain)) return 409;
      const u = `https://api.cloudflare.com/client/v4/accounts/${await this._account()}/workers/domains`;
      const r = await fetch(u, { method:"PUT", headers:this.headers, body:JSON.stringify({ environment:"production", hostname:domain, service:this.service }) });
      return r.status;
    } catch { return 400; }
  }
  async deleteDomain(id){
    const u = `https://api.cloudflare.com/client/v4/accounts/${await this._account()}/workers/domains/${id}`;
    const r = await fetch(u, { method:"DELETE", headers:this.headers }); return r.status;
  }
}
