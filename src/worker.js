// Sign in with TikTok / Instagram / YouTube and official stats. Static files are served by Cloudflare before this runs;
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

let HOME = null;
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    HOME = env.HOME_ORIGIN || null;
    if (!(await fromAccess(req, env))) return text('Sign in to the dashboard first.', 403);
    // TikTok and Instagram only accept the callback address registered with them, so sign-ins always
    // run on AUTH_ORIGIN (the workers.dev address) and then send the person back to HOME_ORIGIN.
    if (env.AUTH_ORIGIN && url.origin !== env.AUTH_ORIGIN && /^\/auth\/(tiktok|instagram|youtube)\/(start|setup)$/.test(url.pathname))
      return new Response(null, { status: 302, headers: { Location: env.AUTH_ORIGIN + url.pathname } });
    try {
      if (url.pathname === '/auth/tiktok/start') return start(url, env);
      if (url.pathname === '/auth/tiktok/callback') return await callback(req, url, env);
      if (url.pathname === '/auth/tiktok/disconnect' && req.method === 'POST') return await disconnect(req, url, env);
      if (url.pathname === '/auth/instagram/setup') return await igSetup(req, url, env);
      if (url.pathname === '/auth/instagram/start') return await igStart(url, env);
      if (url.pathname === '/auth/instagram/callback') return await igCallback(req, url, env);
      if (url.pathname === '/auth/youtube/setup') return await ytSetup(req, url, env);
      if (url.pathname === '/auth/youtube/start') return await ytStart(url, env);
      if (url.pathname === '/auth/youtube/callback') return await ytCallback(req, url, env);
      if (url.pathname === '/api/tiktok') return json(await load(env));
      if (url.pathname === '/api/data') return json({ ...(await repoData()), tiktok: await load(env), instagram: await igLoad(env), youtube: await ytLoad(env), whop: await whopLoad(env), feed: await feedLoad(env) });
      if (url.pathname === '/api/seen' && req.method === 'POST') return await markSeen(req, env);
      if (url.pathname === '/api/whop' && req.method === 'POST') return await whopSave(req, env);
    } catch (e) {
      return text(`Something went wrong: ${e.message}`, 502);
    }
    return text('Not found', 404);
  },
  async scheduled(_event, env) {
    const t = await sync(env), i = await igSync(env), y = await ytSync(env);
    await snapshot(env, t, i, y);
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


// Sign in with Instagram (Instagram API with Instagram Login, professional accounts only). Same shape
// as TikTok: the token stays in KV, the cron pulls followers and per-Reel numbers into KV 'instagram'.
const IG_AUTH = 'https://www.instagram.com/oauth/authorize';
const IG_GRAPH = 'https://graph.instagram.com/v22.0';
const IG_SCOPES = 'instagram_business_basic,instagram_business_manage_insights';
const IG_KEY = 'instagram';

// The Meta app's id and secret are pasted once into /auth/instagram/setup (behind Cloudflare Access)
// and kept in KV, so the secret never has to pass through chat or the repo. Worker vars win if set.
async function igApp(env) {
  if (env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET) return { id: env.INSTAGRAM_APP_ID, secret: env.INSTAGRAM_APP_SECRET };
  return (await env.HQ.get('igapp', 'json')) || {};
}

async function igSetup(req, url, env) {
  if (req.method === 'POST') {
    if (req.headers.get('Origin') !== url.origin) return text('Forbidden', 403);
    const f = await req.formData();
    const id = String(f.get('id') || '').trim(), secret = String(f.get('secret') || '').trim();
    if (!/^\d{6,20}$/.test(id) || !/^[0-9a-f]{20,64}$/i.test(secret)) return text('That doesn\'t look like an Instagram app ID and app secret. Go back and check both.', 400);
    await env.HQ.put('igapp', JSON.stringify({ id, secret }));
    return new Response(null, { status: 302, headers: { Location: '/auth/instagram/start' } });
  }
  const has = !!(await igApp(env)).id;
  return new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Instagram setup</title>
<body style="font:16px system-ui;max-width:32rem;margin:2rem auto;padding:0 16px">
<h1>Connect Instagram</h1><p>${has ? 'An app is already saved. Saving again replaces it.' : 'Paste the Instagram app ID and app secret from the Meta app.'}</p>
<p>Redirect URL to put in the app: <code>${url.origin}/auth/instagram/callback</code></p>
<form method="post"><p><label>Instagram app ID<br><input name="id" required style="width:100%"></label></p>
<p><label>Instagram app secret<br><input name="secret" type="password" required style="width:100%"></label></p>
<button>Save and sign in with Instagram</button></form>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function igStart(url, env) {
  const app = await igApp(env);
  if (!app.id) return new Response(null, { status: 302, headers: { Location: '/auth/instagram/setup' } });
  const state = crypto.randomUUID();
  const q = new URLSearchParams({ client_id: app.id, redirect_uri: `${url.origin}/auth/instagram/callback`, response_type: 'code', scope: IG_SCOPES, state });
  return new Response(null, {
    status: 302,
    headers: { Location: `${IG_AUTH}?${q}`, 'Set-Cookie': `ig_state=${state}; Path=/auth/instagram; Max-Age=600; HttpOnly; Secure; SameSite=Lax` },
  });
}

async function igCallback(req, url, env) {
  const state = (req.headers.get('Cookie') || '').match(/(?:^|;\s*)ig_state=([^;]+)/)?.[1];
  if (!state || state !== url.searchParams.get('state')) return back(url, 'error=state');
  const code = url.searchParams.get('code');
  if (!code) return back(url, 'error=' + encodeURIComponent(url.searchParams.get('error_reason') || url.searchParams.get('error') || 'denied'));
  // A short-lived token from the code, then swapped for a 60-day one.
  const app = await igApp(env);
  const short = await igCall('https://api.instagram.com/oauth/access_token', form({
    client_id: app.id, client_secret: app.secret, grant_type: 'authorization_code',
    redirect_uri: `${url.origin}/auth/instagram/callback`, code: code.replace(/#_$/, ''),
  }));
  const long = await igCall(`https://graph.instagram.com/access_token?${new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: app.secret, access_token: short.access_token })}`);
  const id = String(short.user_id);
  await env.HQ.put(`igtok:${id}`, JSON.stringify({ access_token: long.access_token, expires_at: Date.now() + long.expires_in * 1000 }));
  const data = await igLoad(env);
  if (!data.accounts.some(a => a.id === id)) data.accounts.push({ id });
  const synced = await igSync(env, data);
  return back(url, 'connected=' + encodeURIComponent(synced.accounts.find(a => a.id === id)?.account || 'Instagram'));
}

async function igSync(env, data) {
  data ||= await igLoad(env);
  for (const a of data.accounts) {
    try {
      const tok = await igFresh(env, a.id);
      const auth = `access_token=${encodeURIComponent(tok.access_token)}`;
      const u = await igCall(`${IG_GRAPH}/me?fields=user_id,username,profile_picture_url,followers_count,follows_count,media_count&${auth}`);
      Object.assign(a, { account: '@' + u.username, avatar_url: u.profile_picture_url, followers: u.followers_count, following: u.follows_count,
        media_count: u.media_count, status: 'ok', error: undefined, as_of: new Date().toISOString() });
      const media = await igCall(`${IG_GRAPH}/me/media?fields=id,caption,media_product_type,permalink,timestamp,like_count,comments_count&limit=50&${auth}`);
      for (const m of media.data || []) {
        // Views are an insight, not a field; a failed insight read keeps the last number.
        const views = await igCall(`${IG_GRAPH}/${m.id}/insights?metric=views&${auth}`).then(r => r.data?.[0]?.values?.[0]?.value).catch(() => undefined);
        data.videos[m.id] = { ...(data.videos[m.id] || {}), ig_id: a.id, url: m.permalink, title: m.caption || '', created: Date.parse(m.timestamp) / 1000,
          likes: m.like_count || 0, comments: m.comments_count || 0, ...(views != null ? { views } : {}) };
      }
    } catch (e) {
      a.status = /token|oauth|session|permission/i.test(e.message) ? 'reconnect' : 'error';
      a.error = e.message;
    }
  }
  data.updated_at = new Date().toISOString();
  await env.HQ.put(IG_KEY, JSON.stringify(data));
  return data;
}

// Long-lived tokens last 60 days and can be refreshed once they are a day old; refresh weekly.
async function igFresh(env, id) {
  const tok = await env.HQ.get(`igtok:${id}`, 'json');
  if (!tok) throw new Error('No token stored; sign in again');
  if (tok.expires_at - Date.now() > 53 * 864e5) return tok;
  const r = await igCall(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(tok.access_token)}`);
  const next = { access_token: r.access_token, expires_at: Date.now() + r.expires_in * 1000 };
  await env.HQ.put(`igtok:${id}`, JSON.stringify(next));
  return next;
}

async function igCall(url, init) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(body.error?.message || body.error_message || `Instagram returned ${res.status}`);
  return body;
}

// Sign in with YouTube (Google OAuth, read-only). Same shape again: the refresh token stays in KV and
// the cron pulls each channel's subscribers and per-Short numbers into KV 'youtube'. Google's chooser
// lets the person pick a Brand Account channel, so one Google login can connect several channels.
const YT_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const YT_API = 'https://www.googleapis.com/youtube/v3';
const YT_SCOPES = 'https://www.googleapis.com/auth/youtube.readonly';
const YT_KEY = 'youtube';

// The Google OAuth client's id and secret are pasted once into /auth/youtube/setup, like Instagram's.
async function ytApp(env) {
  if (env.YOUTUBE_CLIENT_ID && env.YOUTUBE_CLIENT_SECRET) return { id: env.YOUTUBE_CLIENT_ID, secret: env.YOUTUBE_CLIENT_SECRET };
  return (await env.HQ.get('ytapp', 'json')) || {};
}

async function ytSetup(req, url, env) {
  if (req.method === 'POST') {
    if (req.headers.get('Origin') !== url.origin) return text('Forbidden', 403);
    const f = await req.formData();
    const id = String(f.get('id') || '').trim(), secret = String(f.get('secret') || '').trim();
    if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(id) || !/^[\w-]{20,64}$/.test(secret)) return text('That doesn\'t look like a Google OAuth client ID and secret. Go back and check both.', 400);
    await env.HQ.put('ytapp', JSON.stringify({ id, secret }));
    return new Response(null, { status: 302, headers: { Location: '/auth/youtube/start' } });
  }
  const has = !!(await ytApp(env)).id;
  return new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>YouTube setup</title>
<body style="font:16px system-ui;max-width:32rem;margin:2rem auto;padding:0 16px">
<h1>Connect YouTube</h1><p>${has ? 'A client is already saved. Saving again replaces it.' : 'Paste the OAuth client ID and secret from the Google Cloud project (YouTube Data API v3 turned on).'}</p>
<p>Authorized redirect URI to put in the client: <code>${url.origin}/auth/youtube/callback</code></p>
<form method="post"><p><label>Client ID<br><input name="id" required style="width:100%"></label></p>
<p><label>Client secret<br><input name="secret" type="password" required style="width:100%"></label></p>
<button>Save and sign in with YouTube</button></form>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function ytStart(url, env) {
  const app = await ytApp(env);
  if (!app.id) return new Response(null, { status: 302, headers: { Location: '/auth/youtube/setup' } });
  const state = crypto.randomUUID();
  // consent + offline: Google only hands out a refresh token when it asks for consent.
  const q = new URLSearchParams({ client_id: app.id, redirect_uri: `${url.origin}/auth/youtube/callback`, response_type: 'code', scope: YT_SCOPES,
    access_type: 'offline', prompt: 'select_account consent', include_granted_scopes: 'true', state });
  return new Response(null, {
    status: 302,
    headers: { Location: `${YT_AUTH}?${q}`, 'Set-Cookie': `yt_state=${state}; Path=/auth/youtube; Max-Age=600; HttpOnly; Secure; SameSite=Lax` },
  });
}

async function ytCallback(req, url, env) {
  const state = (req.headers.get('Cookie') || '').match(/(?:^|;\s*)yt_state=([^;]+)/)?.[1];
  if (!state || state !== url.searchParams.get('state')) return back(url, 'error=state');
  const code = url.searchParams.get('code');
  if (!code) return back(url, 'error=' + encodeURIComponent(url.searchParams.get('error') || 'denied'));
  const app = await ytApp(env);
  const tok = await ytToken(app, { grant_type: 'authorization_code', code, redirect_uri: `${url.origin}/auth/youtube/callback` });
  if (!tok.refresh_token) return back(url, 'error=' + encodeURIComponent('Google sent no refresh token; remove the app at myaccount.google.com/permissions and sign in again'));
  const ch = (await ytCall(`/channels?part=id&mine=true`, tok.access_token)).items?.[0];
  if (!ch) return back(url, 'error=' + encodeURIComponent('that Google login has no YouTube channel'));
  await env.HQ.put(`yttok:${ch.id}`, JSON.stringify(tok));
  const data = await ytLoad(env);
  if (!data.accounts.some(a => a.id === ch.id)) data.accounts.push({ id: ch.id });
  const synced = await ytSync(env, data);
  return back(url, 'connected=' + encodeURIComponent(synced.accounts.find(a => a.id === ch.id)?.account || 'YouTube'));
}

async function ytSync(env, data) {
  data ||= await ytLoad(env);
  if (!data.accounts.length) return data;
  const app = await ytApp(env);
  for (const a of data.accounts) {
    try {
      const at = await ytFresh(env, app, a.id);
      const c = (await ytCall(`/channels?part=snippet,statistics,contentDetails&mine=true`, at)).items?.[0];
      if (!c) throw new Error('channel not found');
      Object.assign(a, { account: c.snippet.customUrl ? (c.snippet.customUrl.startsWith('@') ? c.snippet.customUrl : '@' + c.snippet.customUrl) : c.snippet.title,
        title: c.snippet.title, avatar_url: c.snippet.thumbnails?.default?.url, followers: +c.statistics.subscriberCount || 0,
        views: +c.statistics.viewCount || 0, video_count: +c.statistics.videoCount || 0, status: 'ok', error: undefined, as_of: new Date().toISOString() });
      // Newest 50 uploads, then their numbers in one call.
      const items = (await ytCall(`/playlistItems?part=contentDetails&maxResults=50&playlistId=${c.contentDetails.relatedPlaylists.uploads}`, at)).items || [];
      const ids = items.map(i => i.contentDetails.videoId).join(',');
      if (ids) for (const v of (await ytCall(`/videos?part=snippet,statistics&id=${ids}`, at)).items || []) {
        data.videos[v.id] = { channel_id: a.id, url: `https://www.youtube.com/shorts/${v.id}`, title: v.snippet.title, created: Date.parse(v.snippet.publishedAt) / 1000,
          views: +v.statistics.viewCount || 0, likes: +v.statistics.likeCount || 0, comments: +v.statistics.commentCount || 0 };
      }
    } catch (e) {
      a.status = /token|invalid_grant|auth|credentials/i.test(e.message) ? 'reconnect' : 'error';
      a.error = e.message;
    }
  }
  data.updated_at = new Date().toISOString();
  await env.HQ.put(YT_KEY, JSON.stringify(data));
  return data;
}

