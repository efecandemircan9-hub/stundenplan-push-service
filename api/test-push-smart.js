// api/test-push-smart.js
// Intelligenter Test - Setzt Cache niedriger als Server-Realität

import { kv } from '@vercel/kv';

const CONFIG = {
  BKB_BASE_URL: 'https://stundenplan.bkb.nrw',
  MAPPING_URL: 'https://raw.githubusercontent.com/efecandemircan9-hub/BKBMapping/refs/heads/main/mapping.json',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  try {
    const { className, action } = req.method === 'POST' ? req.body : req.query;
    
    if (!className) {
      return res.status(400).json({ 
        error: 'Missing className parameter',
        usage: 'GET /api/test-push-smart?className=2I25A',
      });
    }
    
    const week = getWeekNumber(new Date());
    const cacheKey = `cache:${className}:w${week}`;
    
    // ============================================================
    // CACHE LÖSCHEN
    // ============================================================
    if (action === 'clear') {
      await kv.del(cacheKey);
      return res.status(200).json({
        success: true,
        message: `✅ Cache cleared for ${className}`,
      });
    }
    
    // ============================================================
    // LADE ECHTES HTML VOM SERVER
    // ============================================================
    console.log('📥 Loading real HTML from server...');
    
    const mappingResponse = await fetch(CONFIG.MAPPING_URL);
    const mapping = await mappingResponse.json();
    
    const slug = mapping[className];
    if (!slug) {
      return res.status(404).json({
        error: `No slug found for ${className}`,
      });
    }
    
    const weekFormatted = String(week).padStart(2, '0');
    const url = `${CONFIG.BKB_BASE_URL}/schueler/${weekFormatted}/c/${slug}`;
    
    const username = 'schueler';
    const password = 'stundenplan';
    const basicAuth = 'Basic ' + btoa(username + ':' + password);
    
    const response = await fetch(url, {
      headers: { 'Authorization': basicAuth },
    });
    
    if (!response.ok) {
      return res.status(500).json({
        error: `Failed to fetch: ${response.status}`,
      });
    }
    
    const htmlText = await response.text();
    
    // ============================================================
    // ANALYSIERE SERVER-HTML
    // ============================================================
    const normalizedHTML = normalizeHTML(htmlText);
    const serverHash = hashString(normalizedHTML);
    const serverRedCount = countRedEntries(htmlText);
    
    console.log(`📊 Server has ${serverRedCount} red entries`);
    
    // ============================================================
    // ERSTELLE CACHE MIT WENIGER ROTEN EINTRÄGEN
    // ============================================================
    
    // Simuliere: Cache ist älter und hatte weniger Ausfälle
    const reducedRedCount = Math.max(0, serverRedCount - 8); // -8 = 2 Ausfälle weniger
    
    // Modifiziere HTML: Entferne einige rote Tags
    let modifiedHTML = normalizedHTML;
    for (let i = 0; i < 8; i++) {
      modifiedHTML = modifiedHTML.replace(/<font[^>]*color=["']#?FF0000["'][^>]*>.*?<\/font>/i, '');
    }
    
    const modifiedHash = hashString(modifiedHTML);
    
    const fakeCache = {
      hash: modifiedHash,
      redCount: reducedRedCount,
      normalizedHTML: modifiedHTML,
      updatedAt: new Date(Date.now() - 3600000).toISOString(), // 1 Stunde alt
      testMode: true,
      testNote: 'Cache wurde künstlich mit weniger roten Einträgen erstellt',
    };
    
    await kv.set(cacheKey, fakeCache);
    
    console.log(`✅ Created fake cache with ${reducedRedCount} red entries`);
    
    // ============================================================
    // VORHERSAGE
    // ============================================================
    const difference = serverRedCount - reducedRedCount;
    const expectedChanges = Math.max(1, Math.floor(difference / 4));
    
    return res.status(200).json({
      success: true,
      message: '✅ Smart test prepared!',
      className,
      week,
      server: {
        redCount: serverRedCount,
        hash: serverHash,
      },
      cache: {
        redCount: reducedRedCount,
        hash: modifiedHash,
      },
      simulation: {
        difference: difference,
        expectedChanges: expectedChanges,
        description: `Cache hat ${difference} rote Einträge WENIGER als Server`,
      },
      prediction: {
        willSendPush: true,
        message: `✅ PUSH WIRD GESENDET: ${expectedChanges} ${expectedChanges === 1 ? 'Änderung' : 'Änderungen'}`,
        pushMessage: `${expectedChanges} ${expectedChanges === 1 ? 'Stunde wurde' : 'Stunden wurden'} geändert oder ${expectedChanges === 1 ? 'fällt' : 'fallen'} aus.`,
      },
      nextSteps: [
        '📌 Cache wurde mit WENIGER roten Einträgen als Server erstellt',
        '',
        '🔄 NÄCHSTER SCHRITT:',
        '   curl https://stundenplan-push-service.vercel.app/api/check-stundenplan',
        '',
        `✅ SERVER HAT MEHR: ${serverRedCount} red entries`,
        `📦 CACHE HAT WENIGER: ${reducedRedCount} red entries`,
        `🚨 DIFFERENZ: +${difference} (= ${expectedChanges} neue Ausfälle)`,
        '',
        '📱 Push notification wird gesendet!',
      ],
      quickCommands: {
        trigger: 'curl https://stundenplan-push-service.vercel.app/api/check-stundenplan',
        debug: `curl "https://stundenplan-push-service.vercel.app/api/debug?className=${className}"`,
        clear: `curl "https://stundenplan-push-service.vercel.app/api/test-push-smart?className=${className}&action=clear"`,
      },
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
}

// ============================================================
// HELPER FUNCTIONS (gleich wie check-stundenplan-v2.js)
// ============================================================

function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function normalizeHTML(html) {
  let normalized = html;
  
  const patterns = [
    /Stand:\s*\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}/gi,
    /generiert.*?\d{2}\.\d{2}\.\d{4}/gi,
    /\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2}/gi,
    /Periode\d+\s+\d{1,2}\.\d{1,2}\.\d{4}.*?Zwischenplan/gi,
    /\d{1,2}\.\d{1,2}\.\d{4}/g,
    /<meta name="GENERATOR"[^>]*>/gi,
    /<title>.*?<\/title>/gi,
  ];
  
  for (const pattern of patterns) {
    normalized = normalized.replace(pattern, '');
  }
  
  return normalized.replace(/\s+/g, ' ').trim();
}

function countRedEntries(html) {
  const patterns = [
    /color="#FF0000"/gi, 
    /color="red"/gi, 
    /color:#FF0000/gi,
    /color:\s*#FF0000/gi,
    /color:\s*red/gi,
  ];
  
  let count = 0;
  for (const pattern of patterns) {
    const matches = html.match(pattern);
    if (matches) count += matches.length;
  }
  return count;
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return hash;
}
