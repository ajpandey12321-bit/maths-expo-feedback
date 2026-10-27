'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { Pool } = require('pg');

const requiredEnv = ['DATABASE_URL', 'COOKIE_SECRET', 'ADMIN_USERNAME', 'ADMIN_PASSWORD'];
const missingEnv = requiredEnv.filter((name) => !process.env[name] || process.env[name].startsWith('replace-'));
if (missingEnv.length) {
  console.error(`Missing required environment variables: ${missingEnv.join(', ')}. Copy .env.example and set the values in your hosting dashboard.`);
  process.exit(1);
}
if (process.env.COOKIE_SECRET.length < 32) {
  console.error('COOKIE_SECRET must be at least 32 characters long.');
  process.exit(1);
}

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const COOKIE_SECRET = process.env.COOKIE_SECRET;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SCHOOL_NAME = process.env.SCHOOL_NAME || 'YOUR SCHOOL NAME';
const EXHIBITION_NAME = process.env.EXHIBITION_NAME || 'MATHEMATICS EXHIBITION';
const PORT = Number(process.env.PORT || 3000);

// Supabase's session pooler works for a long-running Node service. SSL is required.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});
pool.on('error', (err) => console.error('Unexpected database pool error:', err.message));

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: isProduction ? '1h' : 0 }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait 15 minutes and try again.' }
});

function parseCookies(req) {
  const result = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try { result[key] = decodeURIComponent(value); } catch { result[key] = value; }
  }
  return result;
}

function hmac(value) {
  return crypto.createHmac('sha256', COOKIE_SECRET).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function setCookie(res, name, value, maxAgeSeconds) {
  const flags = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (isProduction) flags.push('Secure');
  res.append('Set-Cookie', flags.join('; '));
}

function clearCookie(res, name) {
  const flags = [`${name}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'];
  if (isProduction) flags.push('Secure');
  res.append('Set-Cookie', flags.join('; '));
}

function createSignedToken(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${hmac(encoded)}`;
}

function readSignedToken(value) {
  if (!value || typeof value !== 'string') return null;
  const dot = value.lastIndexOf('.');
  if (dot < 1) return null;
  const encoded = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  if (!safeEqual(signature, hmac(encoded))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload || !Number.isFinite(payload.exp) || payload.exp <= Date.now()) return null;
    return payload;
  } catch { return null; }
}

function getDeviceId(req, res) {
  const cookies = parseCookies(req);
  const token = readSignedToken(cookies.expo_device);
  if (token && typeof token.id === 'string' && token.id.length >= 20) return token.id;
  const id = crypto.randomBytes(32).toString('base64url');
  const signed = createSignedToken({ id, exp: Date.now() + 365 * 24 * 60 * 60 * 1000 });
  setCookie(res, 'expo_device', signed, 365 * 24 * 60 * 60);
  return id;
}

function requireAdmin(req, res, next) {
  const token = readSignedToken(parseCookies(req).expo_admin);
  if (!token || token.role !== 'admin' || token.username !== ADMIN_USERNAME) {
    return res.status(401).json({ error: 'Please sign in as the organiser.' });
  }
  req.admin = token;
  next();
}

function hashDeviceId(id) {
  return crypto.createHash('sha256').update(id).digest('hex');
}

function validText(value, maxLength = 500) {
  return typeof value === 'string' && value.trim().length <= maxLength;
}

function csvCell(value) {
  const str = value === null || value === undefined ? '' : String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('select 1');
    res.json({ ok: true, database: 'connected' });
  } catch (error) {
    console.error('Health check database error:', error.message);
    res.status(503).json({ ok: false, database: 'unavailable' });
  }
});

app.get('/api/config', (_req, res) => {
  res.json({ schoolName: SCHOOL_NAME, exhibitionName: EXHIBITION_NAME });
});

// A visitor receives a random, signed, HttpOnly device cookie. No personal data is collected.
app.get('/api/visitor/session', (req, res) => {
  getDeviceId(req, res);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true });
});

