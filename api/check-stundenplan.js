// api/check-stundenplan.js
// Production version mit HTTP/2 für APNs

import { kv } from '@vercel/kv';
import jwt from 'jsonwebtoken';
import http2 from 'http2';
import crypto from 'crypto';

const CONFIG = {
  BKB_BASE_URL: 'https://stundenplan.bkb.nrw',
  MAPPING_URL: 'https://raw.githubusercontent.com/efecandemircan9-hub/BKBMapping/refs/heads/main/mapping.json',
  APNS_HOST: process.env.APNS_ENVIRONMENT === 'sandbox'
    ? 'api.sandbox.push.apple.com'
    : 'api.push.apple.com',
  APNS_TOPIC: 'nrw.bkb',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const startTime = Date.now();
  try {
    console.log('🔍 Starting stundenplan check...');
    const classes = await getRegisteredClasses();
    console.log(`📚 Found ${classes.length} classes`);

    if (classes.length === 0) {
      await saveCheckLog({ status: 'no_classes', duration: Date.now() - startTime });
      return res.status(200).json({ success: true, classes: 0, results: [] });
    }

    const mapping = await (await fetch(CONFIG.MAPPING_URL)).json();
    const results = [];

    for (const className of classes) {
      try {
        results.push(await checkStundenplanForClass(className, mapping));
      } catch (error) {
        console.error(`❌ Error checking ${className}:`, error.message);
        results.push({ className, status: 'error', error: error.message });
      }
    }

    await kv.set('meta:lastCheck', new Date().toISOString());

    const totalChanges = results.filter(r => r.status === 'changes_detected').reduce((s, r) => s + (r.newChanges || 0), 0);
    const totalPushesSent = results.filter(r => r.pushed).length;

    await saveCheckLog({ status: 'completed', duration: Date.now() - startTime, classes: classes.length, results, totalChanges, totalPushesSent });
    return res.status(200).json({ success: true, timestamp: new Date().toISOString(), classes: classes.length, results });

  } catch (error) {
    console.error('❌ Error:', error);
    await saveCheckLog({ status: 'error', error: error.message, duration: Date.now() - startTime });
    return res.status(500).json({ success: false, error: error.message });
  }
}

async function getRegisteredClasses() {
  return (await kv.keys('class:*')).map(k => k.replace('class:', ''));
}

async function checkStundenplanForClass(className, mapping) {
  const slug = mapping[className];
  if (!slug) throw new Error(`No slug found for ${className}`);

  const now = new Date();
  const week = getWeekNumber(now);
  const year = now.getFullYear();

  const response = await fetch(
    `${CONFIG.BKB_BASE_URL}/schueler/${String(week).padStart(2, '0')}/c/${slug}`,
    { headers: { 'Authorization': 'Basic ' + btoa('schueler:stundenplan') } }
  );
  if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);

  const htmlText = await response.text();
  const newHash = hashString(normalizeHTML(htmlText));
  const { cancellations, substitutions, total: newChangeCount } = countChanges(htmlText);

  const cacheKey = `cache:${className}:${year}:w${week}`;
  const cachedRaw = await kv.get(cacheKey);

  if (!cachedRaw) {
    await kv.set(cacheKey, { hash: newHash, changeCount: newChangeCount, updatedAt: new Date().toISOString() });
    console.log(`✅ ${className}: First check – ${cancellations} Ausfälle, ${substitutions} Vertretungen`);
    return { className, status: 'first_check', changeCount: newChangeCount };
  }

  const cached = typeof cachedRaw === 'string' ? JSON.parse(cachedRaw) : cachedRaw;
  const oldChangeCount = cached.changeCount ?? 0;

  console.log(`🔍 ${className}: hash ${cached.hash === newHash ? 'SAME' : 'CHANGED'} | changes ${oldChangeCount}→${newChangeCount} (${cancellations} Ausfälle, ${substitutions} Vertretungen)`);

  if (cached.hash === newHash) {
    return { className, status: 'no_changes' };
  }

  // Cache immer aktualisieren
  await kv.set(cacheKey, { hash: newHash, changeCount: newChangeCount, updatedAt: new Date().toISOString() });

  if (newChangeCount > oldChangeCount) {
    const diff = newChangeCount - oldChangeCount;
    const msg = buildPushMessage(substitutions, cancellations, diff);
    await sendPushToClass(className, diff, msg);
    return { className, status: 'changes_detected', newChanges: diff, cancellations, substitutions, changeCount: `${oldChangeCount}→${newChangeCount}`, pushed: true };
  }

  if (newChangeCount < oldChangeCount) {
    return { className, status: 'changes_cleared', changeCount: `${oldChangeCount}→${newChangeCount}`, pushed: false };
  }

  // Gleiche Anzahl, anderer Hash → Einträge wurden getauscht (z.B. anderer Vertreter)
  await sendPushToClass(className, newChangeCount || 1, 'Stundenplanänderung: Einträge wurden aktualisiert.');
  return { className, status: 'changes_updated', changeCount: newChangeCount, pushed: true };
}

