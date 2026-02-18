// api/diagnose.js
// Prüft alle Klassen – sendet KEINEN Push, nur lesend.

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
    if (adminKey !== (process.env.ADMIN_KEY || 'your-secret-key'))
      return res.status(403).json({ error: 'Unauthorized' });

    let classes = (await kv.keys('class:*')).map(k => k.replace('class:', ''));
    if (filterClass) classes = classes.filter(c => c === filterClass);
    if (classes.length === 0) return res.status(200).json({ success: true, message: 'No classes', results: [] });

    const mapping = await (await fetch(CONFIG.MAPPING_URL)).json();
    const now = new Date();
    const week = getWeekNumber(now);
    const year = now.getFullYear();

    const results = await Promise.all(classes.map(c => diagnoseClass(c, mapping, week, year)));

    const summary = {
      total: results.length,
      ok: results.filter(r => r.status === 'ok').length,
      no_slug: results.filter(r => r.status === 'no_slug').length,
      fetch_error: results.filter(r => r.status === 'fetch_error').length,
      no_cache: results.filter(r => r.status === 'ok' && !r.cache.exists).length,
      would_push: results.filter(r => r.wouldPush).length,
    };

    if (format === 'text') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(formatAsText(results, summary, week, year));
    }
    return res.status(200).json({ success: true, timestamp: new Date().toISOString(), week, year, summary, results });

  } catch (e) { return res.status(500).json({ error: e.message }); }
}

async function diagnoseClass(className, mapping, week, year) {
  const slug = mapping[className];
  if (!slug) return { className, status: 'no_slug', wouldPush: false };

  const url = `${CONFIG.BKB_BASE_URL}/schueler/${String(week).padStart(2, '0')}/c/${slug}`;
  let htmlText;
  try {
    const r = await fetch(url, { headers: { 'Authorization': 'Basic ' + btoa('schueler:stundenplan') } });
    if (!r.ok) return { className, status: 'fetch_error', error: `HTTP ${r.status}`, url, wouldPush: false };
    htmlText = await r.text();
  } catch (e) { return { className, status: 'fetch_error', error: e.message, url, wouldPush: false }; }

  const currentHash = hashString(normalizeHTML(htmlText));
  const { cancellations, substitutions, total: changeCount } = countChanges(htmlText);

  const cacheKey = `cache:${className}:${year}:w${week}`;
  const cachedRaw = await kv.get(cacheKey);
  const cached = cachedRaw ? (typeof cachedRaw === 'string' ? JSON.parse(cachedRaw) : cachedRaw) : null;

  let wouldPush = false, pushReason = 'no_change';
  if (!cached) {
    pushReason = 'first_check – nur cachen';
  } else if (cached.hash === currentHash) {
    pushReason = 'hash_identical – keine Änderung';
  } else if (changeCount > (cached.changeCount ?? 0)) {
    wouldPush = true;
    pushReason = `new_changes: ${cached.changeCount ?? 0}→${changeCount}`;
  } else if (changeCount < (cached.changeCount ?? 0)) {
    pushReason = `changes_cleared: ${cached.changeCount ?? 0}→${changeCount}`;
  } else {
    wouldPush = true;
    pushReason = `content_updated: gleiche Anzahl (${changeCount}), anderer Hash`;
  }

  return {
    className, status: 'ok', slug, url, wouldPush, pushReason,
    changes: { cancellations, substitutions, total: changeCount },
    pushMessage: wouldPush ? buildPushMessage(substitutions, cancellations, changeCount) : null,
    cache: {
      exists: !!cached, key: cacheKey,
      changeCount: cached?.changeCount ?? null,
      updatedAt: cached?.updatedAt ?? null,
      hashMatch: cached ? cached.hash === currentHash : null,
      testMode: cached?.testMode ?? false,
    },
  };
}

