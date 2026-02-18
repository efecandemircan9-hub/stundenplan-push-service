// api/check-stundenplan.js
// Production version mit HTTP/2 für APNs

import { kv } from '@vercel/kv';
import jwt from 'jsonwebtoken';
import http2 from 'http2';
import crypto from 'crypto';

// ============================================================================
// CONFIG
// ============================================================================

const CONFIG = {
  BKB_BASE_URL: 'https://stundenplan.bkb.nrw',
  MAPPING_URL: 'https://raw.githubusercontent.com/efecandemircan9-hub/BKBMapping/refs/heads/main/mapping.json',
  APNS_HOST: process.env.APNS_ENVIRONMENT === 'sandbox'
    ? 'api.sandbox.push.apple.com'
    : 'api.push.apple.com',
  APNS_TOPIC: 'nrw.bkb',
};

// ============================================================================
// MAIN HANDLER
// ============================================================================

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

    const mappingResponse = await fetch(CONFIG.MAPPING_URL);
    const mapping = await mappingResponse.json();

    const results = [];
    for (const className of classes) {
      try {
        const result = await checkStundenplanForClass(className, mapping);
        results.push(result);
      } catch (error) {
        console.error(`❌ Error checking ${className}:`, error.message);
        results.push({ className, status: 'error', error: error.message });
      }
    }

    await kv.set('meta:lastCheck', new Date().toISOString());

    const totalChanges = results
      .filter(r => r.status === 'changes_detected')
      .reduce((sum, r) => sum + (r.newChanges || 0), 0);
    const totalPushesSent = results.filter(r => r.pushed).length;

    await saveCheckLog({
      status: 'completed',
      duration: Date.now() - startTime,
      classes: classes.length,
      results,
      totalChanges,
      totalPushesSent,
    });

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      classes: classes.length,
      results,
    });

  } catch (error) {
    console.error('❌ Error:', error);
    await saveCheckLog({ status: 'error', error: error.message, duration: Date.now() - startTime });
    return res.status(500).json({ success: false, error: error.message });
  }
}

// ============================================================================
// STUNDENPLAN CHECKING
// ============================================================================

async function getRegisteredClasses() {
  const keys = await kv.keys('class:*');
  return keys.map(k => k.replace('class:', ''));
}

async function checkStundenplanForClass(className, mapping) {
  const slug = mapping[className];
  if (!slug) throw new Error(`No slug found for ${className}`);

  const now = new Date();
  const week = getWeekNumber(now);
  const year = now.getFullYear();
  const weekFormatted = String(week).padStart(2, '0');

  const url = `${CONFIG.BKB_BASE_URL}/schueler/${weekFormatted}/c/${slug}`;
  const basicAuth = 'Basic ' + btoa('schueler:stundenplan');

  const response = await fetch(url, { headers: { 'Authorization': basicAuth } });
  if (!response.ok) throw new Error(`Failed to fetch stundenplan: ${response.status}`);

  const htmlText = await response.text();
  const normalizedHTML = normalizeHTML(htmlText);
  const newHash = hashString(normalizedHTML);
  const { substitutions, cancellations, total: newChangeCount } = countChanges(htmlText);

  // Jahr im Key verhindert Jahreswechsel-Bug
  const cacheKey = `cache:${className}:${year}:w${week}`;
  const cachedRaw = await kv.get(cacheKey);

  if (!cachedRaw) {
    await kv.set(cacheKey, {
      hash: newHash,
      changeCount: newChangeCount,
      updatedAt: new Date().toISOString(),
    });
    console.log(`✅ ${className}: First check – cached (${substitutions} Vertretungen, ${cancellations} Ausfälle)`);
    return { className, status: 'first_check', changeCount: newChangeCount };
  }

  const cached = typeof cachedRaw === 'string' ? JSON.parse(cachedRaw) : cachedRaw;
  const oldChangeCount = cached.changeCount ?? 0;

  console.log(`🔍 ${className}: hash ${cached.hash === newHash ? 'SAME' : 'CHANGED'} | changes ${oldChangeCount}→${newChangeCount}`);

  // Hash identisch = absolut keine Änderung
  if (cached.hash === newHash) {
    return { className, status: 'no_changes' };
  }

  // Cache immer aktualisieren wenn Hash geändert
  await kv.set(cacheKey, {
    hash: newHash,
    changeCount: newChangeCount,
    updatedAt: new Date().toISOString(),
  });

  // Mehr Änderungen als zuvor → Push
  if (newChangeCount > oldChangeCount) {
    const diff = newChangeCount - oldChangeCount;
    console.log(`🚨 ${className}: ${diff} neue Änderung(en) (${substitutions} Vertretungen, ${cancellations} Ausfälle)`);
    const msg = buildPushMessage(substitutions, cancellations, diff);
    await sendPushToClass(className, diff, msg);
    return {
      className,
      status: 'changes_detected',
      newChanges: diff,
      substitutions,
      cancellations,
      changeCount: `${oldChangeCount}→${newChangeCount}`,
      pushed: true,
    };
  }

  // Weniger Änderungen (Ausfälle behoben) → kein Push
  if (newChangeCount < oldChangeCount) {
    console.log(`ℹ️  ${className}: Änderungen reduziert (${oldChangeCount}→${newChangeCount})`);
    return {
      className,
      status: 'changes_cleared',
      changeCount: `${oldChangeCount}→${newChangeCount}`,
      pushed: false,
    };
  }

  // Gleiche Anzahl aber anderer Hash → Inhalt getauscht (z.B. anderer Vertreter)
  console.log(`📝 ${className}: Inhalt geändert, gleiche Anzahl (${newChangeCount})`);
  await sendPushToClass(className, newChangeCount || 1, 'Stundenplanänderung: Einträge wurden aktualisiert.');
  return {
    className,
    status: 'changes_updated',
    changeCount: newChangeCount,
    pushed: true,
  };
}

