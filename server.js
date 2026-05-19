const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const IS_VERCEL = !!process.env.DATABASE_URL;

// ============ 数据库抽象层 ============

// 本地 sql.js
let db;
const DB_PATH = path.join(__dirname, 'registration.db');

async function initLocalDB() {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const filebuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(filebuffer);
  } else {
    db = new SQL.Database();
  }
  db.run(`CREATE TABLE IF NOT EXISTS tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    used INTEGER DEFAULT 0,
    used_at TEXT,
    created_at TEXT DEFAULT (datetime('now', '+8 hours'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    event_type TEXT NOT NULL,
    phone TEXT NOT NULL,
    emergency_name TEXT NOT NULL,
    emergency_phone TEXT NOT NULL,
    nationality TEXT NOT NULL,
    address TEXT NOT NULL,
    participants TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now', '+8 hours'))
  )`);
  saveLocalDB();
  console.log('本地 SQLite 数据库初始化完成');
}

function saveLocalDB() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// Neon PostgreSQL
let neonPool;
async function initNeonDB() {
  const { neon } = require('@neondatabase/serverless');
  neonPool = neon(process.env.DATABASE_URL);
  await neonPool`CREATE TABLE IF NOT EXISTS tokens (
    id SERIAL PRIMARY KEY,
    token TEXT UNIQUE NOT NULL,
    used INTEGER DEFAULT 0,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT (now() AT TIME ZONE 'Asia/Shanghai')
  )`;
  await neonPool`CREATE TABLE IF NOT EXISTS registrations (
    id SERIAL PRIMARY KEY,
    token TEXT UNIQUE NOT NULL,
    event_type TEXT NOT NULL,
    phone TEXT NOT NULL,
    emergency_name TEXT NOT NULL,
    emergency_phone TEXT NOT NULL,
    nationality TEXT NOT NULL,
    address TEXT NOT NULL,
    participants JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT (now() AT TIME ZONE 'Asia/Shanghai')
  )`;
  console.log('Neon PostgreSQL 数据库初始化完成');
}

async function initDB() {
  if (IS_VERCEL) {
    await initNeonDB();
  } else {
    await initLocalDB();
  }
}

// ============ 统一数据库操作 ============

