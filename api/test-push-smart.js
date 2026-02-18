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
    if (!className) return res.status(400).json({ error: 'Missing className', usage: '?className=2I25A' });

    const now = new Date();
    const week = getWeekNumber(now);
    const year = now.getFullYear();
    const cacheKey = `cache:${className}:${year}:w${week}`;

    if (action === 'clear') {
      await kv.del(cacheKey);
      return res.status(200).json({ success: true, message: `Cache cleared: ${cacheKey}` });
    }

    const mapping = await (await fetch(CONFIG.MAPPING_URL)).json();
    const slug = mapping[className];
    if (!slug) return res.status(404).json({ error: `No slug for ${className}` });

    const response = await fetch(
      `${CONFIG.BKB_BASE_URL}/schueler/${String(week).padStart(2, '0')}/c/${slug}`,
      { headers: { 'Authorization': 'Basic ' + btoa('schueler:stundenplan') } }
    );
    if (!response.ok) return res.status(500).json({ error: `Fetch failed: ${response.status}` });

    const htmlText = await response.text();
    const serverHash = hashString(normalizeHTML(htmlText));
    const { cancellations, substitutions, total: serverChangeCount } = countChanges(htmlText);

    // Fake-Cache mit 0 Änderungen + anderem Hash → check-stundenplan pusht beim nächsten Aufruf
    await kv.set(cacheKey, {
      hash: hashString(normalizeHTML(htmlText) + '__fake__'),
      changeCount: 0,
      updatedAt: new Date(Date.now() - 3600000).toISOString(),
      testMode: true,
    });

    const willPush = serverChangeCount > 0;

    return res.status(200).json({
      success: true,
      message: '✅ Smart test prepared!',
      className, week, year, cacheKey,
      server: { cancellations, substitutions, total: serverChangeCount, hash: serverHash },
      fakeCache: { changeCount: 0 },
      prediction: {
        willSendPush: willPush,
        pushMessage: willPush ? buildPushMessage(substitutions, cancellations, serverChangeCount) : null,
        verdict: willPush
          ? `✅ PUSH WIRD GESENDET: ${cancellations} Ausfall/Ausfälle, ${substitutions} Vertretung(en)`
          : `⚠️ KEIN PUSH: Aktuell keine roten Einträge im Stundenplan`,
      },
      nextStep: 'curl https://stundenplan-push-service.vercel.app/api/check-stundenplan',
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ============================================================================
// HELPERS — identisch mit check-stundenplan.js
// ============================================================================

function countChanges(html) {
  const lessonBlocks = [...html.matchAll(
    /<TD colspan=12 rowspan=\d+[^>]*><TABLE><TR>([\s\S]*?)<\/TR><\/TABLE><\/TD>/gi
  )].map(m => m[1]);

  let cancellations = 0, substitutions = 0;
  const seenNrs = new Set();

  for (const block of lessonBlocks) {
    const tds = [...block.matchAll(/<TD[^>]*>([\s\S]*?)<\/TD>/gi)].map(m => {
      const f = m[1].match(/<font([^>]*)>([\s\S]*?)<\/font>/i);
      if (!f) return null;
      return { text: f[2].replace(/<[^>]+>/g, '').trim(), red: /FF0000/i.test(f[1]) };
    }).filter(Boolean);

    if (!tds.some(td => td.red)) continue;
    const fach = tds[0]?.text ?? '';
    const nr = tds.find(td => /^\d+\)$/.test(td.text))?.text ?? fach;
    if (seenNrs.has(nr)) continue;
    seenNrs.add(nr);
    fach === '---' ? cancellations++ : substitutions++;
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
