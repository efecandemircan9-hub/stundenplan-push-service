// api/check-stundenplan.js
// Vercel Serverless Function - Verbesserte Version mit korrekter Timestamp-Normalisierung

import { kv } from '@vercel/kv';
import jwt from 'jsonwebtoken';

// ============================================================================
// CONFIG
// ============================================================================

const CONFIG = {
  BKB_BASE_URL: 'https://stundenplan.bkb.nrw',
  MAPPING_URL: 'https://raw.githubusercontent.com/efecandemircan9-hub/BKBMapping/refs/heads/main/mapping.json',
  APNS_URL: process.env.APNS_ENVIRONMENT === 'sandbox' 
    ? 'https://api.sandbox.push.apple.com'
    : 'https://api.push.apple.com',
  APNS_TOPIC: 'nrw.bkb.stundenplan',
};

// ============================================================================
// MAIN HANDLER
// ============================================================================

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  try {
    console.log('🔍 Starting stundenplan check...');
    
    // Lade alle registrierten Klassen
    const classes = await getRegisteredClasses();
    console.log(`📚 Found ${classes.length} classes`);
    
    // Lade Mapping
    const mappingResponse = await fetch(CONFIG.MAPPING_URL);
    const mapping = await mappingResponse.json();
    
    const results = [];
    
    // Prüfe jede Klasse
    for (const className of classes) {
      try {
        const result = await checkStundenplanForClass(className, mapping);
        results.push(result);
      } catch (error) {
        console.error(`❌ Error checking ${className}:`, error.message);
        results.push({ className, error: error.message });
      }
    }
    
    // Update last check time
    await kv.set('meta:lastCheck', new Date().toISOString());
    
    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      classes: classes.length,
      results,
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
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
  
  // Aktuelle Woche
  const week = getWeekNumber(new Date());
  const weekFormatted = String(week).padStart(2, '0');
  
  // Lade Stundenplan mit Basic Auth
  const url = `${CONFIG.BKB_BASE_URL}/schueler/${weekFormatted}/c/${slug}`;
  
  const username = 'schueler';
  const password = 'stundenplan';
  const basicAuth = 'Basic ' + btoa(username + ':' + password);
  
  const response = await fetch(url, {
    headers: {
      'Authorization': basicAuth,
    },
  });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch stundenplan: ${response.status}`);
  }
  
  const htmlText = await response.text();
  
  // ============================================================
  // WICHTIG: Normalisiere HTML (entferne Timestamps & Datumsangaben)
  // ============================================================
  const normalizedHTML = normalizeHTML(htmlText);
  const newHash = hashString(normalizedHTML);
  const newRedCount = countRedEntries(htmlText);
  
  // Lade Cache
  const cacheKey = `cache:${className}:w${week}`;
  const cachedData = await kv.get(cacheKey);
  
  if (!cachedData) {
    // Erster Check - speichere
    const cacheData = {
      hash: newHash,
      redCount: newRedCount,
      normalizedHTML: normalizedHTML, // Speichere normalisiertes HTML
      updatedAt: new Date().toISOString(),
    };
    
    await kv.set(cacheKey, cacheData);
    
    console.log(`✅ ${className}: First check - cached`);
    
    return {
      className,
      status: 'first_check',
      cached: true,
    };
  }
  
  // Parse cache data
  let cached;
  if (typeof cachedData === 'string') {
    cached = JSON.parse(cachedData);
  } else {
    cached = cachedData;
  }
  
  console.log(`🔍 ${className}: Comparing...`);
  console.log(`   Cached hash: ${cached.hash}`);
  console.log(`   New hash:    ${newHash}`);
  console.log(`   Cached red:  ${cached.redCount || 0}`);
  console.log(`   New red:     ${newRedCount}`);
  
  // ============================================================
  // VERGLEICH: Hash unterschiedlich = Inhalt hat sich geändert
  // ============================================================
  if (cached.hash === newHash) {
    console.log(`✅ ${className}: No changes`);
    return {
      className,
      status: 'no_changes',
      hash: newHash,
    };
  }
  
  // Hash unterschiedlich!
  console.log(`⚠️  ${className}: Hash changed!`);
  
  // ============================================================
  // Prüfe ob es eine RELEVANTE Änderung ist
  // ============================================================
  
  const oldRedCount = cached.redCount || 0;
  
  // Fall 1: Mehr rote Einträge = Ausfälle/Änderungen
  if (newRedCount > oldRedCount) {
    const difference = newRedCount - oldRedCount;
    const changes = Math.max(1, Math.floor(difference / 4)); // ~4 rote Tags pro Ausfall
    
    console.log(`🚨 ${className}: ${changes} new changes detected!`);
    console.log(`   Red count: ${oldRedCount} → ${newRedCount} (+${difference})`);
    
    // Sende Push
    await sendPushToClass(className, changes);
    
    // Update cache
    const newCacheData = {
      hash: newHash,
      redCount: newRedCount,
      normalizedHTML: normalizedHTML,
      updatedAt: new Date().toISOString(),
    };
    
    await kv.set(cacheKey, newCacheData);
    
    return {
      className,
      status: 'changes_detected',
      changes,
      redCountChange: `${oldRedCount} → ${newRedCount}`,
      pushed: true,
    };
  }
  
  // Fall 2: Weniger rote Einträge = Ausfälle wurden entfernt
  if (newRedCount < oldRedCount) {
    const difference = oldRedCount - newRedCount;
    
    console.log(`ℹ️  ${className}: ${difference} red entries removed (cancellations cleared)`);
    
    // Update cache (ohne Push)
    const newCacheData = {
      hash: newHash,
      redCount: newRedCount,
      normalizedHTML: normalizedHTML,
      updatedAt: new Date().toISOString(),
    };
    
    await kv.set(cacheKey, newCacheData);
    
    return {
      className,
      status: 'changes_cleared',
      message: 'Ausfälle wurden entfernt',
      redCountChange: `${oldRedCount} → ${newRedCount}`,
      pushed: false,
    };
  }
  
  // Fall 3: Hash unterschiedlich, aber gleiche redCount
  // = Nur Text/Raum/Lehrer geändert (auch wichtig!)
  console.log(`📝 ${className}: Content changed (same red count)`);
  
  // Sende trotzdem Push (könnte Raumänderung sein!)
  await sendPushToClass(className, 1, 'Stundenplan aktualisiert');
  
  // Update cache
  const newCacheData = {
    hash: newHash,
    redCount: newRedCount,
    normalizedHTML: normalizedHTML,
    updatedAt: new Date().toISOString(),
  };
  
  await kv.set(cacheKey, newCacheData);
  
  return {
    className,
    status: 'content_changed',
    message: 'Stundenplan wurde aktualisiert (gleiche Anzahl Ausfälle)',
    pushed: true,
  };
}

// ============================================================================
// PUSH NOTIFICATIONS
// ============================================================================

async function sendPushToClass(className, changesCount, customMessage = null) {
  // Hole alle Devices dieser Klasse
  const deviceTokens = await kv.get(`class:${className}`);
  
  if (!deviceTokens || !Array.isArray(deviceTokens)) {
    console.log(`⚠️ No devices for ${className}`);
    return;
  }
  
  console.log(`📤 Sending push to ${deviceTokens.length} devices`);
  
  for (const deviceToken of deviceTokens) {
    try {
      await sendPushNotification(deviceToken, changesCount, customMessage);
    } catch (error) {
      console.error(`❌ Push failed for ${deviceToken.substring(0, 10)}:`, error.message);
    }
  }
}

async function sendPushNotification(deviceToken, changesCount, customMessage = null) {
  // Erstelle APNs JWT Token
  const jwtToken = createAPNsJWT();
  
  // Payload
  let body;
  if (customMessage) {
    body = customMessage;
  } else {
    body = `${changesCount} ${changesCount === 1 ? 'Stunde wurde' : 'Stunden wurden'} geändert oder ${changesCount === 1 ? 'fällt' : 'fallen'} aus.`;
  }
  
  const payload = {
    aps: {
      alert: {
        title: 'Stundenplan geändert! ⚠️',
        body: body,
      },
      badge: changesCount,
      sound: 'default',
    },
  };
  
  // Sende an APNs
  const response = await fetch(`${CONFIG.APNS_URL}/3/device/${deviceToken}`, {
    method: 'POST',
    headers: {
      'authorization': `bearer ${jwtToken}`,
      'apns-topic': CONFIG.APNS_TOPIC,
      'apns-priority': '10',
      'apns-push-type': 'alert',
    },
    body: JSON.stringify(payload),
  });
  
  if (response.ok) {
    console.log(`✅ Push sent to ${deviceToken.substring(0, 10)}`);
  } else {
    const errorText = await response.text();
    console.error(`❌ APNs error: ${response.status} - ${errorText}`);
    
    // Bei ungültigem Token: entfernen
    if (response.status === 410) {
      await removeDeviceToken(deviceToken);
      console.log(`🗑️ Removed invalid token`);
    }
  }
}

function createAPNsJWT() {
  const now = Math.floor(Date.now() / 1000);
  
  const payload = {
    iss: process.env.APNS_TEAM_ID,
    iat: now,
  };
  
  const header = {
    alg: 'ES256',
    kid: process.env.APNS_KEY_ID,
  };
  
  const privateKey = process.env.APNS_PRIVATE_KEY;
  
  return jwt.sign(payload, privateKey, {
    algorithm: 'ES256',
    header,
  });
}

async function removeDeviceToken(deviceToken) {
  const deviceData = await kv.get(`device:${deviceToken}`);
  
  if (deviceData) {
    let device;
    if (typeof deviceData === 'string') {
      device = JSON.parse(deviceData);
    } else {
      device = deviceData;
    }
    
    const classTokens = await kv.get(`class:${device.className}`) || [];
    const filtered = classTokens.filter(t => t !== deviceToken);
    await kv.set(`class:${device.className}`, filtered);
  }
  
  await kv.del(`device:${deviceToken}`);
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
  
  // ============================================================
  // WICHTIG: Entferne alle sich ändernden Elemente
  // ============================================================
  
  const patterns = [
    // Timestamps im Format "Stand: DD.MM.YYYY HH:MM"
    /Stand:\s*\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}/gi,
    
    // "generiert am DD.MM.YYYY"
    /generiert.*?\d{2}\.\d{2}\.\d{4}/gi,
    
    // Timestamp im Format "DD.MM.YYYY HH:MM:SS"
    /\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2}/gi,
    
    // Periode mit Datum: "Periode8   2.2.2026 D (24) (6) - 8.2.2026 D (24) (6)   Zwischenplan"
    /Periode\d+\s+\d{1,2}\.\d{1,2}\.\d{4}.*?Zwischenplan/gi,
    
    // Einzelne Datumsangaben im Format D.M.YYYY oder DD.MM.YYYY
    /\d{1,2}\.\d{1,2}\.\d{4}/g,
    
    // Meta-Tag mit GENERATOR
    /<meta name="GENERATOR"[^>]*>/gi,
    
    // Title-Tag mit Jahr
    /<title>.*?<\/title>/gi,
  ];
  
  for (const pattern of patterns) {
    normalized = normalized.replace(pattern, '');
  }
  
  // Entferne mehrfache Leerzeichen und normalisiere
  normalized = normalized.replace(/\s+/g, ' ').trim();
  
  return normalized;
}

function countRedEntries(html) {
  const patterns = [
    /color="#FF0000"/gi, 
    /color="red"/gi, 
    /color:#FF0000/gi,
    /color:\s*#FF0000/gi,
    /color:\s*red/gi,
  ];
  
  let count = 0;
  for (const pattern of patterns) {
    const matches = html.match(pattern);
    if (matches) count += matches.length;
  }
  return count;
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return hash;
}
