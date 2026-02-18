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
    const cacheKey = `cache:${className}:${year}:w${week}`;

    // Cache löschen
    if (action === 'clear') {
      await kv.del(cacheKey);
      return res.status(200).json({
        success: true,
        message: `✅ Cache cleared for ${className} (key: ${cacheKey})`,
      });
    }

    // Echtes HTML laden
    const mappingResponse = await fetch(CONFIG.MAPPING_URL);
    const mapping = await mappingResponse.json();

    const slug = mapping[className];
    if (!slug) return res.status(404).json({ error: `No slug found for ${className}` });

    const weekFormatted = String(week).padStart(2, '0');
    const url = `${CONFIG.BKB_BASE_URL}/schueler/${weekFormatted}/c/${slug}`;
    const response = await fetch(url, { headers: { 'Authorization': 'Basic ' + btoa('schueler:stundenplan') } });
    if (!response.ok) return res.status(500).json({ error: `Failed to fetch: ${response.status}` });

    const htmlText = await response.text();
    const normalizedHTML = normalizeHTML(htmlText);
    const serverHash = hashString(normalizedHTML);
    const { substitutions, cancellations, total: serverChangeCount } = countChanges(htmlText);

    // Fake-Cache mit 0 Änderungen + anderem Hash → check-stundenplan erkennt Differenz
    const fakeHash = hashString(normalizedHTML + '__fake__');
    await kv.set(cacheKey, {
      hash: fakeHash,
      changeCount: 0,
      updatedAt: new Date(Date.now() - 3600000).toISOString(),
      testMode: true,
    });

    const willPush = serverChangeCount > 0;

    return res.status(200).json({
      success: true,
      message: '✅ Smart test prepared!',
      className,
      week,
      year,
      cacheKey,
      server: {
        substitutions,
        cancellations,
        changeCount: serverChangeCount,
        hash: serverHash,
      },
      fakeCache: {
        changeCount: 0,
        hash: fakeHash,
      },
      prediction: {
        willSendPush: willPush,
        expectedNewChanges: serverChangeCount,
        pushMessage: willPush
          ? buildPushMessage(substitutions, cancellations, serverChangeCount)
          : null,
        verdict: willPush
          ? `✅ PUSH WIRD GESENDET: ${serverChangeCount} Änderung(en)`
          : `⚠️ KEIN PUSH: Stundenplan hat aktuell keine roten Einträge`,
      },
      nextStep: 'curl https://stundenplan-push-service.vercel.app/api/check-stundenplan',
      quickCommands: {
        trigger: 'curl https://stundenplan-push-service.vercel.app/api/check-stundenplan',
        clear: `curl "https://stundenplan-push-service.vercel.app/api/test-push-smart?className=${className}&action=clear"`,
        diagnose: `curl "https://stundenplan-push-service.vercel.app/api/diagnose?adminKey=KEY&className=${className}&format=text"`,
      },
    });

  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({ error: error.message });
  }
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