// ============================================================================
// CHANGE DETECTION
//
// Die Zwischenplan-Tabelle (bgcolor="#E7E7E7") enthält NUR dauerhafte
// Gruppendefinitionen mit Schulwoche "1-7,10-17,20-31,34-47" (= ganzes Jahr).
// Sie zeigt KEINE aktuellen wöchentlichen Änderungen → wird ignoriert.
//
// Der einzig zuverlässige Indikator: rote Font-Tags im Hauptgitter.
//
// Pro geänderter Stunde im Grid:
//   Vertretung: <font red>Fach</font><font red>Nr)</font><font red>Raum</font><font red>Lehrer</font>
//   Ausfall:    <font red>---</font> <font red>Nr)</font><font red>Raum</font><font red>---</font>
//
// Jede Stunde erscheint wegen rowspan DOPPELT im HTML.
// → Vertretungen = Anzahl eindeutiger Nr-Referenzen (Set)
// → Ausfälle     = count('---') / 2
// ============================================================================

function countChanges(html) {
  const redTexts = (
    html.match(/<font[^>]*color=["']?#?FF0000["']?[^>]*>([\s\S]*?)<\/font>/gi) || []
  ).map(tag => tag.replace(/<[^>]+>/g, '').trim());

  // Eindeutige Nr-Referenzen (z.B. "4)", "5)") = Vertretungen
  const nrRefs = new Set(redTexts.filter(t => /^\d+\)$/.test(t)));
  const substitutions = nrRefs.size;

  // "---" = Ausfall-Marker, wegen rowspan doppelt → halbieren
  const cancellations = Math.floor(redTexts.filter(t => t === '---').length / 2);

  return { substitutions, cancellations, total: substitutions + cancellations };
}

function buildPushMessage(substitutions, cancellations, diff) {
  const parts = [];
  if (cancellations > 0) parts.push(`${cancellations} ${cancellations === 1 ? 'Ausfall' : 'Ausfälle'}`);
  if (substitutions > 0) parts.push(`${substitutions} ${substitutions === 1 ? 'Vertretung' : 'Vertretungen'}`);
  if (parts.length > 0) return parts.join(', ') + ' im Stundenplan.';
  return `${diff} ${diff === 1 ? 'neue Änderung' : 'neue Änderungen'} im Stundenplan.`;
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
  for (const deviceToken of deviceTokens) {
    try {
      await sendPushNotificationHTTP2(deviceToken, changesCount, message);
    } catch (error) {
      console.error(`❌ Push failed for ${deviceToken.substring(0, 10)}:`, error.message);
    }
  }
}

async function sendPushNotificationHTTP2(deviceToken, changesCount, message) {
  return new Promise((resolve, reject) => {
    try {
      const jwtToken = createAPNsJWT();
      const payload = JSON.stringify({
        aps: {
          alert: { title: 'Stundenplan geändert! ⚠️', body: message },
          badge: changesCount,
          sound: 'default',
        },
      });

      const client = http2.connect(`https://${CONFIG.APNS_HOST}`);
      client.on('error', err => { client.close(); reject(err); });

      const req = client.request({
        ':method': 'POST',
        ':scheme': 'https',
        ':path': `/3/device/${deviceToken}`,
        'authorization': `bearer ${jwtToken}`,
        'apns-topic': CONFIG.APNS_TOPIC,
        'apns-priority': '10',
        'apns-push-type': 'alert',
      });

      req.setEncoding('utf8');
      let responseData = '';
      req.on('response', headers => {
        const statusCode = headers[':status'];
        req.on('data', chunk => { responseData += chunk; });
        req.on('end', () => {
          client.close();
          if (statusCode === 200) {
            console.log(`✅ Push sent to ${deviceToken.substring(0, 10)}`);
            resolve();
          } else {
            if (statusCode === 410) removeDeviceToken(deviceToken).catch(console.error);
            if (statusCode === 400) {
              try {
                if (JSON.parse(responseData).reason === 'BadDeviceToken')
                  removeDeviceToken(deviceToken).catch(console.error);
              } catch {}
            }
            reject(new Error(`APNs error: ${statusCode} – ${responseData}`));
          }
        });
      });
      req.on('error', err => { client.close(); reject(err); });
      req.write(payload);
      req.end();
    } catch (error) {
      reject(error);
    }
  });
}

function createAPNsJWT() {
  let privateKey = process.env.APNS_PRIVATE_KEY;
  if (!privateKey.includes('\n') && privateKey.includes('\\n'))
    privateKey = privateKey.replace(/\\n/g, '\n');
  if (!privateKey.includes('\n')) {
    privateKey = privateKey
      .replace('-----BEGIN PRIVATE KEY-----', '-----BEGIN PRIVATE KEY-----\n')
      .replace('-----END PRIVATE KEY-----', '\n-----END PRIVATE KEY-----');
  }
  return jwt.sign(
    { iss: process.env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) },
    privateKey,
    { algorithm: 'ES256', header: { alg: 'ES256', kid: process.env.APNS_KEY_ID } }
  );
}