async function dbRun(sql, params = []) {
  if (IS_VERCEL) {
    // PostgreSQL: 用 $1 $2 占位符
    return neonPool.query(sql, params);
  } else {
    // SQLite: 手动替换 ? 占位符为值
    let finalSql = sql;
    let paramIdx = 0;
    finalSql = finalSql.replace(/\?/g, () => {
      const v = params[paramIdx++];
      if (v === null || v === undefined) return 'NULL';
      if (typeof v === 'number') return String(v);
      return "'" + String(v).replace(/'/g, "''") + "'";
    });
    return db.exec(finalSql);
  }
}

async function dbQuery(sql, params = []) {
  if (IS_VERCEL) {
    const result = await neonPool.query(sql, params);
    return result.rows || [];
  } else {
    const data = db.exec(sql.replace(/\$(\d+)/g, (m, i) => {
      const v = params[parseInt(i) - 1];
      if (v === null || v === undefined) return 'NULL';
      if (typeof v === 'number') return String(v);
      return "'" + String(v).replace(/'/g, "''") + "'";
    }));
    if (!data.length || !data[0].values) return [];
    const columns = data[0].columns;
    return data[0].values.map(v => {
      const obj = {};
      columns.forEach((c, i) => obj[c] = v[i]);
      return obj;
    });
  }
}

// ============ 基础中间件 ============

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============ API 接口 ============

// 1. 生成 token（批量）
app.post('/api/generate-tokens', async (req, res) => {
  try {
    const { count = 500 } = req.body;
    const num = Math.min(Math.max(parseInt(count) || 500, 1), 10000);
    const tokens = [];
    for (let i = 0; i < num; i++) {
      tokens.push(uuidv4().replace(/-/g, '').substring(0, 16));
    }

    if (IS_VERCEL) {
      // PostgreSQL 批量插入
      const values = tokens.map((_, i) => `($${i + 1})`).join(',');
      await neonPool.query(
        `INSERT INTO tokens (token) VALUES ${values}`,
        tokens
      );
    } else {
      const values = tokens.map(t => `('${t}')`).join(',');
      db.run(`INSERT INTO tokens (token) VALUES ${values}`);
      saveLocalDB();
    }

    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    res.json({ success: true, count: tokens.length, tokens, baseUrl });
  } catch (err) {
    console.error('生成token失败:', err);
    res.json({ success: false, msg: '生成失败: ' + err.message });
  }
});

// 2. 查询 token 列表
app.get('/api/tokens', async (req, res) => {
  try {
    const { status } = req.query;
    let rows;
    if (IS_VERCEL) {
      let sql = 'SELECT * FROM tokens ORDER BY created_at DESC';
      if (status === 'used') sql = 'SELECT * FROM tokens WHERE used=1 ORDER BY used_at DESC';
      else if (status === 'unused') sql = 'SELECT * FROM tokens WHERE used=0 ORDER BY created_at ASC';
      const result = await neonPool.query(sql);
      rows = result.rows;
    } else {
      let sql = 'SELECT * FROM tokens ORDER BY created_at DESC';
      if (status === 'used') sql = 'SELECT * FROM tokens WHERE used=1 ORDER BY used_at DESC';
      else if (status === 'unused') sql = 'SELECT * FROM tokens WHERE used=0 ORDER BY created_at ASC';
      rows = await dbQuery(sql);
    }
    res.json({ success: true, count: rows.length, data: rows });
  } catch (err) {
    console.error('查询tokens失败:', err);
    res.json({ success: true, count: 0, data: [] });
  }
});

// 3. 导出链接
app.get('/api/export-links', async (req, res) => {
  try {
    let rows;
    if (IS_VERCEL) {
      const result = await neonPool.query('SELECT token FROM tokens WHERE used=0 ORDER BY id ASC');
      rows = result.rows;
    } else {
      rows = await dbQuery('SELECT token FROM tokens WHERE used=0 ORDER BY id ASC');
    }

    if (!rows.length) return res.send('(no unused links)');

    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    const links = rows.map(r => `${baseUrl}/register?token=${r.token}`).join('\n');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent('报名链接.txt'));
    res.send(links);
  } catch (err) {
    console.error('导出链接失败:', err);
    res.status(500).send('导出失败');
  }
});

// 4. 导出 CSV
app.get('/api/export-csv', async (req, res) => {
  try {
    let rows;
    if (IS_VERCEL) {
      const result = await neonPool.query(`
        SELECT r.id, r.event_type, r.phone, r.emergency_name, r.emergency_phone,
               r.nationality, r.address, r.participants, r.created_at, t.used_at
        FROM registrations r JOIN tokens t ON r.token = t.token ORDER BY r.id ASC
      `);
      rows = result.rows;
    } else {
      rows = await dbQuery(`
        SELECT r.id, r.event_type, r.phone, r.emergency_name, r.emergency_phone,
               r.nationality, r.address, r.participants, r.created_at, t.used_at
        FROM registrations r JOIN tokens t ON r.token = t.token ORDER BY r.id ASC
      `);
      // SQLite 的 participants 是字符串，需要解析
      rows.forEach(r => {
        if (typeof r.participants === 'string') {
          try { r.participants = JSON.parse(r.participants); } catch (_) {}
        }
      });
    }

    const header = '\uFEFF序号,活动类型,姓名,性别,出生年月,国籍,身份证号,手机号,紧急联络人姓名,紧急联络人手机号,服装尺寸,地址,报名时间,链接使用时间';

    if (!rows.length) {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8-sig');
      res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent('报名数据.csv'));
      return res.send(header);
    }

    const body = rows.map(r => {
      const p = Array.isArray(r.participants) ? r.participants : [];
      const eventName = r.event_type === 'blue_fire' ? '蓝焰青春挑战赛' : '平安小卫士亲子赛';
      return [
        r.id, eventName,
        p.map(x => x.name || '').filter(Boolean).join('; '),
        p.map(x => x.gender || '').filter(Boolean).join('; '),
        p.map(x => x.birth || '').filter(Boolean).join('; '),
        r.nationality,
        p.map(x => x.id_card || '').filter(Boolean).join('; '),
        r.phone, r.emergency_name, r.emergency_phone,
        p.map(x => x.clothing_size || '').filter(Boolean).join('; '),
        r.address, r.created_at, r.used_at
      ].map(x => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',');
    }).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8-sig');
    res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent('报名数据.csv'));
    res.send(header + '\n' + body);
  } catch (err) {
    console.error('导出CSV失败:', err);
    res.status(500).send('导出失败');
  }
});