// Google access tokens last an hour; the refresh token is kept and reused.
async function ytFresh(env, app, id) {
  const tok = await env.HQ.get(`yttok:${id}`, 'json');
  if (!tok) throw new Error('No token stored; sign in again');
  if (tok.expires_at - Date.now() > 300e3) return tok.access_token;
  const next = { ...tok, ...(await ytToken(app, { grant_type: 'refresh_token', refresh_token: tok.refresh_token })) };
  await env.HQ.put(`yttok:${id}`, JSON.stringify(next));
  return next.access_token;
}

async function ytToken(app, params) {
  const res = await fetch('https://oauth2.googleapis.com/token', form({ client_id: app.id, client_secret: app.secret, ...params }));
  const r = await res.json().catch(() => ({}));
  if (!res.ok || r.error) throw new Error(r.error_description || r.error || `Google returned ${res.status}`);
  return { ...r, expires_at: Date.now() + r.expires_in * 1000 };
}

async function ytCall(path, accessToken) {
  const res = await fetch(YT_API + path, { headers: { Authorization: `Bearer ${accessToken}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(body.error?.message || `YouTube returned ${res.status}`);
  return body;
}

const ytLoad = async (env) => (await env.HQ.get(YT_KEY, 'json')) || { accounts: [], videos: {}, updated_at: null };

// Notifications: each 10-minute refresh saves every account's followers and every video's views
// (KV 'cur'). 'seen' is the copy from when the owner last marked the feed as seen (POST /api/seen),
// so the page can show one line per video with its total change since then.
async function snapshot(env, t, i, y) {
  const nums = {}, info = {};
  const add = (key, n, meta) => { nums[key] = n; info[key] = meta; };
  const who = (list, id, k) => list.accounts.find(a => a[k] === id)?.account || '';
  const clip = (s) => (s || '').replace(/\s+/g, ' ').slice(0, 90);
  for (const [plat, list] of [['tiktok', t], ['instagram', i], ['youtube', y]])
    for (const a of list.accounts) if (a.status === 'ok') add(`f:${plat}:${a.account}`, a.followers || 0, { kind: 'followers', platform: plat, account: a.account });
  for (const [id, v] of Object.entries(t.videos)) add(`v:tiktok:${id}`, v.views || 0, { kind: 'views', platform: 'tiktok', account: who(t, v.open_id, 'open_id'), title: clip(v.title), url: v.url });
  for (const [id, v] of Object.entries(i.videos)) if (v.views != null) add(`v:instagram:${id}`, v.views, { kind: 'views', platform: 'instagram', account: who(i, v.ig_id, 'id'), title: clip(v.title), url: v.url });
  for (const [id, v] of Object.entries(y.videos)) add(`v:youtube:${id}`, v.views || 0, { kind: 'views', platform: 'youtube', account: who(y, v.channel_id, 'id'), title: clip(v.title), url: v.url });
  const cur = { at: new Date().toISOString(), nums, info };
  await env.HQ.put('cur', JSON.stringify(cur));
  if (!(await env.HQ.get('seen'))) await env.HQ.put('seen', JSON.stringify({ at: cur.at, nums }));
}
const feedLoad = async (env) => ({ cur: await env.HQ.get('cur', 'json'), seen: await env.HQ.get('seen', 'json') });
async function markSeen(req, env) {
  if (!(req.headers.get('Content-Type') || '').startsWith('application/json')) return text('Expected JSON', 415);
  const cur = await env.HQ.get('cur', 'json');
  if (cur) await env.HQ.put('seen', JSON.stringify({ at: cur.at, nums: cur.nums }));
  return json(await feedLoad(env));
}

// Whop payouts, logged by hand on the dashboard (Whop has no public earnings feed). KV key 'whop'.
const whopLoad = async (env) => (await env.HQ.get('whop', 'json')) || { payouts: [] };
async function whopSave(req, env) {
  // JSON only: browsers can't send it cross-site without a preflight, which this Worker never answers.
  if (!(req.headers.get('Content-Type') || '').startsWith('application/json')) return text('Expected JSON', 415);
  const b = await req.json().catch(() => ({}));
  const data = await whopLoad(env);
  if (b.action === 'add') {
    const amount = Math.round(Number(b.amount) * 100) / 100;
    if (!(amount > 0 && amount < 1e6) || !/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) return text('Enter an amount and a date.', 400);
    data.payouts.push({ id: crypto.randomUUID(), amount, date: b.date, note: String(b.note || '').slice(0, 80) });
  } else if (b.action === 'remove') {
    data.payouts = data.payouts.filter(x => x.id !== b.id);
  } else return text('Unknown action', 400);
  await env.HQ.put('whop', JSON.stringify(data));
  return json(data);
}

const igLoad = async (env) => (await env.HQ.get(IG_KEY, 'json')) || { accounts: [], videos: {}, updated_at: null };

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
const back = (url, q) => new Response(null, { status: 302, headers: { Location: `${HOME || url.origin}/?${q}`, 'Set-Cookie': `${{ instagram: 'ig', youtube: 'yt' }[url.pathname.split('/')[2]] || 'tt'}_state=; Path=/auth/${url.pathname.split('/')[2]}; Max-Age=0` } });
const json = (o) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const text = (t, status) => new Response(t, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
