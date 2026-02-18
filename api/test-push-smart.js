// api/test-push-smart.js
// Intelligenter Test - Setzt Cache niedriger als Server-Realität

import { kv } from '@vercel/kv';
import crypto from 'crypto';

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

    const now = new Date();
    const week = getWeekNumber(now);
    const year = now.getFullYear();
    const cacheKey = `cache:${className}:${year}:w${week}`; // ← identisch mit check-stundenplan.js

    // ============================================================
    // CACHE LÖSCHEN
    // ============================================================
    if (action === 'clear') {
      await kv.del(cacheKey);
      return res.status(200).json({
        success: true,
        message: `✅ Cache cleared for ${className} (key: ${cacheKey})`,
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
      return res.status(404).json({ error: `No slug found for ${className}` });
    }

    const weekFormatted = String(week).padStart(2, '0');
    const url = `${CONFIG.BKB_BASE_URL}/schueler/${weekFormatted}/c/${slug}`;
    const basicAuth = 'Basic ' + btoa('schueler:stundenplan');

    const response = await fetch(url, { headers: { 'Authorization': basicAuth } });
    if (!response.ok) {
      return res.status(500).json({ error: `Failed to fetch: ${response.status}` });
    }

    const htmlText = await response.text();

    // ============================================================
    // ANALYSIERE SERVER-HTML (gleiche Logik wie check-stundenplan.js)
    // ============================================================
    const normalizedHTML = normalizeHTML(htmlText);
    const serverHash = hashString(normalizedHTML);
    const serverChanges = parseZwischenplanChanges(htmlText);
    const serverChangeCount = serverChanges.length;

    console.log(`📊 Server has ${serverChangeCount} change(s) in Zwischenplan`);

    // ============================================================
    // ERSTELLE FAKE-CACHE MIT WENIGER ÄNDERUNGEN
    // ============================================================

    // Simuliere: Cache hatte 0 Änderungen (= normaler Stundenplan ohne Vertretungen)
    const fakeChangeCount = 0;
    const fakeHash = hashString(normalizedHTML + '__fake__'); // anderer Hash = Änderung wird erkannt

    const fakeCache = {
      hash: fakeHash,
      changeCount: fakeChangeCount,
      updatedAt: new Date(Date.now() - 3600000).toISOString(), // 1 Stunde alt
      testMode: true,
    };

    await kv.set(cacheKey, fakeCache);

    console.log(`✅ Fake cache written: changeCount=${fakeChangeCount}, hash differs from server`);

    // ============================================================
    // VORHERSAGE
    // ============================================================
    const expectedDiff = serverChangeCount - fakeChangeCount;
    const willPush = serverChangeCount > fakeChangeCount;

    return res.status(200).json({
      success: true,
      message: '✅ Smart test prepared!',
      className,
      week,
      year,
      cacheKey,
      server: {
        changeCount: serverChangeCount,
        changes: serverChanges,
        hash: serverHash,
      },
      fakeCache: {
        changeCount: fakeChangeCount,
        hash: fakeHash,
      },
      prediction: {
        willSendPush: willPush,
        expectedNewChanges: expectedDiff,
        message: willPush
          ? `✅ PUSH WIRD GESENDET: ${expectedDiff} neue Änderung(en)`
          : `⚠️ KEIN PUSH: Server hat ${serverChangeCount} Änderungen, Cache hat ${fakeChangeCount} → keine neuen`,
      },
      nextSteps: [
        `Cache gesetzt mit changeCount=${fakeChangeCount} (Server hat ${serverChangeCount})`,
        '',
        'NÄCHSTER SCHRITT:',
        '   curl https://stundenplan-push-service.vercel.app/api/check-stundenplan',
        '',
        willPush
          ? `🚨 PUSH ERWARTET: +${expectedDiff} neue Änderung(en)`
          : '⚠️ Kein Push erwartet (keine neuen Einträge im Zwischenplan)',
      ],
      quickCommands: {
        trigger: 'curl https://stundenplan-push-service.vercel.app/api/check-stundenplan',
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

// ============================================================================
// HELPER FUNCTIONS — identisch mit check-stundenplan.js
// ============================================================================

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
    /Periode\d+\s+\d{1,2}\.\d{1,2}\.\d{4}.*?(?:Zwischenplan|$)/gi,
    /\d{1,2}\.\d{1,2}\./g,
    /<meta name="GENERATOR"[^>]*>/gi,
    /<title>.*?<\/title>/gi,
  ];
  for (const pattern of patterns) {
    normalized = normalized.replace(pattern, '');
  }
  return normalized.replace(/\s+/g, ' ').trim();
}

function parseZwischenplanChanges(html) {
  const tableMatch = html.match(
    /<TABLE[^>]*bgcolor=["']#E7E7E7["'][^>]*>([\s\S]*?)<\/TABLE>/i
  );
  if (!tableMatch) return [];

  const rows = tableMatch[1].match(/<TR>([\s\S]*?)<\/TR>/gi) || [];
  const changes = [];

  for (const row of rows.slice(1)) {
    const cells = (row.match(/<TD[^>]*>([\s\S]*?)<\/TD>/gi) || [])
      .map(c => c.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim());

    if (cells[0] && /^\d+\)$/.test(cells[0].trim())) {
      changes.push({
        nr: cells[0].trim(),
        info: cells[1] || '',
        className: cells[2] || '',
        week: cells[3] || '',
      });
    }
  }

  // Ausgefallene Stunden (+---+) aus dem Grid zählen
  const cancelledInGrid = (html.match(
    /<font[^>]*color=["']?#FF0000["']?[^>]*>\s*\+---\+\s*<\/font>/gi
  ) || []);
  const uniqueCancellations = Math.ceil(cancelledInGrid.length / 2);
  for (let i = 0; i < uniqueCancellations; i++) {
    changes.push({ nr: `cancelled_${i}`, info: 'Ausfall', className: '', week: '' });
  }

  return changes;
}

function hashString(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}
