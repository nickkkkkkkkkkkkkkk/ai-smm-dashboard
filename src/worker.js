// Sign in with TikTok and official stats. Static files are served by Cloudflare before this runs;
// only /auth/* and /api/* reach it. Tokens stay in KV and never leave the Worker.
// /api/data also hands the page the stats files from GitHub, so browsers never hit GitHub's
// 60-requests-an-hour limit for visitors without a login.

const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const API = 'https://open.tiktokapis.com/v2';
const SCOPES = 'user.info.basic,user.info.profile,user.info.stats,video.list';
const USER_FIELDS = 'open_id,avatar_url,display_name,username,follower_count,following_count,likes_count,video_count';
const VIDEO_FIELDS = 'id,title,create_time,share_url,view_count,like_count,comment_count,share_count';
const DATA_KEY = 'tiktok';
const REPO = 'nickkkkkkkkkkkkkkk/ai-smm-dashboard';
const FILES = ['accounts', 'posts', 'meta', 'stories'];

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!(await fromAccess(req, env))) return text('Sign in to the dashboard first.', 403);
    try {
      if (url.pathname === '/auth/tiktok/start') return start(url, env);
      if (url.pathname === '/auth/tiktok/callback') return await callback(req, url, env);
      if (url.pathname === '/auth/tiktok/disconnect' && req.method === 'POST') return await disconnect(req, url, env);
      if (url.pathname === '/api/tiktok') return json(await load(env));
      if (url.pathname === '/api/data') return json({ ...(await repoData()), tiktok: await load(env) });
    } catch (e) {
      return text(`Something went wrong: ${e.message}`, 502);
    }
    return text('Not found', 404);
  },
  async scheduled(_event, env) {
    await sync(env);
  },
};

// Cloudflare Access already blocks other visitors; checking its signed header as well keeps these
// routes closed if Access is ever switched off.
let certs;
async function fromAccess(req, env) {
  const jwt = req.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) return false;
  const [h, p, s] = jwt.split('.');
  try {
    const head = JSON.parse(new TextDecoder().decode(b64u(h)));
    const body = JSON.parse(new TextDecoder().decode(b64u(p)));
    if (body.iss !== `https://${env.ACCESS_TEAM}` || body.exp * 1000 < Date.now()) return false;
    certs ||= (await (await fetch(`https://${env.ACCESS_TEAM}/cdn-cgi/access/certs`)).json()).keys;
    const jwk = certs.find(k => k.kid === head.kid);
    if (!jwk) { certs = null; return false; }
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(s), new TextEncoder().encode(`${h}.${p}`));
  } catch {
    return false;
  }
}

function start(url, env) {
  if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET) return text('TikTok sign-in is not set up yet: add TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET to the Worker.', 503);
  const state = crypto.randomUUID();
  const q = new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY, scope: SCOPES, response_type: 'code', redirect_uri: redirectUri(url, env), state });
  return new Response(null, {
    status: 302,
    headers: { Location: `${AUTH_URL}?${q}`, 'Set-Cookie': `tt_state=${state}; Path=/auth/tiktok; Max-Age=600; HttpOnly; Secure; SameSite=Lax` },
  });
}

async function callback(req, url, env) {
  const state = (req.headers.get('Cookie') || '').match(/(?:^|;\s*)tt_state=([^;]+)/)?.[1];
  if (!state || state !== url.searchParams.get('state')) return back(url, 'error=state');
  const code = url.searchParams.get('code');
  if (!code) return back(url, 'error=' + encodeURIComponent(url.searchParams.get('error') || 'denied'));
  const tok = await token(env, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(url, env) });
  await env.HQ.put(`tok:${tok.open_id}`, JSON.stringify(tok));
  const data = await load(env);
  if (!data.accounts.some(a => a.open_id === tok.open_id)) data.accounts.push({ open_id: tok.open_id });
  const synced = await sync(env, data);
  const who = synced.accounts.find(a => a.open_id === tok.open_id);
  // Signing in again brings back an account that was removed from the dashboard.
  if (who?.account && (synced.hidden || []).includes(who.account.toLowerCase())) {
    synced.hidden = synced.hidden.filter(h => h !== who.account.toLowerCase());
    await env.HQ.put(DATA_KEY, JSON.stringify(synced));
  }
  return back(url, 'connected=' + encodeURIComponent(who?.account || ''));
}

async function disconnect(req, url, env) {
  if (req.headers.get('Origin') !== url.origin) return text('Forbidden', 403);
  const id = (await req.formData()).get('open_id');
  const tok = await env.HQ.get(`tok:${id}`, 'json');
  if (tok) await call('/oauth/revoke/', form({ client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, token: tok.access_token })).catch(() => {});
  await env.HQ.delete(`tok:${id}`);
  const data = await load(env);
  // "Remove account": also hide its public-page record, so it leaves the dashboard entirely.
  const gone = data.accounts.find(a => a.open_id === id)?.account;
  if (gone) data.hidden = [...new Set([...(data.hidden || []), gone.toLowerCase()])];
  data.accounts = data.accounts.filter(a => a.open_id !== id);
  data.videos = Object.fromEntries(Object.entries(data.videos).filter(([, v]) => v.open_id !== id));
  await env.HQ.put(DATA_KEY, JSON.stringify(data));
  return back(url, 'removed=' + encodeURIComponent(gone || ''));
}

