// api/cleanup-tokens.js
// Prüft alle Device Tokens und entfernt ungültige (OHNE Push zu senden)

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
  
  try {
    const { adminKey, dryRun } = req.query;
    
    // Security check
    const ADMIN_KEY = process.env.ADMIN_KEY || 'your-secret-key';
    if (adminKey !== ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const isDryRun = dryRun === 'true' || dryRun === '1';
    
    console.log(`🧹 Starting token cleanup... ${isDryRun ? '(DRY RUN)' : ''}`);
    
    // Hole alle Device Keys
    const deviceKeys = await kv.keys('device:*');
    console.log(`📱 Found ${deviceKeys.length} device(s) to check`);
    
    const results = {
      total: deviceKeys.length,
      valid: 0,
      invalid: 0,
      errors: 0,
      removed: [],
      dryRun: isDryRun,
    };
    
    for (const key of deviceKeys) {
      const deviceToken = key.replace('device:', '');
      
      try {
        const validityCheck = await checkTokenValidity(deviceToken);
        
        if (validityCheck.isValid) {
          console.log(`✅ ${deviceToken.substring(0, 20)}... is valid (${validityCheck.status})`);
          results.valid++;
        } else {
          console.log(`❌ ${deviceToken.substring(0, 20)}... is invalid (${validityCheck.status}) - ${isDryRun ? 'would remove' : 'removing'}`);
          
          if (!isDryRun) {
            await removeDeviceToken(deviceToken);
          }
          
          results.invalid++;
          results.removed.push({
            token: deviceToken.substring(0, 20) + '...',
            reason: validityCheck.reason,
          });
        }
      } catch (error) {
        console.error(`⚠️ Error checking ${deviceToken.substring(0, 20)}:`, error.message);
        results.errors++;
      }
    }
    
    console.log(`✅ Cleanup complete: ${results.valid} valid, ${results.invalid} invalid, ${results.errors} errors`);
    
    return res.status(200).json({
      success: true,
      message: isDryRun ? 'Dry run complete (no changes made)' : 'Token cleanup complete',
      results,
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({
      error: error.message,
    });
  }
}

// Prüft ob ein Token noch gültig ist OHNE Push zu senden
async function checkTokenValidity(deviceToken) {
  return new Promise((resolve) => {
    try {
      const jwtToken = createAPNsJWT();
      
      // WICHTIG: Wir senden einen EMPTY Push Body
      // APNs wird die Validierung trotzdem durchführen
      // Aber KEIN Push wird zugestellt (kein aps)
      const payload = {};
      
      const payloadString = JSON.stringify(payload);
      
      const client = http2.connect(`https://${CONFIG.APNS_HOST}`);
      
      let resolved = false;
      
      // Timeout nach 3 Sekunden
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          client.close();
          console.log(`   ⏱️ Timeout - assuming valid`);
          resolve({ 
            isValid: true, 
            status: 'timeout',
            reason: 'Request timed out'
          });
        }
      }, 3000);
      
      client.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          client.close();
          console.error(`   Connection error: ${err.message}`);
          resolve({ 
            isValid: true, 
            status: 'error',
            reason: err.message
          });
        }
      });
      
      const req = client.request({
        ':method': 'POST',
        ':scheme': 'https',
        ':path': `/3/device/${deviceToken}`,
        'authorization': `bearer ${jwtToken}`,
        'apns-topic': CONFIG.APNS_TOPIC,
        'apns-priority': '1',  // Niedrigste Priority
      });
      
      req.setEncoding('utf8');
      
      let responseData = '';
      
      req.on('response', (headers) => {
        const statusCode = headers[':status'];
        
        req.on('data', (chunk) => {
          responseData += chunk;
        });
        
        req.on('end', () => {
          clearTimeout(timeout);
          client.close();
          
          if (!resolved) {
            resolved = true;
            
            // Status Codes:
            // 200 = Success (Token gültig)
            // 400 = Bad request (meist payload-Problem, aber Token existiert)
            // 403 = Certificate/Topic-Problem (Token könnte gültig sein)
            // 410 = Token ungültig (App gelöscht oder deinstalliert)
            
            let parsedResponse = {};
            try {
              parsedResponse = JSON.parse(responseData);
            } catch {
              parsedResponse = { raw: responseData };
            }
            
            if (statusCode === 410) {
              console.log(`   📱 Token ungültig (410): ${JSON.stringify(parsedResponse)}`);
              resolve({ 
                isValid: false, 
                status: statusCode,
                reason: parsedResponse.reason || 'Unregistered'
              });
            } else if (statusCode === 200) {
              // Token ist gültig, Push wurde akzeptiert
              resolve({ 
                isValid: true, 
                status: statusCode,
                reason: 'Active'
              });
            } else if (statusCode === 400) {
              // Bad Request - könnte an unserem leeren Payload liegen
              // Token existiert aber, also gültig
              const reason = parsedResponse.reason || 'BadPayload';
              
              // Aber: "BadDeviceToken" bedeutet Token ist ungültig
              if (reason === 'BadDeviceToken') {
                resolve({ 
                  isValid: false, 
                  status: statusCode,
                  reason: reason
                });
              } else {
                // Anderer 400 Fehler - Token ist gültig
                resolve({ 
                  isValid: true, 
                  status: statusCode,
                  reason: reason
                });
              }
            } else {
              // Andere Status Codes - sicher ist sicher, als gültig markieren
              console.log(`   ⚠️ Unbekannter Status ${statusCode}: ${responseData}`);
              resolve({ 
                isValid: true, 
                status: statusCode,
                reason: parsedResponse.reason || 'Unknown'
              });
            }
          }
        });
      });
      
      req.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          client.close();
          console.error(`   Request error: ${err.message}`);
          resolve({ 
            isValid: true, 
            status: 'error',
            reason: err.message
          });
        }
      });
      
      // Sende leeren Body
      req.write(payloadString);
      req.end();
      
    } catch (error) {
      console.error(`   Check error: ${error.message}`);
      resolve({ 
        isValid: true, 
        status: 'error',
        reason: error.message
      });
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
    
    // Entferne von Klasse
    const classTokens = await kv.get(`class:${device.className}`) || [];
    const filtered = classTokens.filter(t => t !== deviceToken);
    await kv.set(`class:${device.className}`, filtered);
    
    console.log(`   Removed from class: ${device.className}`);
  }
  
  // Lösche Device Entry
  await kv.del(`device:${deviceToken}`);
}