// 5. 统计数据
app.get('/api/stats', async (req, res) => {
  try {
    let t, u, r;
    if (IS_VERCEL) {
      const tResult = await neonPool.query('SELECT COUNT(*) as total FROM tokens');
      const uResult = await neonPool.query('SELECT COUNT(*) as used FROM tokens WHERE used=1');
      const rResult = await neonPool.query('SELECT COUNT(*) as reg FROM registrations');
      t = parseInt(tResult.rows[0].total);
      u = parseInt(uResult.rows[0].used);
      r = parseInt(rResult.rows[0].reg);
    } else {
      const tData = db.exec('SELECT COUNT(*) as total FROM tokens');
      const uData = db.exec('SELECT COUNT(*) as used FROM tokens WHERE used=1');
      const rData = db.exec('SELECT COUNT(*) as reg FROM registrations');
      t = tData.length ? tData[0].values[0][0] : 0;
      u = uData.length ? uData[0].values[0][0] : 0;
      r = rData.length ? rData[0].values[0][0] : 0;
    }
    res.json({ success: true, total: t, used: u, unused: t - u, registrations: r });
  } catch (err) {
    console.error('统计失败:', err);
    res.json({ success: true, total: 0, used: 0, unused: 0, registrations: 0 });
  }
});

// 6. 报名数据列表
app.get('/api/registrations', async (req, res) => {
  try {
    let rows;
    if (IS_VERCEL) {
      const result = await neonPool.query(`
        SELECT r.*, t.used_at FROM registrations r JOIN tokens t ON r.token = t.token ORDER BY r.id DESC
      `);
      rows = result.rows;
    } else {
      rows = await dbQuery(`
        SELECT r.*, t.used_at FROM registrations r JOIN tokens t ON r.token = t.token ORDER BY r.id DESC
      `);
      rows.forEach(r => {
        if (typeof r.participants === 'string') {
          try { r.participants = JSON.parse(r.participants); } catch (_) {}
        }
      });
    }
    res.json({ success: true, count: rows.length, data: rows });
  } catch (err) {
    console.error('查询报名数据失败:', err);
    res.json({ success: true, count: 0, data: [] });
  }
});

// 7. 验证 token
app.get('/api/validate-token', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.json({ valid: false, reason: 'missing' });

    let row;
    if (IS_VERCEL) {
      const result = await neonPool.query('SELECT used FROM tokens WHERE token = $1', [token]);
      row = result.rows[0];
    } else {
      const safeToken = token.replace(/'/g, "''");
      const data = db.exec(`SELECT used FROM tokens WHERE token = '${safeToken}'`);
      row = data.length && data[0].values.length ? { used: data[0].values[0][0] } : null;
    }

    if (!row) return res.json({ valid: false, reason: 'invalid' });
    if (row.used) return res.json({ valid: false, reason: 'used' });
    res.json({ valid: true });
  } catch (err) {
    console.error('验证token失败:', err);
    res.json({ valid: false, reason: 'error' });
  }
});

// 8. 删除 token
app.delete('/api/tokens/:token', async (req, res) => {
  try {
    const { token } = req.params;
    let exists;
    if (IS_VERCEL) {
      const result = await neonPool.query('SELECT used FROM tokens WHERE token = $1', [token]);
      exists = result.rows[0];
    } else {
      const safeToken = token.replace(/'/g, "''");
      const data = db.exec(`SELECT used FROM tokens WHERE token = '${safeToken}'`);
      exists = data.length && data[0].values.length ? { used: data[0].values[0][0] } : null;
    }

    if (!exists) return res.json({ success: false, msg: 'token不存在' });

    if (IS_VERCEL) {
      if (exists.used) await neonPool.query('DELETE FROM registrations WHERE token = $1', [token]);
      await neonPool.query('DELETE FROM tokens WHERE token = $1', [token]);
    } else {
      const safeToken = token.replace(/'/g, "''");
      if (exists.used) db.run(`DELETE FROM registrations WHERE token = '${safeToken}'`);
      db.run(`DELETE FROM tokens WHERE token = '${safeToken}'`);
      saveLocalDB();
    }
    res.json({ success: true, msg: '删除成功' });
  } catch (err) {
    console.error('删除token失败:', err);
    res.json({ success: false, msg: '删除失败' });
  }
});

// 9. 清理已用 token
app.delete('/api/tokens-clean', async (req, res) => {
  try {
    if (IS_VERCEL) {
      await neonPool.query('DELETE FROM registrations');
      await neonPool.query('DELETE FROM tokens WHERE used=1');
    } else {
      db.run('DELETE FROM registrations');
      db.run('DELETE FROM tokens WHERE used=1');
      saveLocalDB();
    }
    res.json({ success: true });
  } catch (err) {
    console.error('清理失败:', err);
    res.json({ success: false, msg: '清理失败' });
  }
});

// 10. 清空所有 token 和报名数据
app.delete('/api/tokens-clear-all', async (req, res) => {
  try {
    if (IS_VERCEL) {
      await neonPool.query('DELETE FROM registrations');
      await neonPool.query('DELETE FROM tokens');
    } else {
      db.run('DELETE FROM registrations');
      db.run('DELETE FROM tokens');
      saveLocalDB();
    }
    res.json({ success: true, msg: '已清空所有链接和报名数据' });
  } catch (err) {
    console.error('清空失败:', err);
    res.json({ success: false, msg: '清空失败' });
  }
});

// ============ 页面路由 ============

app.get('/', (req, res) => res.redirect('/admin'));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));

