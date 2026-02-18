// api/diagnose.js
// Prüft alle registrierten Klassen – sendet KEINEN Push, nur lesend.

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
    if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });

    const classKeys = await kv.keys('class:*');
    let classes = classKeys.map(k => k.replace('class:', ''));
    if (filterClass) classes = classes.filter(c => c === filterClass);

    if (classes.length === 0)
      return res.status(200).json({ success: true, message: 'No classes registered', results: [] });

    const mappingResponse = await fetch(CONFIG.MAPPING_URL);
    const mapping = await mappingResponse.json();

    const now = new Date();
    const week = getWeekNumber(now);
    const year = now.getFullYear();

    const results = [];
    for (const className of classes) {
      results.push(await diagnoseClass(className, mapping, week, year));
    }

    const summary = {
      total: results.length,
      ok: results.filter(r => r.status === 'ok').length,
      no_cache: results.filter(r => r.status === 'ok' && !r.cache.exists).length,
      no_slug: results.filter(r => r.status === 'no_slug').length,
      fetch_error: results.filter(r => r.status === 'fetch_error').length,
      would_push: results.filter(r => r.wouldPush).length,
    };

    if (format === 'text') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(formatAsText(results, summary, week, year));
    }

    return res.status(200).json({ success: true, timestamp: new Date().toISOString(), week, year, summary, results });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

async function diagnoseClass(className, mapping, week, year) {
  const slug = mapping[className];
  if (!slug) return { className, status: 'no_slug', error: `Kein Mapping-Eintrag für "${className}"`, wouldPush: false };

  const url = `${CONFIG.BKB_BASE_URL}/schueler/${String(week).padStart(2, '0')}/c/${slug}`;
  let htmlText;
  try {
    const response = await fetch(url, { headers: { 'Authorization': 'Basic ' + btoa('schueler:stundenplan') } });
    if (!response.ok) return { className, status: 'fetch_error', error: `HTTP ${response.status}`, url, wouldPush: false };
    htmlText = await response.text();
  } catch (err) {
    return { className, status: 'fetch_error', error: err.message, url, wouldPush: false };
  }

  const normalizedHTML = normalizeHTML(htmlText);
  const currentHash = hashString(normalizedHTML);
  const { substitutions, cancellations, total: changeCount } = countChanges(htmlText);

  const cacheKey = `cache:${className}:${year}:w${week}`;
  const cachedRaw = await kv.get(cacheKey);
  const cached = cachedRaw ? (typeof cachedRaw === 'string' ? JSON.parse(cachedRaw) : cachedRaw) : null;

  let wouldPush = false;
  let pushReason = 'no_change';

  if (!cached) {
    pushReason = 'first_check – würde nur cachen';
  } else if (cached.hash === currentHash) {
    pushReason = 'hash_identical – keine Änderung';
  } else if (changeCount > (cached.changeCount ?? 0)) {
    wouldPush = true;
    pushReason = `new_changes: ${cached.changeCount ?? 0}→${changeCount}`;
  } else if (changeCount < (cached.changeCount ?? 0)) {
    pushReason = `changes_cleared: ${cached.changeCount ?? 0}→${changeCount}`;
  } else {
    wouldPush = true;
    pushReason = `content_updated: same changeCount(${changeCount}) but different hash`;
  }

  return {
    className,
    status: 'ok',
    slug,
    url,
    wouldPush,
    pushReason,
    changes: { substitutions, cancellations, total: changeCount },
    pushMessage: wouldPush ? buildPushMessage(substitutions, cancellations, changeCount) : null,
    cache: {
      exists: !!cached,
      key: cacheKey,
      changeCount: cached?.changeCount ?? null,
      updatedAt: cached?.updatedAt ?? null,
      hashMatch: cached ? cached.hash === currentHash : null,
      testMode: cached?.testMode ?? false,
    },
  };
}

function formatAsText(results, summary, week, year) {
  const line = '═'.repeat(63);
  const thin = '─'.repeat(63);
  let t = `${line}\n  STUNDENPLAN DIAGNOSE  KW ${week}/${year}\n${line}\n\n`;

  t += `ZUSAMMENFASSUNG\n${thin}\n`;
  t += `  Klassen gesamt:       ${summary.total}\n`;
  t += `  OK:                   ${summary.ok}\n`;
  t += `  Fehlendes Mapping:    ${summary.no_slug}\n`;
  t += `  Fetch-Fehler:         ${summary.fetch_error}\n`;
  t += `  Würde Push senden:    ${summary.would_push}\n`;
  t += `  Noch kein Cache:      ${summary.no_cache}\n\n`;
  t += `KLASSEN DETAILS\n${line}\n\n`;

  for (const r of results) {
    const icon = r.status !== 'ok' ? '❌' : r.wouldPush ? '🚨' : '✅';
    t += `${icon} ${r.className}\n`;
    if (r.status === 'no_slug') { t += `   ❌ Kein Slug im Mapping!\n\n`; continue; }
    if (r.status === 'fetch_error') { t += `   ❌ Fetch-Fehler: ${r.error}\n\n`; continue; }

    t += `   Vertretungen:         ${r.changes.substitutions}\n`;
    t += `   Ausfälle:             ${r.changes.cancellations}\n`;
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

  t += `${line}\nEnde der Diagnose\n${line}\n`;
  return t;
}

// ============================================================================
// HELPERS — identisch mit check-stundenplan.js
// ============================================================================

function countChanges(html) {
  const redTexts = (
    html.match(/<font[^>]*color=["']?#?FF0000["']?[^>]*>([\s\S]*?)<\/font>/gi) || []
  ).map(tag => tag.replace(/<[^>]+>/g, '').trim());

  const nrRefs = new Set(redTexts.filter(t => /^\d+\)$/.test(t)));
  const substitutions = nrRefs.size;
  const cancellations = Math.floor(redTexts.filter(t => t === '---').length / 2);

  return { substitutions, cancellations, total: substitutions + cancellations };
}

function buildPushMessage(substitutions, cancellations, diff) {
  const parts = [];
  if (cancellations > 0) parts.push(`${cancellations} ${cancellations === 1 ? 'Ausfall' : 'Ausfälle'}`);
  if (substitutions > 0) parts.push(`${substitutions} ${substitutions === 1 ? 'Vertretung' : 'Vertretungen'}`);
  if (parts.length > 0) return parts.join(', ') + ' im Stundenplan.';
  return `${diff} ${diff === 1 ? 'neue Änderung' : 'neue Änderungen'} im Stundenplan.`;
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
  const patterns = [
    /Stand:\s*\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}/gi,
    /generiert.*?\d{2}\.\d{2}\.\d{4}/gi,
    /\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2}/gi,
    /Periode\d+\s+\d{1,2}\.\d{1,2}\.\d{4}.*?(?:Zwischenplan|$)/gi,
    /\d{1,2}\.\d{1,2}\./g,
    /<meta name="GENERATOR"[^>]*>/gi,
    /<title>.*?<\/title>/gi,
  ];
  for (const p of patterns) n = n.replace(p, '');
  return n.replace(/\s+/g, ' ').trim();
}

function hashString(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}