app.get('/api/stalls', async (_req, res) => {
  try {
    const result = await pool.query(
      'select id, stall_number, name, tagline from public.stalls where active = true order by stall_number'
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json({ stalls: result.rows });
  } catch (error) {
    console.error('List stalls failed:', error.message);
    res.status(500).json({ error: 'Could not load stalls. Please try again.' });
  }
});

app.get('/api/stalls/:id', async (req, res) => {
  const stallId = Number(req.params.id);
  if (!Number.isSafeInteger(stallId) || stallId < 1) return res.status(400).json({ error: 'Invalid stall number.' });
  try {
    const stallResult = await pool.query(
      'select id, stall_number, name, tagline from public.stalls where id = $1 and active = true', [stallId]
    );
    if (!stallResult.rowCount) return res.status(404).json({ error: 'This stall was not found or is not active.' });
    const questionResult = await pool.query(
      `select id, question_text, question_type, options, required, is_overall, sort_order
       from public.questions where stall_id = $1 and active = true order by sort_order, id`, [stallId]
    );
    const deviceId = getDeviceId(req, res);
    const duplicate = await pool.query(
      'select 1 from public.reviews where stall_id = $1 and device_hash = $2 limit 1',
      [stallId, hashDeviceId(deviceId)]
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json({ stall: stallResult.rows[0], questions: questionResult.rows, alreadyReviewed: duplicate.rowCount > 0 });
  } catch (error) {
    console.error('Load stall failed:', error.message);
    res.status(500).json({ error: 'Could not load this stall. Please try again.' });
  }
});

app.post('/api/reviews/:id', async (req, res) => {
  const stallId = Number(req.params.id);
  if (!Number.isSafeInteger(stallId) || stallId < 1) return res.status(400).json({ error: 'Invalid stall.' });
  const answers = req.body && req.body.answers;
  const reviewText = req.body && req.body.reviewText !== undefined ? req.body.reviewText : '';
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return res.status(400).json({ error: 'Please answer the questions first.' });
  if (!validText(reviewText, 1500)) return res.status(400).json({ error: 'Please keep the written feedback under 1,500 characters.' });
  try {
    const stallResult = await pool.query('select id from public.stalls where id = $1 and active = true', [stallId]);
    if (!stallResult.rowCount) return res.status(404).json({ error: 'This stall is not active.' });
    const questionResult = await pool.query(
      `select id, question_text, question_type, options, required, is_overall
       from public.questions where stall_id = $1 and active = true order by sort_order, id`, [stallId]
    );
    const questions = questionResult.rows;
    const validAnswerIds = new Set(questions.map((q) => String(q.id)));
    for (const key of Object.keys(answers)) { if (!validAnswerIds.has(key)) delete answers[key]; }
    const overallQuestion = questions.find((q) => q.is_overall);
    if (!overallQuestion) return res.status(500).json({ error: 'This stall has no overall rating question. Please contact the organiser.' });

    for (const question of questions) {
      const value = answers[String(question.id)];
      const isBlank = value === undefined || value === null || String(value).trim() === '';
      if (question.required && isBlank) return res.status(400).json({ error: `Please answer: ${question.question_text}` });
      if (isBlank) continue;
      if (question.question_type === 'choice') {
        if (!Array.isArray(question.options) || !question.options.includes(value)) {
          return res.status(400).json({ error: `Choose a valid answer for: ${question.question_text}` });
        }
      } else if (question.question_type === 'rating') {
        if (![1, 2, 3, 4, 5].includes(Number(value))) return res.status(400).json({ error: `Give a rating from 1 to 5 for: ${question.question_text}` });
        answers[String(question.id)] = Number(value);
      } else if (question.question_type === 'text') {
        if (!validText(String(value), 500)) return res.status(400).json({ error: `Keep your answer under 500 characters for: ${question.question_text}` });
        answers[String(question.id)] = String(value).trim();
      }
    }

    const rawOverall = answers[String(overallQuestion.id)];
    const scores = { 'Excellent': 4, 'Good': 3, 'Average': 2, 'Needs Improvement': 1 };
    const overallRating = scores[rawOverall];
    if (!overallRating) return res.status(400).json({ error: 'Please select an overall rating.' });

    const deviceId = getDeviceId(req, res);
    const deviceHash = hashDeviceId(deviceId);
    const insert = await pool.query(
      `insert into public.reviews (stall_id, device_hash, overall_rating, answers, review_text)
       values ($1, $2, $3, $4::jsonb, $5)
       on conflict (stall_id, device_hash) do nothing
       returning id, created_at`,
      [stallId, deviceHash, overallRating, JSON.stringify(answers), String(reviewText).trim()]
    );
    res.setHeader('Cache-Control', 'no-store');
    if (!insert.rowCount) return res.status(409).json({ alreadyReviewed: true, error: 'This device has already reviewed this stall.' });
    res.status(201).json({ ok: true, message: 'Your feedback has been submitted. Thank you!' });
  } catch (error) {
    console.error('Submit review failed:', error.message);
    res.status(500).json({ error: 'We could not save your feedback. Please check the connection and try again.' });
  }
});

app.post('/api/admin/login', loginLimiter, (req, res) => {
  const username = String((req.body && req.body.username) || '');
  const password = String((req.body && req.body.password) || '');
  if (!safeEqual(username, ADMIN_USERNAME) || !safeEqual(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Incorrect organiser username or password.' });
  }
  const token = createSignedToken({ role: 'admin', username: ADMIN_USERNAME, exp: Date.now() + 12 * 60 * 60 * 1000 });
  setCookie(res, 'expo_admin', token, 12 * 60 * 60);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (_req, res) => {
  clearCookie(res, 'expo_admin');
  res.json({ ok: true });
});

app.get('/api/admin/me', (req, res) => {
  const token = readSignedToken(parseCookies(req).expo_admin);
  res.json({ loggedIn: Boolean(token && token.role === 'admin' && token.username === ADMIN_USERNAME) });
});

app.get('/api/admin/stalls', requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(
      `select s.id, s.stall_number, s.name, s.tagline, s.active, s.created_at,
              count(r.id)::int as review_count,
              round(avg(r.overall_rating)::numeric, 2) as average_score
       from public.stalls s left join public.reviews r on r.stall_id = s.id
       group by s.id order by s.stall_number`
    );
    res.json({ stalls: result.rows });
  } catch (error) {
    console.error('Admin stalls failed:', error.message);
    res.status(500).json({ error: 'Could not load stall management data.' });
  }
});

app.post('/api/admin/stalls', requireAdmin, async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  const tagline = String((req.body && req.body.tagline) || '').trim();
  if (!name || name.length > 120) return res.status(400).json({ error: 'Enter a stall/project name of up to 120 characters.' });
  if (tagline.length > 240) return res.status(400).json({ error: 'Tagline must be 240 characters or fewer.' });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('lock table public.stalls in exclusive mode');
    const maxResult = await client.query('select coalesce(max(stall_number), 0) + 1 as next_number from public.stalls');
    const stallNumber = Number(maxResult.rows[0].next_number);
    const result = await client.query(
      'insert into public.stalls (stall_number, name, tagline) values ($1, $2, $3) returning id, stall_number, name, tagline, active',
      [stallNumber, name, tagline]
    );
    const stall = result.rows[0];
    await client.query(
      `insert into public.questions (stall_id, question_text, question_type, options, required, is_overall, sort_order)
       values ($1, 'How would you rate this stall?', 'choice', $2::jsonb, true, true, 1)`,
      [stall.id, JSON.stringify(['Excellent', 'Good', 'Average', 'Needs Improvement'])]
    );
    await client.query('commit');
    res.status(201).json({ stall });
  } catch (error) {
    await client.query('rollback');
    console.error('Create stall failed:', error.message);
    res.status(500).json({ error: 'Could not add the stall.' });
  } finally { client.release(); }
});

