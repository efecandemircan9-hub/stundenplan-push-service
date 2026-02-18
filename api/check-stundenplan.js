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

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

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
      .reduce((sum, r) => sum + (r.changes || 0), 0);
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
  if (!slug) {
    throw new Error(`No slug found for ${className}`);
  }

  const now = new Date();
  const week = getWeekNumber(now);
  const year = now.getFullYear(); // ← Bug-Fix: Jahr im Cache-Key
  const weekFormatted = String(week).padStart(2, '0');

  const url = `${CONFIG.BKB_BASE_URL}/schueler/${weekFormatted}/c/${slug}`;
  const basicAuth = 'Basic ' + btoa('schueler:stundenplan');

  const response = await fetch(url, { headers: { 'Authorization': basicAuth } });

  if (!response.ok) {
    throw new Error(`Failed to fetch stundenplan: ${response.status}`);
  }

  const htmlText = await response.text();
  const normalizedHTML = normalizeHTML(htmlText);
  const newHash = hashString(normalizedHTML); // SHA-256
  const newChanges = parseZwischenplanChanges(htmlText); // ← korrekte Änderungserkennung
  const newChangeCount = newChanges.length;

  // Bug-Fix: Jahr im Key verhindert Jahreswechsel-Fehler
  const cacheKey = `cache:${className}:${year}:w${week}`;
  const cachedData = await kv.get(cacheKey);

  if (!cachedData) {
    await kv.set(cacheKey, {
      hash: newHash,
      changeCount: newChangeCount,
      updatedAt: new Date().toISOString(),
    });

    console.log(`✅ ${className}: First check - cached (${newChangeCount} changes in Zwischenplan)`);
    return { className, status: 'first_check', changeCount: newChangeCount };
  }

  const cached = typeof cachedData === 'string' ? JSON.parse(cachedData) : cachedData;

  console.log(`🔍 ${className}: hash old=${cached.hash} new=${newHash}`);
  console.log(`   Zwischenplan: cached=${cached.changeCount ?? 0} new=${newChangeCount}`);

  // Hash unverändert → definitiv keine Änderung
  if (cached.hash === newHash) {
    console.log(`✅ ${className}: No changes`);
    return { className, status: 'no_changes' };
  }

  console.log(`⚠️  ${className}: Hash changed!`);

  const oldChangeCount = cached.changeCount ?? 0;

  // Cache immer aktualisieren wenn sich der Hash geändert hat
  const newCacheData = {
    hash: newHash,
    changeCount: newChangeCount,
    updatedAt: new Date().toISOString(),
  };
  await kv.set(cacheKey, newCacheData);

  // Neue Änderungen hinzugekommen
  if (newChangeCount > oldChangeCount) {
    const diff = newChangeCount - oldChangeCount;
    console.log(`🚨 ${className}: ${diff} new change(s) detected! (${oldChangeCount} → ${newChangeCount})`);

    const pushMessage = buildPushMessage(newChanges, oldChangeCount);
    await sendPushToClass(className, diff, pushMessage);

    return {
      className,
      status: 'changes_detected',
      changes: diff,
      changeCountChange: `${oldChangeCount} → ${newChangeCount}`,
      pushed: true,
    };
  }

  // Änderungen wurden weniger (Ausfälle entfernt) → kein Push
  if (newChangeCount < oldChangeCount) {
    console.log(`ℹ️  ${className}: Changes reduced (${oldChangeCount} → ${newChangeCount}) - no push`);
    return {
      className,
      status: 'changes_cleared',
      changeCountChange: `${oldChangeCount} → ${newChangeCount}`,
      pushed: false,
    };
  }

  // Hash geändert, aber gleiche Anzahl Änderungen → Vertretung/Raum wurde getauscht
  console.log(`📝 ${className}: Content changed, same change count (${newChangeCount})`);
  await sendPushToClass(className, newChangeCount || 1, 'Stundenplanänderung: Details wurden aktualisiert.');

  return {
    className,
    status: 'changes_updated',
    changeCount: newChangeCount,
    pushed: true,
  };
}

// ============================================================================
// ZWISCHENPLAN PARSING
// ============================================================================

