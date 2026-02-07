// api/test-push-now.js
// Einfacher Test - Sendet SOFORT einen Push an alle registrierten Geräte einer Klasse

import { kv } from '@vercel/kv';
import jwt from 'jsonwebtoken';

const CONFIG = {
  APNS_URL: process.env.APNS_ENVIRONMENT === 'sandbox' 
    ? 'https://api.sandbox.push.apple.com'
    : 'https://api.push.apple.com',
  APNS_TOPIC: 'nrw.bkb.stundenplan',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  try {
    const { className, adminKey } = req.method === 'POST' ? req.body : req.query;
    
    // Security
    const ADMIN_KEY = process.env.ADMIN_KEY || 'your-secret-key';
    if (adminKey !== ADMIN_KEY) {
      return res.status(403).json({
        error: 'Unauthorized',
      });
    }
    
    if (!className) {
      return res.status(400).json({
        error: 'Missing className',
        usage: 'GET /api/test-push-now?className=2I25A&adminKey=5757',
      });
    }
    
    console.log(`🧪 Test Push for class: ${className}`);
    
    // Hole alle Devices dieser Klasse
    const deviceTokens = await kv.get(`class:${className}`);
    
    if (!deviceTokens || !Array.isArray(deviceTokens) || deviceTokens.length === 0) {
      return res.status(404).json({
        error: `No devices found for class ${className}`,
        hint: 'Make sure devices are registered',
      });
    }
    
    console.log(`📱 Found ${deviceTokens.length} device(s)`);
    
    const results = [];
    
    for (const deviceToken of deviceTokens) {
      console.log(`📤 Sending push to: ${deviceToken.substring(0, 20)}...`);
      
      try {
        const result = await sendPush(deviceToken);
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
      apnsUrl: CONFIG.APNS_URL,
      results,
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({
      error: error.message,
    });
  }
}

async function sendPush(deviceToken) {
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
    
    console.log(`🔑 Original key length: ${privateKey?.length || 0}`);
    console.log(`🔑 Has \\n: ${privateKey?.includes('\\n')}`);
    console.log(`🔑 Has newline: ${privateKey?.includes('\n')}`);
    
    if (!privateKey) {
      throw new Error('APNS_PRIVATE_KEY is not set');
    }
    
    // Ersetze \n Strings mit echten Newlines
    if (!privateKey.includes('\n') && privateKey.includes('\\n')) {
      console.log('🔧 Converting \\n to newlines...');
      privateKey = privateKey.replace(/\\n/g, '\n');
    }
    
    // Falls immer noch keine Newlines, füge sie hinzu
    if (!privateKey.includes('\n')) {
      console.log('🔧 Adding newlines...');
      privateKey = privateKey
        .replace('-----BEGIN PRIVATE KEY-----', '-----BEGIN PRIVATE KEY-----\n')
        .replace('-----END PRIVATE KEY-----', '\n-----END PRIVATE KEY-----');
    }
    
    console.log(`✅ Formatted key has ${privateKey.split('\n').length} lines`);
    
    let jwtToken;
    try {
      jwtToken = jwt.sign(payload, privateKey, {
        algorithm: 'ES256',
        header,
      });
      console.log('✅ JWT token created');
    } catch (jwtError) {
      console.error('❌ JWT creation failed:', jwtError.message);
      throw new Error(`JWT creation failed: ${jwtError.message}`);
    }
    
    // Push senden
    const pushPayload = {
      aps: {
        alert: {
          title: 'Test Push 🧪',
          body: 'Wenn du das siehst, funktioniert Push! 🎉',
        },
        badge: 1,
        sound: 'default',
      },
    };
    
    const url = `${CONFIG.APNS_URL}/3/device/${deviceToken}`;
    console.log(`📤 Sending to: ${url.substring(0, 80)}...`);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'authorization': `bearer ${jwtToken}`,
        'apns-topic': CONFIG.APNS_TOPIC,
        'apns-priority': '10',
        'apns-push-type': 'alert',
      },
      body: JSON.stringify(pushPayload),
    });
    
    const statusCode = response.status;
    console.log(`📥 APNs Response: ${statusCode}`);
    
    if (statusCode === 200) {
      console.log(`✅ Push sent successfully`);
      return {
        success: true,
        statusCode: 200,
        message: 'Push sent successfully',
      };
    } else {
      const errorText = await response.text();
      console.error(`❌ APNs error ${statusCode}: ${errorText}`);
      
      let errorDetails = {};
      try {
        errorDetails = JSON.parse(errorText);
      } catch {
        errorDetails = { raw: errorText };
      }
      
      return {
        success: false,
        statusCode,
        error: errorDetails,
      };
    }
  } catch (error) {
    console.error('❌ Push error:', error);
    return {
      success: false,
      error: error.message,
      stack: error.stack,
    };
  }
}