app.put('/api/admin/stalls/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const name = String((req.body && req.body.name) || '').trim();
  const tagline = String((req.body && req.body.tagline) || '').trim();
  const active = Boolean(req.body && req.body.active);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid stall.' });
  if (!name || name.length > 120) return res.status(400).json({ error: 'Enter a project name of up to 120 characters.' });
  if (tagline.length > 240) return res.status(400).json({ error: 'Tagline must be 240 characters or fewer.' });
  try {
    const result = await pool.query(
      'update public.stalls set name = $1, tagline = $2, active = $3 where id = $4 returning id, stall_number, name, tagline, active',
      [name, tagline, active, id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Stall not found.' });
    res.json({ stall: result.rows[0] });
  } catch (error) {
    console.error('Update stall failed:', error.message);
    res.status(500).json({ error: 'Could not update this stall.' });
  }
});

app.get('/api/admin/questions/:stallId', requireAdmin, async (req, res) => {
  const stallId = Number(req.params.stallId);
  if (!Number.isSafeInteger(stallId) || stallId < 1) return res.status(400).json({ error: 'Invalid stall.' });
  try {
    const result = await pool.query(
      `select id, stall_id, question_text, question_type, options, required, is_overall, sort_order, active
       from public.questions where stall_id = $1 order by sort_order, id`, [stallId]
    );
    res.json({ questions: result.rows });
  } catch (error) {
    console.error('Questions load failed:', error.message);
    res.status(500).json({ error: 'Could not load questions.' });
  }
});

app.post('/api/admin/questions/:stallId', requireAdmin, async (req, res) => {
  const stallId = Number(req.params.stallId);
  const questionText = String((req.body && req.body.questionText) || '').trim();
  const questionType = String((req.body && req.body.questionType) || 'choice');
  const required = Boolean(req.body && req.body.required);
  const optionsRaw = req.body && req.body.options;
  const options = Array.isArray(optionsRaw) ? optionsRaw.map((x) => String(x).trim()).filter(Boolean).slice(0, 12) : [];
  if (!Number.isSafeInteger(stallId) || stallId < 1) return res.status(400).json({ error: 'Invalid stall.' });
  if (!questionText || questionText.length > 240) return res.status(400).json({ error: 'Question must be 1–240 characters.' });
  if (!['choice', 'text', 'rating'].includes(questionType)) return res.status(400).json({ error: 'Choose a valid question type.' });
  if (questionType === 'choice' && (options.length < 2 || options.some((o) => o.length > 80))) return res.status(400).json({ error: 'Choice questions need 2–12 options, each no longer than 80 characters.' });
  if (questionType !== 'choice' && options.length) return res.status(400).json({ error: 'Only choice questions use options.' });
  try {
    const stallCheck = await pool.query('select id from public.stalls where id = $1', [stallId]);
    if (!stallCheck.rowCount) return res.status(404).json({ error: 'Stall not found.' });
    const maxOrder = await pool.query('select coalesce(max(sort_order), 0) + 1 as next_order from public.questions where stall_id = $1', [stallId]);
    const result = await pool.query(
      `insert into public.questions (stall_id, question_text, question_type, options, required, is_overall, sort_order)
       values ($1, $2, $3, $4::jsonb, $5, false, $6)
       returning id, stall_id, question_text, question_type, options, required, is_overall, sort_order, active`,
      [stallId, questionText, questionType, JSON.stringify(options), required, Number(maxOrder.rows[0].next_order)]
    );
    res.status(201).json({ question: result.rows[0] });
  } catch (error) {
    console.error('Create question failed:', error.message);
    res.status(500).json({ error: 'Could not add this question.' });
  }
});

app.put('/api/admin/questions/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const questionText = String((req.body && req.body.questionText) || '').trim();
  const options = Array.isArray(req.body && req.body.options) ? req.body.options.map((x) => String(x).trim()).filter(Boolean).slice(0, 12) : [];
  const required = Boolean(req.body && req.body.required);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid question.' });
  if (!questionText || questionText.length > 240) return res.status(400).json({ error: 'Question must be 1–240 characters.' });
  try {
    const existing = await pool.query('select question_type, is_overall from public.questions where id = $1', [id]);
    if (!existing.rowCount) return res.status(404).json({ error: 'Question not found.' });
    const questionType = existing.rows[0].question_type;
    if (questionType === 'choice' && (options.length < 2 || options.some((o) => o.length > 80))) return res.status(400).json({ error: 'Choice questions need 2–12 options, each no longer than 80 characters.' });
    if (existing.rows[0].is_overall && JSON.stringify(options) !== JSON.stringify(['Excellent', 'Good', 'Average', 'Needs Improvement'])) {
      return res.status(400).json({ error: 'The built-in overall rating options cannot be changed because they drive the rating summary.' });
    }
    const result = await pool.query(
      `update public.questions set question_text = $1, options = $2::jsonb, required = $3
       where id = $4 returning id, stall_id, question_text, question_type, options, required, is_overall, sort_order, active`,
      [questionText, JSON.stringify(options), required, id]
    );
    res.json({ question: result.rows[0] });
  } catch (error) {
    console.error('Update question failed:', error.message);
    res.status(500).json({ error: 'Could not update this question.' });
  }
});