function formatAsText(results, summary, week, year) {
  const L = '═'.repeat(63), l = '─'.repeat(63);
  let t = `${L}\n  STUNDENPLAN DIAGNOSE  KW ${week}/${year}\n${L}\n\n`;
  t += `ZUSAMMENFASSUNG\n${l}\n`;
  t += `  Klassen gesamt:      ${summary.total}\n`;
  t += `  OK:                  ${summary.ok}\n`;
  t += `  Fehlendes Mapping:   ${summary.no_slug}\n`;
  t += `  Fetch-Fehler:        ${summary.fetch_error}\n`;
  t += `  Noch kein Cache:     ${summary.no_cache}\n`;
  t += `  Würde Push senden:   ${summary.would_push}\n\n`;
  t += `KLASSEN DETAILS\n${L}\n\n`;

  for (const r of results) {
    const icon = r.status !== 'ok' ? '❌' : r.wouldPush ? '🚨' : '✅';
    t += `${icon} ${r.className}\n`;
    if (r.status === 'no_slug') { t += `   ❌ Kein Slug im Mapping!\n\n`; continue; }
    if (r.status === 'fetch_error') { t += `   ❌ Fetch-Fehler: ${r.error}\n\n`; continue; }
    t += `   Ausfälle:             ${r.changes.cancellations}\n`;
    t += `   Vertretungen:         ${r.changes.substitutions}\n`;
    t += `   Änderungen gesamt:    ${r.changes.total}\n`;
    t += `   Cache vorhanden:      ${r.cache.exists ? 'Ja' : 'Nein (first_check)'}\n`;
    if (r.cache.exists) {
      t += `   Cache changeCount:    ${r.cache.changeCount}\n`;
      t += `   Hash identisch:       ${r.cache.hashMatch ? 'Ja' : 'Nein'}\n`;
      if (r.cache.testMode) t += `   ⚠️  TestMode-Cache aktiv!\n`;
    }
    t += `   Push-Aktion:          ${r.wouldPush ? '🚨 WÜRDE PUSHEN' : '✓ kein Push'}\n`;
    t += `   Grund:                ${r.pushReason}\n`;
    if (r.pushMessage) t += `   Push-Text:            "${r.pushMessage}"\n`;
    t += '\n';
  }
  t += `${L}\nEnde der Diagnose\n${L}\n`;
  return t;
}

// ============================================================================
// HELPERS — identisch mit check-stundenplan.js
// ============================================================================

function countChanges(html) {
  const blockRegex = /<TD colspan=12 rowspan=\d+[^>]*><TABLE><TR>([\s\S]*?)<\/TR><\/TABLE><\/TD>/gi;
  const lessonBlocks = [...html.matchAll(blockRegex)].map(m => m[1]);

  let cancellations = 0;
  let substitutions = 0;
  const seenNrs = new Set();

  for (const block of lessonBlocks) {
    const tdRegex = /<TD[^>]*>([\s\S]*?)<\/TD>/gi;
    const tds = [...block.matchAll(tdRegex)].map(m => {
      const fontMatch = m[1].match(/<font([^>]*)>([\s\S]*?)<\/font>/i);
      if (!fontMatch) return null;
      return {
        text: fontMatch[2].replace(/<[^>]+>/g, '').trim(),
        red: /FF0000/i.test(fontMatch[1]),
      };
    }).filter(Boolean);

    if (!tds.some(td => td.red)) continue;

    const nrRegex = /^\d+\)$/;
    const nr = tds.find(td => nrRegex.test(td.text))?.text ?? tds[0]?.text;
    if (seenNrs.has(nr)) continue;
    seenNrs.add(nr);

    const fach   = tds[0]?.text ?? '';
    const lehrer = tds[tds.length - 1]?.text ?? '';

    // Untis kodiert leere Felder als '---' oder '+---+' (je nach Version)
    // AUSFALL:    Fach UND Lehrer sind beide leer (--- oder +---+)
    // VERTRETUNG: nur eines davon leer, oder keines
    const isEmpty = t => t === '---' || t === '+---+';
    if (isEmpty(fach) && isEmpty(lehrer)) {
      cancellations++;
    } else {
      substitutions++;
    }
  }

  return { cancellations, substitutions, total: cancellations + substitutions };
}

function buildPushMessage(substitutions, cancellations, diff) {
  const parts = [];
  if (cancellations > 0) parts.push(`${cancellations} ${cancellations === 1 ? 'Ausfall' : 'Ausfälle'}`);
  if (substitutions > 0) parts.push(`${substitutions} ${substitutions === 1 ? 'Vertretung' : 'Vertretungen'}`);
  return parts.length > 0 ? parts.join(', ') + ' im Stundenplan.' : `${diff} neue Änderung(en) im Stundenplan.`;
}

function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function normalizeHTML(html) {
  let n = html;
  for (const p of [
    /Stand:\s*\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}/gi,
    /generiert.*?\d{2}\.\d{2}\.\d{4}/gi,
    /\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2}/gi,
    /Periode\d+\s+\d{1,2}\.\d{1,2}\.\d{4}.*?(?:Zwischenplan|$)/gi,
    /\d{1,2}\.\d{1,2}\./g,
    /<meta name="GENERATOR"[^>]*>/gi,
    /<title>.*?<\/title>/gi,
  ]) n = n.replace(p, '');
  return n.replace(/\s+/g, ' ').trim();
}

function hashString(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}
