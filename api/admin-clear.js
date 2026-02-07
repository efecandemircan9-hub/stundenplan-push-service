// api/admin-clear.js
// Admin Endpoint - Löscht alle Klassen und Geräte

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return res.status(405).json({ 
      error: 'Method not allowed',
      allowedMethods: ['POST', 'DELETE'],
    });
  }
  
  try {
    const { confirm, adminKey } = req.method === 'POST' ? req.body : req.query;
    
    // ============================================================
    // SICHERHEITSCHECK (Optional - empfohlen!)
    // ============================================================
    const ADMIN_KEY = process.env.ADMIN_KEY || 'your-secret-key';
    
    if (adminKey !== ADMIN_KEY) {
      return res.status(403).json({
        error: 'Unauthorized - Invalid admin key',
        hint: 'Set ADMIN_KEY environment variable in Vercel',
      });
    }
    
    // ============================================================
    // BESTÄTIGUNG ERFORDERLICH
    // ============================================================
    if (confirm !== 'DELETE_ALL') {
      return res.status(400).json({
        error: 'Confirmation required',
        usage: 'POST /api/admin-clear',
        body: {
          confirm: 'DELETE_ALL',
          adminKey: 'your-secret-key'
        },
        warning: '⚠️  This will delete ALL devices, classes, and caches!',
      });
    }
    
    console.log('🗑️  Starting cleanup...');
    
    // ============================================================
    // SAMMLE ALLE KEYS
    // ============================================================
    const deviceKeys = await kv.keys('device:*');
    const classKeys = await kv.keys('class:*');
    const cacheKeys = await kv.keys('cache:*');
    const metaKeys = await kv.keys('meta:*');
    
    const totalKeys = deviceKeys.length + classKeys.length + cacheKeys.length + metaKeys.length;
    
    console.log(`📊 Found:`);
    console.log(`   ${deviceKeys.length} devices`);
    console.log(`   ${classKeys.length} classes`);
    console.log(`   ${cacheKeys.length} caches`);
    console.log(`   ${metaKeys.length} meta entries`);
    console.log(`   Total: ${totalKeys} keys`);
    
    // ============================================================
    // LÖSCHE ALLE KEYS
    // ============================================================
    let deletedCount = 0;
    let errors = [];
    
    const allKeys = [...deviceKeys, ...classKeys, ...cacheKeys, ...metaKeys];
    
    for (const key of allKeys) {
      try {
        await kv.del(key);
        deletedCount++;
      } catch (error) {
        errors.push({ key, error: error.message });
      }
    }
    
    console.log(`✅ Deleted ${deletedCount} keys`);
    
    if (errors.length > 0) {
      console.log(`⚠️  ${errors.length} errors occurred`);
    }
    
    return res.status(200).json({
      success: true,
      message: '✅ All data cleared successfully',
      summary: {
        devices: deviceKeys.length,
        classes: classKeys.length,
        caches: cacheKeys.length,
        meta: metaKeys.length,
        total: totalKeys,
        deleted: deletedCount,
        errors: errors.length,
      },
      errors: errors.length > 0 ? errors : undefined,
      timestamp: new Date().toISOString(),
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
}