app.delete('/api/admin/questions/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid question.' });
  try {
    const found = await pool.query('select is_overall from public.questions where id = $1', [id]);
    if (!found.rowCount) return res.status(404).json({ error: 'Question not found.' });
    if (found.rows[0].is_overall) return res.status(400).json({ error: 'The required overall rating question cannot be deleted.' });
    await pool.query('delete from public.questions where id = $1', [id]);
    res.json({ ok: true });
  } catch (error) {
    console.error('Delete question failed:', error.message);
    res.status(500).json({ error: 'Could not delete the question.' });
  }
});

app.get('/api/admin/summary', requireAdmin, async (_req, res) => {
  try {
    const summary = await pool.query(
      `select count(*)::int as review_count,
              round(avg(overall_rating)::numeric, 2) as average_score,
              count(*) filter (where overall_rating = 4)::int as excellent_count,
              count(*) filter (where overall_rating = 3)::int as good_count,
              count(*) filter (where overall_rating = 2)::int as average_count,
              count(*) filter (where overall_rating = 1)::int as needs_improvement_count,
              count(distinct stall_id)::int as stalls_reviewed
       from public.reviews`
    );
    res.json({ summary: summary.rows[0] });
  } catch (error) {
    console.error('Summary failed:', error.message);
    res.status(500).json({ error: 'Could not load summary.' });
  }
});