// ============================================================================
// CHANGE DETECTION
//
// Jede Stunde = TD(colspan=12, rowspan=2) > TABLE > TR > 4x TD:
//   TD1: Fach    TD2: Nr-Ref    TD3: Raum    TD4: Lehrer
//
// Änderung erkennbar an roten Font-Tags (color=#FF0000):
//   AUSFALL:    TD1 = "---" (rot)       → Stunde fällt komplett aus
//   VERTRETUNG: TD1 = Fachname (rot)    → Lehrer/Raum geändert, Stunde findet statt
//
// Freistunden (leere TD ohne Font) werden korrekt ignoriert.
// Rowspan-Duplikate werden über Nr-Referenz-Set dedupliziert.
// ============================================================================

function countChanges(html) {
  const lessonBlocks = [...html.matchAll(
    /<TD colspan=12 rowspan=\d+[^>]*><TABLE><TR>([\s\S]*?)<\/TR><\/TABLE><\/TD>/gi
  )].map(m => m[1]);

  let cancellations = 0;
  let substitutions = 0;
  const seenNrs = new Set();

  for (const block of lessonBlocks) {
    const tds = [...block.matchAll(/<TD[^>]*>([\s\S]*?)<\/TD>/gi)].map(m => {
      const f = m[1].match(/<font([^>]*)>([\s\S]*?)<\/font>/i);
      if (!f) return null;
      return { text: f[2].replace(/<[^>]+>/g, '').trim(), red: /FF0000/i.test(f[1]) };
    }).filter(Boolean);

    if (!tds.some(td => td.red)) continue;

    const fach = tds[0]?.text ?? '';
    // Deduplizierung: Nr-Referenz falls vorhanden, sonst Fach als Fallback
    const nr = tds.find(td => /^\d+\)$/.test(td.text))?.text ?? fach;
    if (seenNrs.has(nr)) continue;
    seenNrs.add(nr);

    fach === '---' ? cancellations++ : substitutions++;
  }

  return { cancellations, substitutions, total: cancellations + substitutions };
}

function buildPushMessage(substitutions, cancellations, diff) {
  const parts = [];
  if (cancellations > 0) parts.push(`${cancellations} ${cancellations === 1 ? 'Ausfall' : 'Ausfälle'}`);
  if (substitutions > 0) parts.push(`${substitutions} ${substitutions === 1 ? 'Vertretung' : 'Vertretungen'}`);
  return parts.length > 0
    ? parts.join(', ') + ' im Stundenplan.'
    : `${diff} ${diff === 1 ? 'neue Änderung' : 'neue Änderungen'} im Stundenplan.`;
}

// ============================================================================
// PUSH NOTIFICATIONS (HTTP/2)
// ============================================================================

async function sendPushToClass(className, changesCount, message) {
  const deviceTokens = await kv.get(`class:${className}`);
  if (!deviceTokens || !Array.isArray(deviceTokens) || deviceTokens.length === 0) {
    console.log(`⚠️ No devices for ${className}`);
    return;
  }
  console.log(`📤 Sending push to ${deviceTokens.length} device(s) for ${className}`);
  for (const token of deviceTokens) {
    try { await sendPushNotificationHTTP2(token, changesCount, message); }
    catch (e) { console.error(`❌ Push failed for ${token.substring(0, 10)}:`, e.message); }
  }
}

