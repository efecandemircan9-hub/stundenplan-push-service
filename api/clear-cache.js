// api/clear-cache.js
// Löscht Cache für bestimmte Klassen oder alle Klassen

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const { className, adminKey, clearAll } = req.body;
    
    // Security check
    const ADMIN_KEY = process.env.ADMIN_KEY || 'your-secret-key';
    if (adminKey !== ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    console.log('🗑️ Cache clearing request...');
    
    if (clearAll) {
      // Lösche ALLE Caches
      console.log('🗑️ Clearing ALL caches...');
      
      const cacheKeys = await kv.keys('cache:*');
      console.log(`📦 Found ${cacheKeys.length} cache entries`);
      
      let deleted = 0;
      const deletedCaches = [];
      
      for (const key of cacheKeys) {
        await kv.del(key);
        deleted++;
        deletedCaches.push(key.replace('cache:', ''));
      }
      
      console.log(`✅ Deleted ${deleted} cache entries`);
      
      return res.status(200).json({
        success: true,
        message: 'All caches cleared',
        deleted: deleted,
        caches: deletedCaches,
      });
      
    } else if (className) {
      // Lösche Cache für eine spezifische Klasse
      console.log(`🗑️ Clearing cache for class: ${className}`);
      
      const cacheKey = `cache:${className}`;
      const cacheData = await kv.get(cacheKey);
      
      if (!cacheData) {
        console.log(`⚠️ No cache found for ${className}`);
        return res.status(404).json({
          success: false,
          error: 'No cache found for this class',
          className: className,
        });
      }
      
      await kv.del(cacheKey);
      console.log(`✅ Cache cleared for ${className}`);
      
      return res.status(200).json({
        success: true,
        message: 'Cache cleared',
        className: className,
      });
      
    } else {
      return res.status(400).json({
        error: 'Missing parameter',
        usage: 'POST /api/clear-cache with { className: "2I25A", adminKey: "5757" } OR { clearAll: true, adminKey: "5757" }',
      });
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({
      error: error.message,
    });
  }
}