// Refreshes every connected account. Runs on the cron in wrangler.jsonc and right after a sign-in.
async function sync(env, data) {
  data ||= await load(env);
  if (!data.accounts.length) return data;
  for (const a of data.accounts) {
    try {
      const tok = await fresh(env, a.open_id);
      const u = (await call(`/user/info/?fields=${USER_FIELDS}`, { headers: { Authorization: `Bearer ${tok.access_token}` } })).user;
      Object.assign(a, {
        account: '@' + u.username, display_name: u.display_name, avatar_url: u.avatar_url,
        followers: u.follower_count, following: u.following_count, profile_likes: u.likes_count, video_count: u.video_count,
        status: 'ok', error: undefined, as_of: new Date().toISOString(),
      });
      let cursor, pages = 0;
      do {
        const r = await call(`/video/list/?fields=${VIDEO_FIELDS}`, {
          method: 'POST', headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(cursor ? { max_count: 20, cursor } : { max_count: 20 }),
        });
        for (const v of r.videos || []) data.videos[v.id] = { open_id: a.open_id, views: v.view_count, likes: v.like_count, comments: v.comment_count, shares: v.share_count, url: v.share_url, title: v.title, created: v.create_time };
        cursor = r.has_more ? r.cursor : null;
      } while (cursor && ++pages < 5);
    } catch (e) {
      a.status = /token|auth|scope/i.test(e.message) ? 'reconnect' : 'error';
      a.error = e.message;
    }
  }
  data.updated_at = new Date().toISOString();
  await env.HQ.put(DATA_KEY, JSON.stringify(data));
  return data;
}

// Access tokens last a day; refresh one when it has under an hour left.
async function fresh(env, id) {
  const tok = await env.HQ.get(`tok:${id}`, 'json');
  if (!tok) throw new Error('No token stored; sign in again');
  if (tok.expires_at - Date.now() > 3600e3) return tok;
  const next = await token(env, { grant_type: 'refresh_token', refresh_token: tok.refresh_token });
  await env.HQ.put(`tok:${id}`, JSON.stringify(next));
  return next;
}

async function token(env, params) {
  const r = await call('/oauth/token/', form({ client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, ...params }));
  return { ...r, expires_at: Date.now() + r.expires_in * 1000, refresh_expires_at: Date.now() + r.refresh_expires_in * 1000 };
}

// TikTok returns errors either as {error, error_description} (OAuth) or {error: {code, message}} (API).
async function call(path, init) {
  const res = await fetch(API + path, init);
  const body = await res.json().catch(() => ({}));
  const err = typeof body.error === 'string' ? body.error_description || body.error : body.error && body.error.code !== 'ok' ? `${body.error.code}: ${body.error.message}` : null;
  if (!res.ok || err) throw new Error(err || `TikTok returned ${res.status}`);
  return body.data || body;
}

// The newest commit on main comes from git's own ref listing, which has no API rate limit. Files are
// then read from raw.githubusercontent.com by that commit, so they are never a stale cached copy.
// Kept in memory for 20 seconds so a page polling every 30 seconds costs GitHub almost nothing.
let repo = { at: 0, sha: null, files: null };
async function repoData() {
  if (Date.now() - repo.at < 20e3) return { sha: repo.sha, files: repo.files };
  try {
    const refs = await (await fetch(`https://github.com/${REPO}.git/info/refs?service=git-upload-pack`, { headers: { 'User-Agent': 'content-hq' } })).text();
    const sha = refs.match(/([0-9a-f]{40}) refs\/heads\/main\n/)?.[1];
    if (!sha) throw new Error('No main branch found');
    if (sha !== repo.sha) {
      const got = await Promise.all(FILES.map(async f => {
        const r = await fetch(`https://raw.githubusercontent.com/${REPO}/${sha}/data/${f}.json`);
        if (r.ok) return r.json();
        if (r.status === 404) return null;
        throw new Error(`GitHub returned ${r.status} for ${f}.json`);
      }));
      repo.files = Object.fromEntries(FILES.map((f, i) => [f, got[i]]));
      repo.sha = sha;
    }
    repo.at = Date.now();
  } catch (e) {
    if (!repo.files) throw e;
  }
  return { sha: repo.sha, files: repo.files };
}

const load = async (env) => (await env.HQ.get(DATA_KEY, 'json')) || { accounts: [], videos: {}, updated_at: null };
const form = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) });
// TIKTOK_REDIRECT_URI lets TikTok send people back via the public github.io page (tiktok-callback.html),
// for when TikTok wants the return address on the verified site; that page forwards here.
const redirectUri = (url, env) => env.TIKTOK_REDIRECT_URI || `${url.origin}/auth/tiktok/callback`;
const back = (url, q) => new Response(null, { status: 302, headers: { Location: `${url.origin}/?${q}`, 'Set-Cookie': 'tt_state=; Path=/auth/tiktok; Max-Age=0' } });
const json = (o) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const text = (t, status) => new Response(t, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
