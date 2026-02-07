// api/admin-tokens.js
// Zeigt vollständige Device Tokens (nicht gekürzt)

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  try {
    const { adminKey, className } = req.query;
    
    // Security check
    const ADMIN_KEY = process.env.ADMIN_KEY || 'your-secret-key';
    if (adminKey !== ADMIN_KEY) {
      return res.status(403).json({
        error: 'Unauthorized - Invalid admin key',
      });
    }
    
    // ============================================================
    // HOLE ALLE DEVICE TOKENS (VOLLSTÄNDIG)
    // ============================================================
    
    const deviceKeys = await kv.keys('device:*');
    
    let devices = [];
    
    for (const key of deviceKeys) {
      const deviceToken = key.replace('device:', '');
      const data = await kv.get(key);
      let device = typeof data === 'string' ? JSON.parse(data) : data;
      
      // Filter nach Klasse (optional)
      if (className && device.className !== className) {
        continue;
      }
      
      devices.push({
        deviceToken: deviceToken,  // ← Vollständig!
        className: device.className,
        username: device.username,
        registeredAt: device.registeredAt,
      });
    }
    
    return res.status(200).json({
      success: true,
      count: devices.length,
      devices: devices,
      note: 'Device tokens are shown in full - keep them secret!',
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({
      error: error.message,
    });
  }
}