app.get('/api/admin/reviews', requireAdmin, async (req, res) => {
  const stallId = req.query.stallId && req.query.stallId !== 'all' ? Number(req.query.stallId) : null;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  if (stallId !== null && (!Number.isSafeInteger(stallId) || stallId < 1)) return res.status(400).json({ error: 'Invalid stall.' });
  try {
    const filter = stallId === null ? '' : 'where r.stall_id = $1';
    const params = stallId === null ? [] : [stallId];
    const count = await pool.query(`select count(*)::int as total from public.reviews r ${filter}`, params);
    const pageParams = stallId === null ? [limit, offset] : [stallId, limit, offset];
    const limIdx = stallId === null ? '$1' : '$2';
    const offIdx = stallId === null ? '$2' : '$3';
    const rows = await pool.query(
      `select r.id, r.stall_id, s.stall_number, s.name as stall_name, r.overall_rating,
              r.answers,
              coalesce((select jsonb_object_agg(q.question_text, r.answers -> q.id::text)
                        from public.questions q where q.stall_id = r.stall_id and r.answers ? q.id::text), '{}'::jsonb) as answer_labels,
              r.review_text, r.created_at
       from public.reviews r join public.stalls s on s.id = r.stall_id
       ${filter} order by r.created_at desc limit ${limIdx} offset ${offIdx}`,
      pageParams
    );
    res.json({ reviews: rows.rows, total: count.rows[0].total, limit, offset });
  } catch (error) {
    console.error('Review list failed:', error.message);
    res.status(500).json({ error: 'Could not load feedback.' });
  }
});

async function fetchExportRows(stallId) {
  const values = [];
  const condition = stallId === null ? '' : 'where r.stall_id = $1';
  if (stallId !== null) values.push(stallId);
  const result = await pool.query(
    `select r.id, s.stall_number, s.name as stall_name, r.overall_rating,
            r.answers,
            coalesce((select jsonb_object_agg(q.question_text, r.answers -> q.id::text)
                      from public.questions q where q.stall_id = r.stall_id and r.answers ? q.id::text), '{}'::jsonb) as answer_labels,
            r.review_text, r.created_at
     from public.reviews r join public.stalls s on s.id = r.stall_id
     ${condition} order by r.created_at desc`, values
  );
  return result.rows;
}

