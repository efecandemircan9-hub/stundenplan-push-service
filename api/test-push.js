// api/test-push-v3.js
// Test Endpoint - Manipuliert gecachtes HTML um Änderungen zu simulieren

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  try {
    const { className, action, changeType } = req.method === 'POST' ? req.body : req.query;
    
    if (!className) {
      return res.status(400).json({ 
        error: 'Missing className parameter',
        usage: 'GET /api/test-push-v3?className=2I25A&changeType=add_cancellation',
        options: {
          changeType: ['add_cancellation', 'remove_cancellation', 'change_content', 'clear_cache'],
        },
      });
    }
    
    const week = getWeekNumber(new Date());
    const cacheKey = `cache:${className}:w${week}`;
    
    // ============================================================
    // AKTION: CACHE LÖSCHEN
    // ============================================================
    if (action === 'clear' || changeType === 'clear_cache') {
      await kv.del(cacheKey);
      
      return res.status(200).json({
        success: true,
        message: `✅ Cache cleared for ${className}`,
        className,
        week,
        nextStep: 'Run /api/check-stundenplan to create fresh cache',
      });
    }
    
    // ============================================================
    // CACHE LADEN
    // ============================================================
    const cachedData = await kv.get(cacheKey);
    
    if (!cachedData) {
      return res.status(400).json({
        error: `No cache found for ${className} in week ${week}`,
        hint: 'Run /api/check-stundenplan first to create initial cache',
        quickFix: 'curl https://stundenplan-push-service.vercel.app/api/check-stundenplan',
      });
    }
    
    let cached;
    if (typeof cachedData === 'string') {
      cached = JSON.parse(cachedData);
    } else {
      cached = cachedData;
    }
    
    const originalHTML = cached.normalizedHTML || '';
    const originalHash = cached.hash;
    const originalRedCount = cached.redCount || 0;
    
    if (!originalHTML) {
      return res.status(400).json({
        error: 'Cache does not contain normalizedHTML',
        hint: 'This cache was created with old version. Clear cache and recreate.',
      });
    }
    
    // ============================================================
    // ÄNDERUNG SIMULIEREN
    // ============================================================
    let modifiedHTML = originalHTML;
    let modifiedRedCount = originalRedCount;
    let changeDescription = '';
    
    const type = changeType || 'add_cancellation';
    
    switch (type) {
      case 'add_cancellation':
        // Füge rote Font-Tags hinzu (simuliert Stundenausfall)
        modifiedHTML = originalHTML + '<font color="#FF0000">TESTAUSFALL</font>'.repeat(4);
        modifiedRedCount = originalRedCount + 4; // +4 rote Tags = 1 Ausfall
        changeDescription = '1 Stundenausfall hinzugefügt';
        break;
        
      case 'add_multiple_cancellations':
        // Mehrere Ausfälle
        modifiedHTML = originalHTML + '<font color="#FF0000">TESTAUSFALL</font>'.repeat(12);
        modifiedRedCount = originalRedCount + 12; // +12 = 3 Ausfälle
        changeDescription = '3 Stundenausfälle hinzugefügt';
        break;
        
      case 'remove_cancellation':
        // Entferne rote Tags (wenn vorhanden)
        if (originalRedCount >= 4) {
          modifiedHTML = originalHTML.replace(/<font color="#FF0000">.*?<\/font>/i, '');
          modifiedRedCount = Math.max(0, originalRedCount - 4);
          changeDescription = '1 Stundenausfall entfernt';
        } else {
          return res.status(400).json({
            error: 'Keine Ausfälle zum Entfernen vorhanden',
            currentRedCount: originalRedCount,
          });
        }
        break;
        
      case 'change_content':
        // Ändere Inhalt ohne rote Tags (Raum/Lehrer-Änderung)
        modifiedHTML = originalHTML + ' RAUMÄNDERUNG: A123 → B456 ';
        modifiedRedCount = originalRedCount; // Gleich bleiben
        changeDescription = 'Raumänderung simuliert (ohne neue Ausfälle)';
        break;
        
      default:
        return res.status(400).json({
          error: `Unknown changeType: ${type}`,
          availableTypes: ['add_cancellation', 'add_multiple_cancellations', 'remove_cancellation', 'change_content'],
        });
    }
    
    // Berechne neuen Hash
    const modifiedHash = hashString(modifiedHTML);
    
    // ============================================================
    // SPEICHERE MODIFIZIERTEN CACHE
    // ============================================================
    const modifiedCache = {
      hash: modifiedHash,
      redCount: modifiedRedCount,
      normalizedHTML: modifiedHTML,
      updatedAt: new Date().toISOString(),
      testMode: true,
      testModification: {
        type,
        description: changeDescription,
        timestamp: new Date().toISOString(),
      },
    };
    
    await kv.set(cacheKey, modifiedCache);
    
    console.log(`🧪 TEST: Modified cache for ${className}`);
    console.log(`   Type: ${type}`);
    console.log(`   Old hash: ${originalHash} → New hash: ${modifiedHash}`);
    console.log(`   Old red: ${originalRedCount} → New red: ${modifiedRedCount}`);
    
    // ============================================================
    // VORHERSAGE: Was wird beim nächsten Check passieren?
    // ============================================================
    let prediction = '';
    let willPush = false;
    
    if (modifiedRedCount > originalRedCount) {
      const diff = modifiedRedCount - originalRedCount;
      const changes = Math.max(1, Math.floor(diff / 4));
      prediction = `✅ PUSH WIRD GESENDET: ${changes} ${changes === 1 ? 'Änderung' : 'Änderungen'}`;
      willPush = true;
    } else if (modifiedRedCount < originalRedCount) {
      prediction = `ℹ️  KEIN PUSH: Ausfälle wurden entfernt (Cache wird aktualisiert)`;
      willPush = false;
    } else if (modifiedHash !== originalHash) {
      prediction = `✅ PUSH WIRD GESENDET: Inhalt geändert (gleiche Anzahl Ausfälle)`;
      willPush = true;
    } else {
      prediction = `ℹ️  KEIN PUSH: Keine Änderungen erkannt`;
      willPush = false;
    }
    
    return res.status(200).json({
      success: true,
      message: `✅ Test prepared: ${changeDescription}`,
      className,
      week,
      modification: {
        type,
        description: changeDescription,
      },
      before: {
        hash: originalHash,
        redCount: originalRedCount,
      },
      after: {
        hash: modifiedHash,
        redCount: modifiedRedCount,
      },
      changes: {
        hashChanged: modifiedHash !== originalHash,
        redCountDifference: modifiedRedCount - originalRedCount,
      },
      prediction: {
        willSendPush: willPush,
        message: prediction,
      },
      nextSteps: [
        '📌 Cache wurde manipuliert',
        '',
        '🔄 NÄCHSTER SCHRITT:',
        '   curl https://stundenplan-push-service.vercel.app/api/check-stundenplan',
        '',
        prediction,
        '',
        willPush ? '📱 Check your iPhone for push notification!' : '💡 Cache wird aktualisiert, aber kein Push',
      ],
      quickCommands: {
        runCheck: 'curl https://stundenplan-push-service.vercel.app/api/check-stundenplan',
        clearCache: `curl "https://stundenplan-push-service.vercel.app/api/test-push-v3?className=${className}&action=clear"`,
        debug: `curl "https://stundenplan-push-service.vercel.app/api/debug?className=${className}"`,
      },
    });
    
  } catch (error) {
    console.error('❌ Test error:', error);
    return res.status(500).json({
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return hash;
}