/**
 * Parsed die graue Zwischenplan-Tabelle (bgcolor="#E7E7E7").
 * Gibt echte Änderungszeilen zurück (Vertretungen, Ausfälle, Raumwechsel).
 *
 * Struktur einer Zeile:
 *   Nr. | Le./Fa./Rm.             | Klasse | Zeit | Schulwoche | ...
 *   1)  | Vinn(Lück), Eng, A 203  | 1G23B  |      | 1-7,...    |
 *
 * Cancelled-Stunden werden im Stundenplan-Grid mit "+---+" (rot) markiert,
 * haben aber keinen Nr.-Eintrag in der Zwischenplan-Tabelle, sondern werden
 * direkt im Timetable-Grid rot eingefärbt.
 */
function parseZwischenplanChanges(html) {
  // Erste graue Tabelle = Änderungstabelle (zweite = Legende)
  const tableMatch = html.match(
    /<TABLE[^>]*bgcolor=["']#E7E7E7["'][^>]*>([\s\S]*?)<\/TABLE>/i
  );
  if (!tableMatch) return [];

  const rows = tableMatch[1].match(/<TR>([\s\S]*?)<\/TR>/gi) || [];
  const changes = [];

  // Zeile 0 = Header (Nr., Le.,Fa.,Rm., Kla., ...) → überspringen
  for (const row of rows.slice(1)) {
    const cells = (row.match(/<TD[^>]*>([\s\S]*?)<\/TD>/gi) || [])
      .map(c => c.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim());

    // Echte Änderungszeilen beginnen mit "1)", "2)", etc.
    if (cells[0] && /^\d+\)$/.test(cells[0].trim())) {
      changes.push({
        nr: cells[0].trim(),
        info: cells[1] || '',   // z.B. "Vinn(Lück), Eng(Physi), A 203"
        className: cells[2] || '',
        week: cells[3] || '',
      });
    }
  }

  // Zusätzlich: Ausgefallene Stunden (+---+) aus dem Hauptgitter zählen,
  // die NICHT in der Zwischenplan-Tabelle erscheinen.
  const cancelledInGrid = (html.match(
    /<font[^>]*color=["']?#FF0000["']?[^>]*>\s*\+---\+\s*<\/font>/gi
  ) || []);
  // Da jede Stunde wegen rowspan doppelt erscheint, durch 2 teilen
  const uniqueCancellations = Math.ceil(cancelledInGrid.length / 2);

  for (let i = 0; i < uniqueCancellations; i++) {
    changes.push({ nr: `cancelled_${i}`, info: 'Ausfall', className: '', week: '' });
  }

  return changes;
}

/**
 * Baut eine sinnvolle Push-Nachricht aus den Änderungen.
 */
function buildPushMessage(changes, previousCount) {
  const newOnes = changes.slice(previousCount);
  const subjects = [...new Set(
    newOnes
      .map(c => {
        const match = c.info.match(/,\s*([A-Za-zÄÖÜäöüß\-]+)\s*[,(]/);
        return match ? match[1] : null;
      })
      .filter(Boolean)
  )];

  if (subjects.length > 0 && subjects.length <= 3) {
    return `Neue Änderung: ${subjects.join(', ')}`;
  }

  const n = newOnes.length;
  return `${n} ${n === 1 ? 'neue Änderung' : 'neue Änderungen'} im Stundenplan.`;
}

// ============================================================================
// PUSH NOTIFICATIONS (HTTP/2)
// ============================================================================

async function sendPushToClass(className, changesCount, customMessage = null) {
  const deviceTokens = await kv.get(`class:${className}`);

  if (!deviceTokens || !Array.isArray(deviceTokens) || deviceTokens.length === 0) {
    console.log(`⚠️ No devices for ${className}`);
    return;
  }

  console.log(`📤 Sending push to ${deviceTokens.length} devices for ${className}`);

  for (const deviceToken of deviceTokens) {
    try {
      await sendPushNotificationHTTP2(deviceToken, changesCount, customMessage);
    } catch (error) {
      console.error(`❌ Push failed for ${deviceToken.substring(0, 10)}:`, error.message);
    }
  }
}

async function sendPushNotificationHTTP2(deviceToken, changesCount, customMessage = null) {
  console.log(`🔔 Push for device: ${deviceToken.substring(0, 20)}...`);

  return new Promise((resolve, reject) => {
    try {
      const jwtToken = createAPNsJWT();

      const body = customMessage
        ?? `${changesCount} ${changesCount === 1 ? 'neue Änderung' : 'neue Änderungen'} im Stundenplan.`;

      const payload = {
        aps: {
          alert: {
            title: 'Stundenplan geändert! ⚠️',
            body,
          },
          badge: changesCount,
          sound: 'default',
        },
      };

      const payloadString = JSON.stringify(payload);
      const client = http2.connect(`https://${CONFIG.APNS_HOST}`);

      client.on('error', (err) => {
        client.close();
        reject(err);
      });

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

      req.on('response', (headers) => {
        const statusCode = headers[':status'];
        console.log(`📥 APNs Response: ${statusCode}`);

        req.on('data', chunk => { responseData += chunk; });

        req.on('end', () => {
          client.close();

          if (statusCode === 200) {
            console.log(`✅ Push sent to ${deviceToken.substring(0, 10)}`);
            resolve();
          } else {
            console.error(`❌ APNs error: ${statusCode} - ${responseData}`);

            // Token abgelaufen oder App gelöscht
            if (statusCode === 410) {
              removeDeviceToken(deviceToken).catch(err =>
                console.error('Failed to remove device token:', err)
              );
            }

            // BadDeviceToken → ebenfalls entfernen
            if (statusCode === 400) {
              try {
                const body = JSON.parse(responseData);
                if (body.reason === 'BadDeviceToken') {
                  removeDeviceToken(deviceToken).catch(err =>
                    console.error('Failed to remove bad device token:', err)
                  );
                }
              } catch {}
            }

            reject(new Error(`APNs error: ${statusCode}`));
          }
        });
      });

      req.on('error', (err) => {
        client.close();
        reject(err);
      });

      req.write(payloadString);
      req.end();

    } catch (error) {
      console.error('❌ Push error:', error.message);
      reject(error);
    }
  });
}

function createAPNsJWT() {
  const now = Math.floor(Date.now() / 1000);

  let privateKey = process.env.APNS_PRIVATE_KEY;
  if (!privateKey.includes('\n') && privateKey.includes('\\n')) {
    privateKey = privateKey.replace(/\\n/g, '\n');
  }
  if (!privateKey.includes('\n')) {
    privateKey = privateKey
      .replace('-----BEGIN PRIVATE KEY-----', '-----BEGIN PRIVATE KEY-----\n')
      .replace('-----END PRIVATE KEY-----', '\n-----END PRIVATE KEY-----');
  }

  return jwt.sign(
    { iss: process.env.APNS_TEAM_ID, iat: now },
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
  console.log(`🗑️ Removed device token: ${deviceToken.substring(0, 10)}...`);
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
  let normalized = html;

  const patterns = [
    // Timestamps & Datumsangaben die sich ändern ohne inhaltliche Bedeutung
    /Stand:\s*\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}/gi,
    /generiert.*?\d{2}\.\d{2}\.\d{4}/gi,
    /\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2}/gi,
    // Perioden-Zeile am Ende enthält Datum → komplett entfernen
    /Periode\d+\s+\d{1,2}\.\d{1,2}\.\d{4}.*?(?:Zwischenplan|$)/gi,
    // Einzelne Datumsangaben in Spaltenkopfzeilen (Mo 16.2. etc.)
    /\d{1,2}\.\d{1,2}\./g,
    /<meta name="GENERATOR"[^>]*>/gi,
    /<title>.*?<\/title>/gi,
  ];

  for (const pattern of patterns) {
    normalized = normalized.replace(pattern, '');
  }

  return normalized.replace(/\s+/g, ' ').trim();
}

/**
 * SHA-256 Hash (kein 32-bit Overflow → keine Kollisionen).
 */
function hashString(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

// ============================================================================
// LOGGING
// ============================================================================

async function saveCheckLog(checkData) {
  try {
    const logKey = `log:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
    await kv.set(
      logKey,
      { timestamp: new Date().toISOString(), type: 'stundenplan_check', ...checkData },
      { ex: 31 * 24 * 60 * 60 }
    );
    console.log(`📝 Log saved: ${logKey}`);
  } catch (error) {
    console.error('❌ Failed to save log:', error.message);
  }
}