app.get('/api/admin/export.csv', requireAdmin, async (req, res) => {
  const stallId = req.query.stallId && req.query.stallId !== 'all' ? Number(req.query.stallId) : null;
  if (stallId !== null && (!Number.isSafeInteger(stallId) || stallId < 1)) return res.status(400).send('Invalid stall.');
  try {
    const rows = await fetchExportRows(stallId);
    const header = ['Review ID', 'Stall Number', 'Stall Name', 'Overall Rating', 'Question Answers', 'Written Feedback', 'Submitted At'];
    const body = rows.map((r) => [
      r.id, r.stall_number, r.stall_name,
      ({ 4: 'Excellent', 3: 'Good', 2: 'Average', 1: 'Needs Improvement' })[r.overall_rating] || '',
      JSON.stringify(r.answer_labels || r.answers), r.review_text, new Date(r.created_at).toISOString()
    ].map(csvCell).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="maths-expo-feedback-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\ufeff' + [header.map(csvCell).join(','), ...body].join('\r\n'));
  } catch (error) {
    console.error('CSV export failed:', error.message);
    res.status(500).send('Could not export feedback.');
  }
});

app.get('/api/admin/export.html', requireAdmin, async (req, res) => {
  const stallId = req.query.stallId && req.query.stallId !== 'all' ? Number(req.query.stallId) : null;
  if (stallId !== null && (!Number.isSafeInteger(stallId) || stallId < 1)) return res.status(400).send('Invalid stall.');
  try {
    const rows = await fetchExportRows(stallId);
    const tableRows = rows.map((r) => {
      const rating = ({ 4: 'Excellent', 3: 'Good', 2: 'Average', 1: 'Needs Improvement' })[r.overall_rating] || '';
      const answers = Object.entries(r.answer_labels || r.answers || {}).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' | ');
      return `<tr><td>${htmlEscape(r.stall_number)}</td><td>${htmlEscape(r.stall_name)}</td><td>${htmlEscape(rating)}</td><td>${htmlEscape(answers)}</td><td>${htmlEscape(r.review_text)}</td><td>${htmlEscape(new Date(r.created_at).toLocaleString('en-IN'))}</td></tr>`;
    }).join('\n');
    const document = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Maths Exhibition Feedback Export</title><style>body{font:14px Arial,sans-serif;color:#182b42;margin:24px}h1{margin-bottom:4px}p{color:#53677e}table{border-collapse:collapse;width:100%;margin-top:20px}th,td{border:1px solid #ccd7e2;padding:9px;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#edf4fb}tr:nth-child(even){background:#f8fafc}@media print{body{margin:6mm}th,td{font-size:10px;padding:5px}}</style></head><body><h1>${htmlEscape(EXHIBITION_NAME)} — Feedback Export</h1><p>${htmlEscape(SCHOOL_NAME)} · ${rows.length} feedback entries · Exported ${htmlEscape(new Date().toLocaleString('en-IN'))}</p><table><thead><tr><th>Stall</th><th>Project</th><th>Overall rating</th><th>Question answers</th><th>Written feedback</th><th>Submitted at</th></tr></thead><tbody>${tableRows || '<tr><td colspan="6">No feedback available.</td></tr>'}</tbody></table></body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="maths-expo-feedback-${new Date().toISOString().slice(0, 10)}.html"`);
    res.send(document);
  } catch (error) {
    console.error('HTML export failed:', error.message);
    res.status(500).send('Could not export feedback.');
  }
});

app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/qr-codes', (_req, res) => res.redirect('/admin#qr'));
app.get('/stall/:id', (req, res) => res.redirect(`/?stall=${encodeURIComponent(req.params.id)}`));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'That endpoint was not found.' });
  res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log(`Maths Exhibition Feedback System listening on port ${PORT}`);
});

async function shutdown() {
  console.log('Shutting down...');
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
