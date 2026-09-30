'use strict';
/**
 * 方块竞技场 · 大型 PVP 活动报名站
 * 零依赖纯 Node.js 服务端（不需要 npm install）
 *
 *   node server.js            默认 http://localhost:8080
 *   set PORT=9000 && node server.js
 *
 * 前台：  /                       报名问卷
 * 后台：  /admintestpaper         问卷设计 / 审核 / 设置（主页面无入口）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const ADMIN_DIR = path.join(ROOT, 'admin');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SUB_FILE = path.join(DATA_DIR, 'submissions.json');
const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || '0.0.0.0';

/* ------------------------------------------------------------------ */
/* 默认配置                                                            */
/* ------------------------------------------------------------------ */
const DEFAULT_CONFIG = {
  title: '方块竞技场 · 大型 PVP 活动报名',
  subtitle: '填写下方问卷即可报名。管理员审核通过后，页面会显示 QQ 群号与加群问题答案。',
  qqGroup: '123456789',
  qqAnswer: '请在这里填写群问题的正确答案',
  maxAttempts: 3,
  open: true,
  adminPassword: 'admin123',
  questions: [
    { id: 'q1', type: 'text',   title: '你的游戏 ID（正版 / 离线均可）', required: true,  options: [] },
    { id: 'q2', type: 'choice', title: '你的 Minecraft 游戏版本',       required: true,  options: ['1.21.8', '1.21.4', '1.20.1', '其他'] },
    { id: 'q3', type: 'choice', title: '你最擅长的 PVP 项目',           required: true,  options: ['1v1 决斗', '搭床拆床', '弓箭 / 狙击', '生存偷袭', '我是萌新'] },
    { id: 'q4', type: 'choice', title: '你方便参赛的时间段',             required: true,  options: ['工作日晚上', '周末全天', '随时都行'] },
    { id: 'q5', type: 'text',   title: '你的 QQ 号（用于联系与拉群）',   required: true,  options: [] },
    { id: 'q6', type: 'text',   title: '说一句你的参赛宣言',             required: false, options: [] }
  ]
};

/* ------------------------------------------------------------------ */
/* 存储层（JSON 文件）                                                 */
/* ------------------------------------------------------------------ */
function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
  if (!fs.existsSync(SUB_FILE)) fs.writeFileSync(SUB_FILE, '[]', 'utf8');
}

function readJSON(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const v = JSON.parse(raw);
    return v === null || v === undefined ? fallback : v;
  } catch (e) {
    console.error('[store] 读取失败', file, e.message);
    return fallback;
  }
}

function writeJSON(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

let config = null;
let submissions = [];

function loadAll() {
  ensureStore();
  config = Object.assign({}, DEFAULT_CONFIG, readJSON(CONFIG_FILE, {}));
  if (!Array.isArray(config.questions)) config.questions = DEFAULT_CONFIG.questions.slice();
  config.maxAttempts = Number(config.maxAttempts) || 3;
  submissions = readJSON(SUB_FILE, []);
  if (!Array.isArray(submissions)) submissions = [];
}
function saveConfig() { writeJSON(CONFIG_FILE, config); }
function saveSubmissions() { writeJSON(SUB_FILE, submissions); }

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8'
};

function clientIP(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) {
    const first = String(xf).split(',')[0].trim();
    if (first) return first.replace(/^::ffff:/, '');
  }
  const ra = req.socket.remoteAddress || 'unknown';
  return ra.replace(/^::ffff:/, '');
}

function send(res, status, body, headers) {
  const h = Object.assign({ 'Cache-Control': 'no-store' }, headers || {});
  res.writeHead(status, h);
  res.end(body);
}
function sendJSON(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}
function readBody(req, limit = 1024 * 512) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}
function uid(n = 10) {
  return crypto.randomBytes(24).toString('base64url').replace(/[-_]/g, '').slice(0, n);
}
function nowISO() { return new Date().toISOString(); }

function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { send(res, 404, '404 Not Found', { 'Content-Type': 'text/plain; charset=utf-8' }); return; }
    send(res, 200, buf, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  });
}

/* ------------------------------------------------------------------ */
/* 管理员会话（内存 token）                                            */
/* ------------------------------------------------------------------ */
const sessions = new Map(); // token -> expireTs
const SESSION_TTL = 12 * 60 * 60 * 1000;

function newSession() {
  const t = uid(32);
  sessions.set(t, Date.now() + SESSION_TTL);
  return t;
}
function checkSession(req) {
  const t = req.headers['x-admin-token'];
  if (!t) return false;
  const exp = sessions.get(t);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(t); return false; }
  sessions.set(t, Date.now() + SESSION_TTL);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
}, 60 * 60 * 1000).unref();

/* ------------------------------------------------------------------ */
/* 业务：某 IP 的报名状态                                              */
/* ------------------------------------------------------------------ */
function ipSubmissions(ip) {
  return submissions.filter(s => s.ip === ip).sort((a, b) => (a.time < b.time ? -1 : 1));
}

