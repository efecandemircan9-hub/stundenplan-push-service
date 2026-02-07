// api/admin-status.js
// Admin Endpoint - Zeigt alle registrierten Geräte und Klassen

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  try {
    const { adminKey, details } = req.query;
    
    // ============================================================
    // SICHERHEITSCHECK (Optional)
    // ============================================================
    const ADMIN_KEY = process.env.ADMIN_KEY || 'your-secret-key';
    
    if (adminKey && adminKey !== ADMIN_KEY) {
      return res.status(403).json({
        error: 'Unauthorized - Invalid admin key',
      });
    }
    
    // ============================================================
    // SAMMLE DATEN
    // ============================================================
    const deviceKeys = await kv.keys('device:*');
    const classKeys = await kv.keys('class:*');
    const cacheKeys = await kv.keys('cache:*');
    const metaKeys = await kv.keys('meta:*');
    
    // ============================================================
    // DETAILLIERTE INFOS (Optional)
    // ============================================================
    let deviceList = [];
    let classList = [];
    let cacheList = [];
    let metaData = {};
    
    if (details === 'true' || details === '1') {
      // Devices
      for (const key of deviceKeys) {
        const data = await kv.get(key);
        let device = typeof data === 'string' ? JSON.parse(data) : data;
        deviceList.push({
          token: key.replace('device:', '').substring(0, 20) + '...',
          className: device.className,
          username: device.username,
          registeredAt: device.registeredAt,
        });
      }
      
      // Classes
      for (const key of classKeys) {
        const tokens = await kv.get(key);
        classList.push({
          className: key.replace('class:', ''),
          deviceCount: Array.isArray(tokens) ? tokens.length : 0,
          tokens: Array.isArray(tokens) 
            ? tokens.map(t => t.substring(0, 20) + '...') 
            : [],
        });
      }
      
      // Caches
      for (const key of cacheKeys) {
        const data = await kv.get(key);
        let cache = typeof data === 'string' ? JSON.parse(data) : data;
        cacheList.push({
          key: key.replace('cache:', ''),
          redCount: cache.redCount,
          updatedAt: cache.updatedAt,
          testMode: cache.testMode || false,
        });
      }
      
      // Meta
      for (const key of metaKeys) {
        const value = await kv.get(key);
        metaData[key.replace('meta:', '')] = value;
      }
    }
    
    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      summary: {
        devices: deviceKeys.length,
        classes: classKeys.length,
        caches: cacheKeys.length,
        meta: metaKeys.length,
        total: deviceKeys.length + classKeys.length + cacheKeys.length + metaKeys.length,
      },
      details: details === 'true' || details === '1' ? {
        devices: deviceList,
        classes: classList,
        caches: cacheList,
        meta: metaData,
      } : undefined,
      actions: {
        viewDetails: '?details=true',
        clearAll: 'POST /api/admin-clear with body: {"confirm": "DELETE_ALL", "adminKey": "..."}',
      },
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({
      error: error.message,
    });
  }
}
