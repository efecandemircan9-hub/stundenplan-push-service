// api/test-push.js
// Test Endpoint - Simuliert eine Stundenplan-Änderung

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const { className, action } = req.method === 'POST' ? req.body : req.query;
    
    if (!className) {
      return res.status(400).json({ 
        error: 'Missing className parameter',
        usage: 'POST /api/test-push with body: {"className": "2I25A", "action": "simulate"}',
      });
    }
    
    // Aktuelle Woche
    const week = getWeekNumber(new Date());
    const cacheKey = `cache:${className}:w${week}`;
    
    if (action === 'clear') {
      // Cache löschen (für Fresh Start)
      await kv.del(cacheKey);
      
      return res.status(200).json({
        success: true,
        message: `Cache cleared for ${className}`,
        action: 'cleared',
      });
    }
    
    // Standard: Simuliere Änderung
    const cachedData = await kv.get(cacheKey);
    
    if (!cachedData) {
      return res.status(400).json({
        error: `No cache found for ${className}`,
        hint: 'Run /api/check-stundenplan first to create initial cache',
      });
    }
    
    // Parse cache
    let cached;
    if (typeof cachedData === 'string') {
      cached = JSON.parse(cachedData);
    } else {
      cached = cachedData;
    }
    
    const oldHash = cached.hash;
    const oldRedCount = cached.redCount || 0;
    
    // Ändere Hash (simuliere Änderung)
    const newHash = oldHash + 12345; // Einfach anders machen
    const newRedCount = oldRedCount + 4; // Simuliere 1 neuen Ausfall (+4 weil 4 rote Einträge)
    
    // Speichere modifizierten Cache
    const modifiedCache = {
      hash: newHash,
      redCount: newRedCount,
      updatedAt: new Date().toISOString(),
      testMode: true, // Markierung dass es ein Test ist
    };
    
    await kv.set(cacheKey, modifiedCache);
    
    console.log(`🧪 Test: Modified cache for ${className}`);
    console.log(`   Old hash: ${oldHash} → New hash: ${newHash}`);
    console.log(`   Old red count: ${oldRedCount} → New red count: ${newRedCount}`);
    
    return res.status(200).json({
      success: true,
      message: `Cache modified for ${className}`,
      action: 'simulated',
      details: {
        className,
        week,
        oldHash,
        newHash,
        oldRedCount,
        newRedCount,
        expectedChanges: 1,
      },
      nextSteps: [
        '1. Wait 15 minutes for cron-job.org to trigger',
        '2. Or manually call: curl .../api/check-stundenplan',
        '3. Push notification should be sent!',
        '4. Check logs in Vercel Dashboard',
      ],
    });
    
  } catch (error) {
    console.error('❌ Test error:', error);
    return res.status(500).json({
      error: error.message,
    });
  }
}

function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}
