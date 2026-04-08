// api/broadcast-push.js
// Sendet eine benutzerdefinierte Push-Nachricht an alle Geräte

import { kv } from '@vercel/kv';
import jwt from 'jsonwebtoken';
import http2 from 'http2';

const CONFIG = {
  APNS_HOST: process.env.APNS_ENVIRONMENT === 'sandbox' 
    ? 'api.sandbox.push.apple.com'
    : 'api.push.apple.com',
  APNS_TOPIC: 'nrw.bkb',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed - use POST' });
  }
  
  try {
    const { adminKey, title, message, badge, className } = req.body;
    
    // Security check
    const ADMIN_KEY = process.env.ADMIN_KEY || 'your-secret-key';
    if (adminKey !== ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    if (!title || !message) {
      return res.status(400).json({
        error: 'Missing required fields',
        usage: 'POST with { adminKey: "5757", title: "Title", message: "Message", badge: 1, className: "2I25A" (optional) }',
      });
    }
    
    console.log('📢 Broadcasting push notification...');
    console.log(`   Title: ${title}`);
    console.log(`   Message: ${message}`);
    
    // Hole alle Device Tokens
    let deviceTokens = [];
    
    if (className) {
      // Nur für eine spezifische Klasse
      console.log(`   Target: Class ${className}`);
      const classTokens = await kv.get(`class:${className}`);
      if (classTokens && Array.isArray(classTokens)) {
        deviceTokens = classTokens;
      }
    } else {
      // Alle Geräte
      console.log('   Target: All devices');
      const deviceKeys = await kv.keys('device:*');
      
      for (const key of deviceKeys) {
        const token = key.replace('device:', '');
        deviceTokens.push(token);
      }
    }
    
    if (deviceTokens.length === 0) {
      return res.status(404).json({
        error: 'No devices found',
        className: className || 'all',
      });
    }
    
    console.log(`   Sending to ${deviceTokens.length} devices...`);
    
    // Sende Push an alle Geräte
    const results = {
      total: deviceTokens.length,
      successful: 0,
      failed: 0,
      errors: [],
    };
    
    for (const deviceToken of deviceTokens) {
      try {
        await sendPushNotification(deviceToken, title, message, badge || 1);
        results.successful++;
      } catch (error) {
        results.failed++;
        results.errors.push({
          token: deviceToken.substring(0, 20) + '...',
          error: error.message,
        });
      }
    }
    
    console.log(`✅ Broadcast complete: ${results.successful}/${results.total} successful`);
    
    return res.status(200).json({
      success: true,
      message: 'Broadcast sent',
      results: results,
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({
      error: error.message,
    });
  }
}

// ============================================================================
// PUSH NOTIFICATION (HTTP/2)
// ============================================================================

async function sendPushNotification(deviceToken, title, message, badge) {
  return new Promise((resolve, reject) => {
    try {
      const jwtToken = createAPNsJWT();
      
      const payload = {
        aps: {
          alert: {
            title: title,
            body: message,
          },
          badge: badge,
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
              console.log(`🗑️ Token invalid - removing ${deviceToken.substring(0, 10)}`);
              removeDeviceToken(deviceToken).catch(err => {
                console.error('Failed to remove token:', err);
              });
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
  try {
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
  } catch (error) {
    console.error('Error removing device token:', error);
  }
}
