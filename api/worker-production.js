/**
 * Cloudflare Worker - Stundenplan Push Notification Service
 * Production Ready Version
 */

import jwt from '@tsndr/cloudflare-worker-jwt';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  BKB_BASE_URL: 'https://stundenplan.bkb.nrw',
  MAPPING_URL: 'https://raw.githubusercontent.com/efecandemircan9-hub/BKBMapping/refs/heads/main/mapping.json',
  APNS_URL: 'https://api.push.apple.com', // Production
  // APNS_URL: 'https://api.sandbox.push.apple.com', // Development - ÄNDERN FALLS TESTING!
  APNS_TOPIC: 'nrw.bkb.stundenplan', // Bundle ID
  CHECK_INTERVAL: 15, // Minuten
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    try {
      if (url.pathname === '/register' && request.method === 'POST') {
        return await handleRegister(request, env, corsHeaders);
      }
      
      if (url.pathname === '/unregister' && request.method === 'POST') {
        return await handleUnregister(request, env, corsHeaders);
      }
      
      if (url.pathname === '/check') {
        return await handleCheck(env, corsHeaders);
      }
      
      if (url.pathname === '/status') {
        return await handleStatus(env, corsHeaders);
      }
      
      // API Info
      return new Response(JSON.stringify({
        service: 'BKB Stundenplan Push Service',
        version: '1.0.0',
        status: 'running',
        endpoints: {
          'POST /register': 'Register device token (body: {deviceToken, className, username})',
          'POST /unregister': 'Unregister device token (body: {deviceToken})',
          'GET /check': 'Manually trigger check',
          'GET /status': 'Service status',
        },
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
      
    } catch (error) {
      console.error('Error:', error);
      return new Response(JSON.stringify({
        error: error.message,
        stack: error.stack,
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
  
  async scheduled(event, env, ctx) {
    console.log('⏰ Cron job started');
    try {
      await checkStundenplanForAllUsers(env);
      console.log('✅ Cron job completed');
    } catch (error) {
      console.error('❌ Cron job failed:', error);
    }
  },
};

// ============================================================================
// HANDLERS
// ============================================================================

async function handleRegister(request, env, corsHeaders) {
  const data = await request.json();
  const { deviceToken, className, username } = data;
  
  if (!deviceToken || !className || !username) {
    return new Response(JSON.stringify({
      error: 'Missing required fields: deviceToken, className, username',
    }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  
  const device = {
    deviceToken,
    className,
    username,
    registeredAt: new Date().toISOString(),
  };
  
  await env.DEVICES.put(`device:${deviceToken}`, JSON.stringify(device));
  
  const classDevicesKey = `class:${className}`;
  let classDevices = [];
  const existing = await env.DEVICES.get(classDevicesKey);
  if (existing) {
    classDevices = JSON.parse(existing);
  }
  
  if (!classDevices.includes(deviceToken)) {
    classDevices.push(deviceToken);
    await env.DEVICES.put(classDevicesKey, JSON.stringify(classDevices));
  }
  
  console.log(`✅ Registered: ${className} - ${deviceToken.substring(0, 10)}...`);
  
  return new Response(JSON.stringify({
    success: true,
    message: 'Device registered successfully',
    className,
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function handleUnregister(request, env, corsHeaders) {
  const data = await request.json();
  const { deviceToken } = data;
  
  if (!deviceToken) {
    return new Response(JSON.stringify({ error: 'Missing deviceToken' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  
  const deviceData = await env.DEVICES.get(`device:${deviceToken}`);
  if (deviceData) {
    const device = JSON.parse(deviceData);
    const classDevicesKey = `class:${device.className}`;
    const existing = await env.DEVICES.get(classDevicesKey);
    if (existing) {
      let classDevices = JSON.parse(existing);
      classDevices = classDevices.filter(t => t !== deviceToken);
      await env.DEVICES.put(classDevicesKey, JSON.stringify(classDevices));
    }
  }
  
  await env.DEVICES.delete(`device:${deviceToken}`);
  console.log(`✅ Unregistered: ${deviceToken.substring(0, 10)}...`);
  
  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function handleCheck(env, corsHeaders) {
  await checkStundenplanForAllUsers(env);
  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function handleStatus(env, corsHeaders) {
  const list = await env.DEVICES.list({ prefix: 'device:' });
  const deviceCount = list.keys.length;
  const lastCheck = await env.DEVICES.get('meta:lastCheck');
  
  return new Response(JSON.stringify({
    status: 'operational',
    devices: deviceCount,
    lastCheck: lastCheck || 'never',
    config: {
      checkInterval: `${CONFIG.CHECK_INTERVAL} minutes`,
      apnsEnvironment: CONFIG.APNS_URL.includes('sandbox') ? 'development' : 'production',
    },
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ============================================================================
// STUNDENPLAN CHECKING
// ============================================================================

async function checkStundenplanForAllUsers(env) {
  console.log('🔍 Checking all classes...');
  await env.DEVICES.put('meta:lastCheck', new Date().toISOString());
  
  const classList = await env.DEVICES.list({ prefix: 'class:' });
  const classes = classList.keys.map(k => k.name.replace('class:', ''));
  
  console.log(`📚 Classes: ${classes.length}`);
  
  const mappingResponse = await fetch(CONFIG.MAPPING_URL);
  const mapping = await mappingResponse.json();
  
  for (const className of classes) {
    try {
      await checkStundenplanForClass(env, className, mapping);
    } catch (error) {
      console.error(`❌ Error checking ${className}:`, error);
    }
  }
}

async function checkStundenplanForClass(env, className, mapping) {
  const slug = mapping[className];
  if (!slug) return;
  
  const week = getWeekNumber(new Date());
  const weekFormatted = String(week).padStart(2, '0');
  const url = `${CONFIG.BKB_BASE_URL}/schueler/${weekFormatted}/c/${slug}`;
  
  const response = await fetch(url);
  if (!response.ok) return;
  
  const htmlText = await response.text();
  const normalizedHTML = normalizeHTML(htmlText);
  const newHash = hashString(normalizedHTML);
  
  const cacheKey = `cache:${className}:w${week}`;
  const cachedData = await env.DEVICES.get(cacheKey);
  
  if (!cachedData) {
    await env.DEVICES.put(cacheKey, JSON.stringify({
      hash: newHash,
      redCount: countRedEntries(htmlText),
      updatedAt: new Date().toISOString(),
    }));
    console.log(`ℹ️ ${className}: First check`);
    return;
  }
  
  const cached = JSON.parse(cachedData);
  
  if (cached.hash === newHash) {
    console.log(`✅ ${className}: No changes`);
    return;
  }
  
  const oldRedCount = cached.redCount || 0;
  const newRedCount = countRedEntries(htmlText);
  
  if (newRedCount > oldRedCount) {
    const difference = Math.max(1, Math.floor((newRedCount - oldRedCount) / 4));
    console.log(`🚨 ${className}: ${difference} changes!`);
    
    await sendPushToClass(env, className, difference);
    
    await env.DEVICES.put(cacheKey, JSON.stringify({
      hash: newHash,
      redCount: newRedCount,
      updatedAt: new Date().toISOString(),
    }));
  } else {
    console.log(`✅ ${className}: Hash different but no new cancellations`);
  }
}

// ============================================================================
// PUSH NOTIFICATIONS
// ============================================================================

async function sendPushToClass(env, className, changesCount) {
  const classDevicesData = await env.DEVICES.get(`class:${className}`);
  if (!classDevicesData) return;
  
  const deviceTokens = JSON.parse(classDevicesData);
  console.log(`📤 Sending to ${deviceTokens.length} devices`);
  
  for (const deviceToken of deviceTokens) {
    try {
      await sendPushNotification(env, deviceToken, changesCount);
    } catch (error) {
      console.error(`❌ Push failed for ${deviceToken.substring(0, 10)}:`, error);
    }
  }
}

async function sendPushNotification(env, deviceToken, changesCount) {
  const jwtToken = await createAPNsJWT(env);
  
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
    
    if (response.status === 410) {
      await env.DEVICES.delete(`device:${deviceToken}`);
      console.log(`🗑️ Removed invalid token`);
    }
  }
}

async function createAPNsJWT(env) {
  const now = Math.floor(Date.now() / 1000);
  
  const header = {
    alg: 'ES256',
    kid: env.APNS_KEY_ID,
  };
  
  const payload = {
    iss: env.APNS_TEAM_ID,
    iat: now,
  };
  
  // Private Key muss im PEM Format sein
  const privateKey = env.APNS_PRIVATE_KEY;
  
  const token = await jwt.sign({ header, payload }, privateKey);
  return token;
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