function ipState(ip) {
  const list = ipSubmissions(ip);
  const max = config.maxAttempts;
  const used = list.length;
  const latest = list.length ? list[list.length - 1] : null;
  const approved = list.some(s => s.status === 'approved');
  const pending = list.some(s => s.status === 'pending');
  return {
    ip, used, max, remaining: Math.max(0, max - used),
    banned: used >= max && !approved,
    approved, pending, latest
  };
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  let pathname = '/';
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) { pathname = '/'; }
  const method = req.method.toUpperCase();

  try {
    /* ---------------- 页面 ---------------- */
    if (method === 'GET' || method === 'HEAD') {
      if (pathname === '/' || pathname === '/index.html') {
        return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
      }
      if (pathname === '/admintestpaper' || pathname === '/admintestpaper/') {
        return serveFile(res, path.join(ADMIN_DIR, 'admin.html'));
      }
      if (pathname.startsWith('/public/')) {
        const rel = pathname.slice('/public/'.length);
        const abs = path.resolve(PUBLIC_DIR, rel);
        if (abs.startsWith(PUBLIC_DIR)) return serveFile(res, abs);
      }
    }

    /* ---------------- 前台 API ---------------- */
    if (pathname === '/api/config' && method === 'GET') {
      return sendJSON(res, 200, {
        title: config.title,
        subtitle: config.subtitle,
        open: !!config.open,
        questions: config.questions
      });
    }

    if (pathname === '/api/me' && method === 'GET') {
      const ip = clientIP(req);
      const st = ipState(ip);
      const payload = {
        used: st.used, max: st.max, remaining: st.remaining,
        banned: st.banned, open: !!config.open,
        totalQuestions: config.questions.length,
        submission: null
      };
      if (st.latest) {
        payload.submission = {
          id: st.latest.id,
          status: st.latest.status,
          time: st.latest.time,
          reviewTime: st.latest.reviewTime || null,
          examTitle: st.latest.examTitle || config.title
        };
      }
      if (st.approved) {
        payload.qqGroup = config.qqGroup;
        payload.qqAnswer = config.qqAnswer;
      }
      return sendJSON(res, 200, payload);
    }

    if (pathname === '/api/submit' && method === 'POST') {
      const ip = clientIP(req);
      const st = ipState(ip);

      if (!config.open) return sendJSON(res, 403, { ok: false, code: 'CLOSED', message: '报名通道已关闭。' });
      if (st.approved) return sendJSON(res, 403, { ok: false, code: 'APPROVED', message: '你已通过审核。' });
      if (st.pending) return sendJSON(res, 409, { ok: false, code: 'PENDING', message: '你的问卷正在审核中，请耐心等待。' });
      if (st.used >= config.maxAttempts) {
        return sendJSON(res, 403, {
          ok: false, code: 'BANNED',
          message: `同一 IP 最多可提交 ${config.maxAttempts} 次，你的机会已用完，禁止继续答题。`
        });
      }

      const body = await readBody(req);
      const answers = body && typeof body.answers === 'object' && body.answers ? body.answers : {};

      const record = { id: uid(12), ip, time: nowISO(), status: 'pending', reviewTime: null, note: '', examTitle: config.title, answers: [] };
      for (const q of config.questions) {
        let val = answers[q.id];
        if (q.type === 'choice') {
          if (Array.isArray(val)) val = val[0];
          val = typeof val === 'string' ? val.trim() : '';
          if (val && !q.options.includes(val)) val = '';
        } else {
          val = val === undefined || val === null ? '' : String(val).trim().slice(0, 2000);
        }
        if (q.required && !val) {
          return sendJSON(res, 400, { ok: false, code: 'INCOMPLETE', message: `请完成必答题：${q.title}` });
        }
        record.answers.push({ qid: q.id, type: q.type, title: q.title, answer: val, options: q.options.slice() });
      }

      submissions.push(record);
      saveSubmissions();
      const after = ipState(ip);
      return sendJSON(res, 200, {
        ok: true,
        id: record.id,
        status: 'pending',
        used: after.used, max: after.max, remaining: after.remaining,
        message: '您的问卷正在审核中，请耐心等待'
      });
    }

    /* ---------------- 后台 API ---------------- */
    if (pathname === '/api/admin/login' && method === 'POST') {
      const body = await readBody(req);
      if (!body || body.password !== config.adminPassword) {
        return sendJSON(res, 401, { ok: false, message: '密码错误' });
      }
      return sendJSON(res, 200, { ok: true, token: newSession() });
    }

    if (pathname.startsWith('/api/admin/')) {
      if (!checkSession(req)) return sendJSON(res, 401, { ok: false, message: '未登录或登录已过期' });

      if (pathname === '/api/admin/session' && method === 'GET') return sendJSON(res, 200, { ok: true });

      if (pathname === '/api/admin/data' && method === 'GET') {
        const pending = submissions.filter(s => s.status === 'pending').length;
        const approved = submissions.filter(s => s.status === 'approved').length;
        const rejected = submissions.filter(s => s.status === 'rejected').length;
        return sendJSON(res, 200, {
          ok: true,
          stats: { pending, approved, rejected, reviewed: approved + rejected, total: submissions.length, ips: new Set(submissions.map(s => s.ip)).size },
          config: {
            title: config.title, subtitle: config.subtitle,
            qqGroup: config.qqGroup, qqAnswer: config.qqAnswer,
            maxAttempts: config.maxAttempts, open: !!config.open,
            questions: config.questions
          },
          submissions: submissions.slice().sort((a, b) => (a.time < b.time ? 1 : -1))
        });
      }

      if (pathname === '/api/admin/config' && method === 'POST') {
        const body = await readBody(req);
        if (body.title !== undefined) config.title = String(body.title).slice(0, 120);
        if (body.subtitle !== undefined) config.subtitle = String(body.subtitle).slice(0, 400);
        if (body.qqGroup !== undefined) config.qqGroup = String(body.qqGroup).slice(0, 64);
        if (body.qqAnswer !== undefined) config.qqAnswer = String(body.qqAnswer).slice(0, 400);
        if (body.maxAttempts !== undefined) config.maxAttempts = Math.max(1, Math.min(999, Number(body.maxAttempts) || 3));
        if (body.open !== undefined) config.open = !!body.open;
        if (body.questions !== undefined) {
          const cleaned = [];
          const list = Array.isArray(body.questions) ? body.questions : [];
          for (const q of list) {
            const type = q.type === 'text' ? 'text' : 'choice';
            const title = String(q.title || '').trim().slice(0, 300);
            if (!title) continue;
            let options = [];
            if (type === 'choice') {
              options = (Array.isArray(q.options) ? q.options : [])
                .map(o => String(o).trim().slice(0, 200)).filter(Boolean);
              if (!options.length) continue;
            }
            cleaned.push({ id: q.id && /^[\w-]+$/.test(q.id) ? q.id : uid(8), type, title, required: !!q.required, options });
          }
          if (!cleaned.length) return sendJSON(res, 400, { ok: false, message: '至少需要保留一道题' });
          config.questions = cleaned;
        }
        if (body.newPassword) {
          const p = String(body.newPassword);
          if (p.length < 4) return sendJSON(res, 400, { ok: false, message: '新密码至少 4 位' });
          config.adminPassword = p;
        }
        saveConfig();
        return sendJSON(res, 200, { ok: true });
      }

      if (pathname === '/api/admin/review' && method === 'POST') {
        const body = await readBody(req);
        const s = submissions.find(x => x.id === body.id);
        if (!s) return sendJSON(res, 404, { ok: false, message: '未找到该问卷' });
        if (body.action === 'approve') s.status = 'approved';
        else if (body.action === 'reject') s.status = 'rejected';
        else if (body.action === 'reset') s.status = 'pending';
        else return sendJSON(res, 400, { ok: false, message: '未知操作' });
        s.reviewTime = s.status === 'pending' ? null : nowISO();
        saveSubmissions();
        return sendJSON(res, 200, { ok: true, status: s.status });
      }

      if (pathname === '/api/admin/delete' && method === 'POST') {
        const body = await readBody(req);
        const idx = submissions.findIndex(x => x.id === body.id);
        if (idx < 0) return sendJSON(res, 404, { ok: false, message: '未找到该问卷' });
        submissions.splice(idx, 1);
        saveSubmissions();
        return sendJSON(res, 200, { ok: true });
      }

      if (pathname === '/api/admin/clear' && method === 'POST') {
        const body = await readBody(req);
        if (body.status) {
          submissions = submissions.filter(s => s.status !== body.status);
        } else {
          submissions = [];
        }
        saveSubmissions();
        return sendJSON(res, 200, { ok: true });
      }

      return sendJSON(res, 404, { ok: false, message: '接口不存在' });
    }

    return send(res, 404, '404 Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
  } catch (err) {
    console.error('[error]', req.method, pathname, err);
    return sendJSON(res, 500, { ok: false, message: err.message || '服务器内部错误' });
  }
});

loadAll();
server.listen(PORT, HOST, () => {
  const t = config.title;
  console.log('');
  console.log('  ┌────────────────────────────────────────────────┐');
  console.log('  │  方块竞技场 · PVP 活动报名站已启动              │');
  console.log('  └────────────────────────────────────────────────┘');
  console.log(`  标题    : ${t}`);
  console.log(`  报名页  : http://localhost:${PORT}/`);
  console.log(`  管理后台: http://localhost:${PORT}/admintestpaper`);
  console.log(`  默认密码: ${config.adminPassword}${config.adminPassword === 'admin123' ? '   ← 请登录后台后立即修改' : ''}`);
  console.log(`  数据目录: ${DATA_DIR}`);
  console.log('');
});
