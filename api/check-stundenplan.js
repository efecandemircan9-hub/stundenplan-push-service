// api/check-stundenplan.js
// Production version mit HTTP/2 für APNs

import { kv } from '@vercel/kv';
import jwt from 'jsonwebtoken';
import http2 from 'http2';

// ============================================================================
// CONFIG
// ============================================================================

const CONFIG = {
  BKB_BASE_URL: 'https://stundenplan.bkb.nrw',
  MAPPING_URL: 'https://raw.githubusercontent.com/efecandemircan9-hub/BKBMapping/refs/heads/main/mapping.json',
  APNS_HOST: process.env.APNS_ENVIRONMENT === 'sandbox' 
    ? 'api.sandbox.push.apple.com'
    : 'api.push.apple.com',
  APNS_TOPIC: 'nrw.bkb.stundenplan',
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
  
  try {
    console.log('🔍 Starting stundenplan check...');
    
    const classes = await getRegisteredClasses();
    console.log(`📚 Found ${classes.length} classes`);
    
    const mappingResponse = await fetch(CONFIG.MAPPING_URL);
    const mapping = await mappingResponse.json();
    
    const results = [];
    
    for (const className of classes) {
      try {
        const result = await checkStundenplanForClass(className, mapping);
        results.push(result);
      } catch (error) {
        console.error(`❌ Error checking ${className}:`, error.message);
        results.push({ className, error: error.message });
      }
    }
    
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
  
  const week = getWeekNumber(new Date());
  const weekFormatted = String(week).padStart(2, '0');
  
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
  
  const normalizedHTML = normalizeHTML(htmlText);
  const newHash = hashString(normalizedHTML);
  const newRedCount = countRedEntries(htmlText);
  
  const cacheKey = `cache:${className}:w${week}`;
  const cachedData = await kv.get(cacheKey);
  
  if (!cachedData) {
    const cacheData = {
      hash: newHash,
      redCount: newRedCount,
      normalizedHTML: normalizedHTML,
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
  
  if (cached.hash === newHash) {
    console.log(`✅ ${className}: No changes`);
    return {
      className,
      status: 'no_changes',
      hash: newHash,
    };
  }
  
  console.log(`⚠️  ${className}: Hash changed!`);
  
  const oldRedCount = cached.redCount || 0;
  
  if (newRedCount > oldRedCount) {
    const difference = newRedCount - oldRedCount;
    const changes = Math.max(1, Math.floor(difference / 4));
    
    console.log(`🚨 ${className}: ${changes} new changes detected!`);
    console.log(`   Red count: ${oldRedCount} → ${newRedCount} (+${difference})`);
    
    await sendPushToClass(className, changes);
    
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
  
  if (newRedCount < oldRedCount) {
    const difference = oldRedCount - newRedCount;
    
    console.log(`ℹ️  ${className}: ${difference} red entries removed`);
    
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
  
  console.log(`📝 ${className}: Content changed (same red count)`);
  
  await sendPushToClass(className, 1, 'Stundenplan aktualisiert');
  
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
    message: 'Stundenplan wurde aktualisiert',
    pushed: true,
  };
}

// ============================================================================
// PUSH NOTIFICATIONS (HTTP/2)
// ============================================================================

async function sendPushToClass(className, changesCount, customMessage = null) {
  const deviceTokens = await kv.get(`class:${className}`);
  
  if (!deviceTokens || !Array.isArray(deviceTokens)) {
    console.log(`⚠️ No devices for ${className}`);
    return;
  }
  
  console.log(`📤 Sending push to ${deviceTokens.length} devices`);
  
  for (const deviceToken of deviceTokens) {
    try {
      await sendPushNotificationHTTP2(deviceToken, changesCount, customMessage);
    } catch (error) {
      console.error(`❌ Push failed for ${deviceToken.substring(0, 10)}:`, error.message);
    }
  }
}

async function sendPushNotificationHTTP2(deviceToken, changesCount, customMessage = null) {
  return new Promise((resolve, reject) => {
    try {
      const jwtToken = createAPNsJWT();
      
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
      
      const payloadString = JSON.stringify(payload);
      
      const client = http2.connect(`https://${CONFIG.APNS_HOST}`);
      
      client.on('error', (err) => {
        console.error('❌ HTTP/2 client error:', err);
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
        
        req.on('data', (chunk) => {
          responseData += chunk;
        });
        
        req.on('end', () => {
          client.close();
          
          if (statusCode === 200) {
            console.log(`✅ Push sent to ${deviceToken.substring(0, 10)}`);
            resolve();
          } else {
            console.error(`❌ APNs error: ${statusCode} - ${responseData}`);
            
            if (statusCode === 410) {
              removeDeviceToken(deviceToken).catch(console.error);
              console.log(`🗑️ Removed invalid token`);
            }
            
            reject(new Error(`APNs error: ${statusCode}`));
          }
        });
      });
      
      req.on('error', (err) => {
        console.error('❌ Request error:', err);
        client.close();
        reject(err);
      });
      
      req.write(payloadString);
      req.end();
      
    } catch (error) {
      console.error('❌ Push error:', error);
      reject(error);
    }
  });
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
  
  let privateKey = process.env.APNS_PRIVATE_KEY;
  
  if (!privateKey.includes('\n') && privateKey.includes('\\n')) {
    privateKey = privateKey.replace(/\\n/g, '\n');
  }
  
  if (!privateKey.includes('\n')) {
    privateKey = privateKey
      .replace('-----BEGIN PRIVATE KEY-----', '-----BEGIN PRIVATE KEY-----\n')
      .replace('-----END PRIVATE KEY-----', '\n-----END PRIVATE KEY-----');
  }
  
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
  
  const patterns = [
    /Stand:\s*\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}/gi,
    /generiert.*?\d{2}\.\d{2}\.\d{4}/gi,
    /\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2}/gi,
    /Periode\d+\s+\d{1,2}\.\d{1,2}\.\d{4}.*?Zwischenplan/gi,
    /\d{1,2}\.\d{1,2}\.\d{4}/g,
    /<meta name="GENERATOR"[^>]*>/gi,
    /<title>.*?<\/title>/gi,
  ];
  
  for (const pattern of patterns) {
    normalized = normalized.replace(pattern, '');
  }
  
  return normalized.replace(/\s+/g, ' ').trim();
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
