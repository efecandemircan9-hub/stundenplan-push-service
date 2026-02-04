// api/check-stundenplan.js
// Vercel Serverless Function

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
  
  // Lade Stundenplan
  const url = `${CONFIG.BKB_BASE_URL}/schueler/${weekFormatted}/c/${slug}`;
  const response = await fetch(url);
  
  if (!response.ok) {
    throw new Error(`Failed to fetch stundenplan: ${response.status}`);
  }
  
  const htmlText = await response.text();
  
  // Normalisiere und hash
  const normalizedHTML = normalizeHTML(htmlText);
  const newHash = hashString(normalizedHTML);
  
  // Lade Cache
  const cacheKey = `cache:${className}:w${week}`;
  const cachedData = await kv.get(cacheKey);
  
  if (!cachedData) {
    // Erster Check - speichere
    await kv.set(cacheKey, JSON.stringify({
      hash: newHash,
      redCount: countRedEntries(htmlText),
      updatedAt: new Date().toISOString(),
    }));
    
    return {
      className,
      status: 'first_check',
      cached: true,
    };
  }
  
  const cached = JSON.parse(cachedData);
  
  // Vergleiche
  if (cached.hash === newHash) {
    return {
      className,
      status: 'no_changes',
      hash: newHash,
    };
  }
  
  // Hash unterschiedlich - prüfe rote Einträge
  const oldRedCount = cached.redCount || 0;
  const newRedCount = countRedEntries(htmlText);
  
  if (newRedCount > oldRedCount) {
    const difference = Math.max(1, Math.floor((newRedCount - oldRedCount) / 4));
    console.log(`🚨 ${className}: ${difference} new changes!`);
    
    // Sende Push
    await sendPushToClass(className, difference);
    
    // Update cache
    await kv.set(cacheKey, JSON.stringify({
      hash: newHash,
      redCount: newRedCount,
      updatedAt: new Date().toISOString(),
    }));
    
    return {
      className,
      status: 'changes_detected',
      changes: difference,
      pushed: true,
    };
  }
  
  return {
    className,
    status: 'hash_different_no_changes',
    message: 'Probably timestamp change',
  };
}

// ============================================================================
// PUSH NOTIFICATIONS
// ============================================================================

async function sendPushToClass(className, changesCount) {
  // Hole alle Devices dieser Klasse
  const deviceTokens = await kv.get(`class:${className}`);
  
  if (!deviceTokens || !Array.isArray(deviceTokens)) {
    console.log(`⚠️ No devices for ${className}`);
    return;
  }
  
  console.log(`📤 Sending push to ${deviceTokens.length} devices`);
  
  for (const deviceToken of deviceTokens) {
    try {
      await sendPushNotification(deviceToken, changesCount);
    } catch (error) {
      console.error(`❌ Push failed for ${deviceToken.substring(0, 10)}:`, error.message);
    }
  }
}

async function sendPushNotification(deviceToken, changesCount) {
  // Erstelle APNs JWT Token
  const jwtToken = createAPNsJWT();
  
  // Payload
  const payload = {
    aps: {
      alert: {
        title: 'Stundenplan geändert! ⚠️',
        body: `${changesCount} ${changesCount === 1 ? 'Stunde wurde' : 'Stunden wurden'} geändert oder ${changesCount === 1 ? 'fällt' : 'fallen'} aus.`,
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
  
  // Private Key aus Environment
  const privateKey = process.env.APNS_PRIVATE_KEY;
  
  return jwt.sign(payload, privateKey, {
    algorithm: 'ES256',
    header,
  });
}

async function removeDeviceToken(deviceToken) {
  // Hole Device Info
  const deviceData = await kv.get(`device:${deviceToken}`);
  
  if (deviceData) {
    const device = JSON.parse(deviceData);
    
    // Entferne aus Klassen-Liste
    const classTokens = await kv.get(`class:${device.className}`) || [];
    const filtered = classTokens.filter(t => t !== deviceToken);
    await kv.set(`class:${device.className}`, filtered);
  }
  
  // Entferne Device
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
  const patterns = [
    /Stand:\s*\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}/gi,
    /generiert.*?\d{2}\.\d{2}\.\d{4}/gi,
    /\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2}/gi,
  ];
  for (const pattern of patterns) {
    normalized = normalized.replace(pattern, '');
  }
  return normalized.replace(/\s+/g, ' ').trim();
}

function countRedEntries(html) {
  const patterns = [/color="#FF0000"/gi, /color="red"/gi, /color:#FF0000/gi];
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
