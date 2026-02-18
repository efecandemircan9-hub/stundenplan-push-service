// api/diagnose.js
// Prüft alle registrierten Klassen und zeigt was die Erkennungslogik sieht.
// Sendet KEINEN Push. Nur lesend.

import { kv } from '@vercel/kv';
import crypto from 'crypto';

const CONFIG = {
  BKB_BASE_URL: 'https://stundenplan.bkb.nrw',
  MAPPING_URL: 'https://raw.githubusercontent.com/efecandemircan9-hub/BKBMapping/refs/heads/main/mapping.json',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const { adminKey, className: filterClass, format } = req.query;

    const ADMIN_KEY = process.env.ADMIN_KEY || 'your-secret-key';
    if (adminKey !== ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Klassen ermitteln
    const classKeys = await kv.keys('class:*');
    let classes = classKeys.map(k => k.replace('class:', ''));

    if (filterClass) {
      classes = classes.filter(c => c === filterClass);
    }

    if (classes.length === 0) {
      return res.status(200).json({ success: true, message: 'No classes registered', results: [] });
    }

    // Mapping laden
    const mappingResponse = await fetch(CONFIG.MAPPING_URL);
    const mapping = await mappingResponse.json();

    const now = new Date();
    const week = getWeekNumber(now);
    const year = now.getFullYear();

    const results = [];

    for (const className of classes) {
      const result = await diagnoseClass(className, mapping, week, year);
      results.push(result);
    }

    // Zusammenfassung
    const summary = {
      total: results.length,
      ok: results.filter(r => r.status === 'ok').length,
      no_cache: results.filter(r => r.status === 'ok' && !r.cache.exists).length,
      no_slug: results.filter(r => r.status === 'no_slug').length,
      fetch_error: results.filter(r => r.status === 'fetch_error').length,
      no_zwischenplan_table: results.filter(r => r.status === 'ok' && r.html.zwischenplanTableFound === false).length,
      would_push: results.filter(r => r.wouldPush).length,
    };

    if (format === 'text') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(formatAsText(results, summary, week, year));
    }

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      week,
      year,
      summary,
      results,
    });

  } catch (error) {
    console.error('❌ Diagnose error:', error);
    return res.status(500).json({ error: error.message });
  }
}