async function sendPushNotificationHTTP2(deviceToken, changesCount, message) {
  return new Promise((resolve, reject) => {
    try {
      const payload = JSON.stringify({
        aps: { alert: { title: 'Stundenplan geändert! ⚠️', body: message }, badge: changesCount, sound: 'default' },
      });
      const client = http2.connect(`https://${CONFIG.APNS_HOST}`);
      client.on('error', err => { client.close(); reject(err); });

      const req = client.request({
        ':method': 'POST', ':scheme': 'https', ':path': `/3/device/${deviceToken}`,
        'authorization': `bearer ${createAPNsJWT()}`,
        'apns-topic': CONFIG.APNS_TOPIC, 'apns-priority': '10', 'apns-push-type': 'alert',
      });

      req.setEncoding('utf8');
      let responseData = '';
      req.on('response', headers => {
        const status = headers[':status'];
        req.on('data', c => { responseData += c; });
        req.on('end', () => {
          client.close();
          if (status === 200) { console.log(`✅ Push sent to ${deviceToken.substring(0, 10)}`); resolve(); return; }
          if (status === 410) removeDeviceToken(deviceToken).catch(console.error);
          if (status === 400) {
            try { if (JSON.parse(responseData).reason === 'BadDeviceToken') removeDeviceToken(deviceToken).catch(console.error); } catch {}
          }
          reject(new Error(`APNs error: ${status} – ${responseData}`));
        });
      });
      req.on('error', err => { client.close(); reject(err); });
      req.write(payload);
      req.end();
    } catch (e) { reject(e); }
  });
}

function createAPNsJWT() {
  let key = process.env.APNS_PRIVATE_KEY;
  if (!key.includes('\n') && key.includes('\\n')) key = key.replace(/\\n/g, '\n');
  if (!key.includes('\n')) {
    key = key.replace('-----BEGIN PRIVATE KEY-----', '-----BEGIN PRIVATE KEY-----\n')
             .replace('-----END PRIVATE KEY-----', '\n-----END PRIVATE KEY-----');
  }
  return jwt.sign(
    { iss: process.env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) },
    key,
    { algorithm: 'ES256', header: { alg: 'ES256', kid: process.env.APNS_KEY_ID } }
  );
}

async function removeDeviceToken(deviceToken) {
  const raw = await kv.get(`device:${deviceToken}`);
  if (raw) {
    const device = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const tokens = (await kv.get(`class:${device.className}`) || []).filter(t => t !== deviceToken);
    tokens.length > 0 ? await kv.set(`class:${device.className}`, tokens) : await kv.del(`class:${device.className}`);
  }
  await kv.del(`device:${deviceToken}`);
  console.log(`🗑️ Removed token: ${deviceToken.substring(0, 10)}...`);
}

// ============================================================================
// HELPERS
// ============================================================================

function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function normalizeHTML(html) {
  let n = html;
  for (const p of [
    /Stand:\s*\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}/gi,
    /generiert.*?\d{2}\.\d{2}\.\d{4}/gi,
    /\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2}/gi,
    /Periode\d+\s+\d{1,2}\.\d{1,2}\.\d{4}.*?(?:Zwischenplan|$)/gi,
    /\d{1,2}\.\d{1,2}\./g,
    /<meta name="GENERATOR"[^>]*>/gi,
    /<title>.*?<\/title>/gi,
  ]) n = n.replace(p, '');
  return n.replace(/\s+/g, ' ').trim();
}

function hashString(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

async function saveCheckLog(data) {
  try {
    await kv.set(
      `log:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`,
      { timestamp: new Date().toISOString(), type: 'stundenplan_check', ...data },
      { ex: 31 * 24 * 60 * 60 }
    );
  } catch (e) { console.error('❌ Failed to save log:', e.message); }
}