async function removeDeviceToken(deviceToken) {
  const deviceData = await kv.get(`device:${deviceToken}`);
  if (deviceData) {
    const device = typeof deviceData === 'string' ? JSON.parse(deviceData) : deviceData;
    const classTokens = await kv.get(`class:${device.className}`) || [];
    const filtered = classTokens.filter(t => t !== deviceToken);
    if (filtered.length > 0) {
      await kv.set(`class:${device.className}`, filtered);
    } else {
      await kv.del(`class:${device.className}`);
    }
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
  const patterns = [
    /Stand:\s*\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}/gi,
    /generiert.*?\d{2}\.\d{2}\.\d{4}/gi,
    /\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2}/gi,
    /Periode\d+\s+\d{1,2}\.\d{1,2}\.\d{4}.*?(?:Zwischenplan|$)/gi,
    /\d{1,2}\.\d{1,2}\./g,
    /<meta name="GENERATOR"[^>]*>/gi,
    /<title>.*?<\/title>/gi,
  ];
  for (const p of patterns) n = n.replace(p, '');
  return n.replace(/\s+/g, ' ').trim();
}

function hashString(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

// ============================================================================
// LOGGING
// ============================================================================

async function saveCheckLog(data) {
  try {
    const key = `log:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
    await kv.set(
      key,
      { timestamp: new Date().toISOString(), type: 'stundenplan_check', ...data },
      { ex: 31 * 24 * 60 * 60 }
    );
  } catch (error) {
    console.error('❌ Failed to save log:', error.message);
  }
}
