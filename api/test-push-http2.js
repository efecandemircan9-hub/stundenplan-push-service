// api/test-push-http2.js
// Test mit nativem http2 Modul (funktioniert mit APNs)

import http2 from 'http2';
import jwt from 'jsonwebtoken';
import { kv } from '@vercel/kv';

const CONFIG = {
  APNS_HOST: process.env.APNS_ENVIRONMENT === 'sandbox' 
    ? 'api.sandbox.push.apple.com'
    : 'api.push.apple.com',
  APNS_TOPIC: 'nrw.bkb.stundenplan',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  try {
    const { className, adminKey } = req.method === 'POST' ? req.body : req.query;
    
    // Security
    const ADMIN_KEY = process.env.ADMIN_KEY || 'your-secret-key';
    if (adminKey !== ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    if (!className) {
      return res.status(400).json({
        error: 'Missing className',
        usage: 'GET /api/test-push-http2?className=2I25A&adminKey=5757',
      });
    }
    
    console.log(`🧪 Test Push for class: ${className}`);
    
    // Hole alle Devices dieser Klasse
    const deviceTokens = await kv.get(`class:${className}`);
    
    if (!deviceTokens || !Array.isArray(deviceTokens) || deviceTokens.length === 0) {
      return res.status(404).json({
        error: `No devices found for class ${className}`,
      });
    }
    
    console.log(`📱 Found ${deviceTokens.length} device(s)`);
    
    const results = [];
    
    for (const deviceToken of deviceTokens) {
      console.log(`📤 Sending push to: ${deviceToken.substring(0, 20)}...`);
      
      try {
        const result = await sendPushHTTP2(deviceToken);
        results.push({
          deviceToken: deviceToken.substring(0, 20) + '...',
          ...result,
        });
      } catch (error) {
        results.push({
          deviceToken: deviceToken.substring(0, 20) + '...',
          success: false,
          error: error.message,
        });
      }
    }
    
    const successCount = results.filter(r => r.success).length;
    
    return res.status(200).json({
      success: successCount > 0,
      message: `Sent ${successCount}/${results.length} push notifications`,
      className,
      environment: process.env.APNS_ENVIRONMENT || 'sandbox',
      results,
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({
      error: error.message,
      stack: error.stack,
    });
  }
}

async function sendPushHTTP2(deviceToken) {
  return new Promise((resolve, reject) => {
    try {
      // JWT Token erstellen
      const now = Math.floor(Date.now() / 1000);
      
      const payload = {
        iss: process.env.APNS_TEAM_ID,
        iat: now,
      };
      
      const header = {
        alg: 'ES256',
        kid: process.env.APNS_KEY_ID,
      };
      
      // Private Key formatieren
      let privateKey = process.env.APNS_PRIVATE_KEY;
      
      if (!privateKey.includes('\n') && privateKey.includes('\\n')) {
        privateKey = privateKey.replace(/\\n/g, '\n');
      }
      
      if (!privateKey.includes('\n')) {
        privateKey = privateKey
          .replace('-----BEGIN PRIVATE KEY-----', '-----BEGIN PRIVATE KEY-----\n')
          .replace('-----END PRIVATE KEY-----', '\n-----END PRIVATE KEY-----');
      }
      
      const jwtToken = jwt.sign(payload, privateKey, {
        algorithm: 'ES256',
        header,
      });
      
      console.log('✅ JWT token created');
      
      // Push Payload
      const pushPayload = {
        aps: {
          alert: {
            title: 'Test Push 🧪',
            body: 'HTTP/2 funktioniert! 🎉',
          },
          badge: 1,
          sound: 'default',
        },
      };
      
      const payloadString = JSON.stringify(pushPayload);
      
      // HTTP/2 Client erstellen
      const client = http2.connect(`https://${CONFIG.APNS_HOST}`);
      
      client.on('error', (err) => {
        console.error('❌ HTTP/2 client error:', err);
        client.close();
        reject(err);
      });
      
      // Request erstellen
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
        
        req.on('data', (chunk) => {
          responseData += chunk;
        });
        
        req.on('end', () => {
          client.close();
          
          if (statusCode === 200) {
            console.log('✅ Push sent successfully');
            resolve({
              success: true,
              statusCode: 200,
              message: 'Push sent successfully',
            });
          } else {
            console.error(`❌ APNs error ${statusCode}: ${responseData}`);
            
            let errorDetails = {};
            try {
              errorDetails = JSON.parse(responseData);
            } catch {
              errorDetails = { raw: responseData };
            }
            
            resolve({
              success: false,
              statusCode,
              error: errorDetails,
            });
          }
        });
      });
      
      req.on('error', (err) => {
        console.error('❌ Request error:', err);
        client.close();
        reject(err);
      });
      
      // Sende Payload
      req.write(payloadString);
      req.end();
      
    } catch (error) {
      console.error('❌ Push error:', error);
      reject(error);
    }
  });
}