// ============ 提交报名 ============

app.post('/api/submit', async (req, res) => {
  try {
    const {
      token, event_type,
      phone, emergency_name, emergency_phone, nationality, address,
      participants
    } = req.body;

    if (!token || !event_type || !phone || !emergency_name || !emergency_phone || !nationality || !address) {
      return res.json({ success: false, msg: '请填写所有必填项' });
    }

    // 验证 token
    let tokenRow;
    if (IS_VERCEL) {
      const result = await neonPool.query('SELECT used FROM tokens WHERE token = $1', [token]);
      tokenRow = result.rows[0];
    } else {
      const safeToken = token.replace(/'/g, "''");
      const data = db.exec(`SELECT used FROM tokens WHERE token = '${safeToken}'`);
      tokenRow = data.length && data[0].values.length ? { used: data[0].values[0][0] } : null;
    }

    if (!tokenRow) return res.json({ success: false, msg: '链接无效' });
    if (tokenRow.used) return res.json({ success: false, msg: '该链接已使用过，无法重复报名' });

    if (IS_VERCEL) {
      // PostgreSQL: 参数化查询，防注入
      const pJson = JSON.stringify(participants);
      await neonPool.query(
        `INSERT INTO registrations (token, event_type, phone, emergency_name, emergency_phone, nationality, address, participants)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [token, event_type, phone, emergency_name, emergency_phone, nationality, address, pJson]
      );
      await neonPool.query('UPDATE tokens SET used=1, used_at=NOW() WHERE token=$1', [token]);
    } else {
      const safeToken = token.replace(/'/g, "''");
      const pJson = JSON.stringify(participants).replace(/'/g, "''");
      const safeEventType = event_type.replace(/'/g, "''");
      const safePhone = phone.replace(/'/g, "''");
      const safeEmName = emergency_name.replace(/'/g, "''");
      const safeEmPhone = emergency_phone.replace(/'/g, "''");
      const safeNat = nationality.replace(/'/g, "''");
      const safeAddr = address.replace(/'/g, "''");

      db.run(`INSERT INTO registrations (token, event_type, phone, emergency_name, emergency_phone, nationality, address, participants, created_at)
        VALUES ('${safeToken}', '${safeEventType}', '${safePhone}', '${safeEmName}', '${safeEmPhone}', '${safeNat}', '${safeAddr}', '${pJson}', datetime('now', '+8 hours'))`);
      db.run(`UPDATE tokens SET used=1, used_at=datetime('now', '+8 hours') WHERE token='${safeToken}'`);
      saveLocalDB();
    }

    res.json({ success: true, msg: '报名成功！' });
  } catch (err) {
    console.error('提交报名失败:', err);
    res.json({ success: false, msg: '提交失败：' + err.message });
  }
});

// ============ 启动 ============

if (!IS_VERCEL) {
  // 本地启动
  initDB().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
      console.log('');
      console.log('========================================');
      console.log('  赛事报名系统已启动（本地模式）');
      console.log(`  管理后台：${baseUrl}/admin`);
      console.log(`  报名入口：${baseUrl}/register?token=xxx`);
      console.log('========================================');
      console.log('');
    });
  }).catch(err => {
    console.error('启动失败:', err);
    process.exit(1);
  });
} else {
  // Vercel 模式：初始化数据库
  initDB().catch(err => console.error('Neon初始化失败:', err));
}

module.exports = app;