async function diagnoseClass(className, mapping, week, year) {
  const slug = mapping[className];

  if (!slug) {
    return {
      className,
      status: 'no_slug',
      error: `Kein Eintrag im Mapping für "${className}"`,
      wouldPush: false,
    };
  }

  // HTML laden
  const weekFormatted = String(week).padStart(2, '0');
  const url = `${CONFIG.BKB_BASE_URL}/schueler/${weekFormatted}/c/${slug}`;
  const basicAuth = 'Basic ' + btoa('schueler:stundenplan');

  let htmlText;
  try {
    const response = await fetch(url, { headers: { 'Authorization': basicAuth } });
    if (!response.ok) {
      return {
        className,
        status: 'fetch_error',
        error: `HTTP ${response.status}`,
        url,
        wouldPush: false,
      };
    }
    htmlText = await response.text();
  } catch (err) {
    return {
      className,
      status: 'fetch_error',
      error: err.message,
      url,
      wouldPush: false,
    };
  }

  // HTML analysieren
  const normalizedHTML = normalizeHTML(htmlText);
  const currentHash = hashString(normalizedHTML);
  const changes = parseZwischenplanChanges(htmlText);
  const changeCount = changes.length;

  // Zusatzinfos für Diagnose
  const zwischenplanTableFound = /<TABLE[^>]*bgcolor=["']#E7E7E7["'][^>]*>/i.test(htmlText);
  const redFontCount = (htmlText.match(/<font[^>]*color=["']?#FF0000["']?[^>]*>/gi) || []).length;
  const cancelledCount = Math.ceil(
    (htmlText.match(/<font[^>]*color=["']?#FF0000["']?[^>]*>\s*\+---\+\s*<\/font>/gi) || []).length / 2
  );
  const substitutionCount = changeCount - cancelledCount;

  // Cache laden
  const cacheKey = `cache:${className}:${year}:w${week}`;
  const cachedRaw = await kv.get(cacheKey);
  const cached = cachedRaw
    ? (typeof cachedRaw === 'string' ? JSON.parse(cachedRaw) : cachedRaw)
    : null;

  // Würde ein Push gesendet werden?
  let wouldPush = false;
  let pushReason = 'no_change';

  if (!cached) {
    wouldPush = false;
    pushReason = 'first_check – würde nur cachen, nicht pushen';
  } else if (cached.hash === currentHash) {
    wouldPush = false;
    pushReason = 'hash_identical – keine Änderung';
  } else if (changeCount > (cached.changeCount ?? 0)) {
    wouldPush = true;
    pushReason = `new_changes: ${cached.changeCount ?? 0} → ${changeCount}`;
  } else if (changeCount < (cached.changeCount ?? 0)) {
    wouldPush = false;
    pushReason = `changes_cleared: ${cached.changeCount ?? 0} → ${changeCount}`;
  } else {
    wouldPush = true;
    pushReason = `content_changed: same changeCount (${changeCount}) but different hash`;
  }

  return {
    className,
    status: 'ok',
    slug,
    url,
    wouldPush,
    pushReason,
    html: {
      zwischenplanTableFound,
      redFontTagsTotal: redFontCount,
      cancelledLessons: cancelledCount,
      substitutions: substitutionCount,
      changeCount,
      changes,
    },
    cache: {
      exists: !!cached,
      key: cacheKey,
      changeCount: cached?.changeCount ?? null,
      updatedAt: cached?.updatedAt ?? null,
      hashMatch: cached ? cached.hash === currentHash : null,
      testMode: cached?.testMode ?? false,
    },
    hash: currentHash,
  };
}

// ============================================================================
// TEXT FORMAT
// ============================================================================

function formatAsText(results, summary, week, year) {
  const line = '═'.repeat(63);
  const thin = '─'.repeat(63);
  let t = '';

  t += `${line}\n`;
  t += `  STUNDENPLAN DIAGNOSE  KW ${week}/${year}\n`;
  t += `${line}\n\n`;

  t += `ZUSAMMENFASSUNG\n${thin}\n`;
  t += `  Klassen gesamt:          ${summary.total}\n`;
  t += `  OK:                      ${summary.ok}\n`;
  t += `  Fehlendes Mapping:       ${summary.no_slug}\n`;
  t += `  Fetch-Fehler:            ${summary.fetch_error}\n`;
  t += `  Keine Zwischenplan-Tabelle: ${summary.no_zwischenplan_table}\n`;
  t += `  Würde Push senden:       ${summary.would_push}\n`;
  t += `  Noch kein Cache:         ${summary.no_cache}\n\n`;

  t += `KLASSEN DETAILS\n${line}\n\n`;

  for (const r of results) {
    const icon = r.status !== 'ok' ? '❌' : r.wouldPush ? '🚨' : '✅';
    t += `${icon} ${r.className}\n`;

    if (r.status === 'no_slug') {
      t += `   ❌ Kein Slug im Mapping!\n\n`;
      continue;
    }
    if (r.status === 'fetch_error') {
      t += `   ❌ Fetch-Fehler: ${r.error}\n\n`;
      continue;
    }

    t += `   Zwischenplan-Tabelle:  ${r.html.zwischenplanTableFound ? 'Ja' : '⚠️ NICHT GEFUNDEN'}\n`;
    t += `   Änderungen (gesamt):   ${r.html.changeCount}\n`;
    if (r.html.substitutions > 0) t += `   └ Vertretungen:        ${r.html.substitutions}\n`;
    if (r.html.cancelledLessons > 0) t += `   └ Ausfälle (+---+):    ${r.html.cancelledLessons}\n`;
    if (r.html.changeCount > 0) {
      for (const c of r.html.changes) {
        t += `      • ${c.nr} ${c.info || 'Ausfall'} ${c.className ? `(${c.className})` : ''}\n`;
      }
    }

    t += `   Cache vorhanden:       ${r.cache.exists ? 'Ja' : 'Nein (first_check)'}\n`;
    if (r.cache.exists) {
      t += `   Cache changeCount:     ${r.cache.changeCount}\n`;
      t += `   Hash identisch:        ${r.cache.hashMatch ? 'Ja' : 'Nein'}\n`;
      if (r.cache.testMode) t += `   ⚠️  TestMode-Cache aktiv!\n`;
    }

    t += `   Push-Aktion:           ${r.wouldPush ? '🚨 WÜRDE PUSHEN' : '✓ kein Push'}\n`;
    t += `   Grund:                 ${r.pushReason}\n`;
    t += '\n';
  }

  t += `${line}\n`;
  t += `Ende der Diagnose\n`;
  t += `${line}\n`;
  return t;
}

// ============================================================================
// HELPERS — identisch mit check-stundenplan.js
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
