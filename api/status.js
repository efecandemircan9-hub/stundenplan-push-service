// api/status.js
// Status Endpoint

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  try {
    // Zähle registrierte Devices
    const deviceKeys = await kv.keys('device:*');
    const deviceCount = deviceKeys.length;
    
    // Letzte Prüfung
    const lastCheck = await kv.get('meta:lastCheck');
    
    // Registrierte Klassen
    const classKeys = await kv.keys('class:*');
    const classes = classKeys.map(k => k.replace('class:', ''));
    
    return res.status(200).json({
      status: 'operational',
      devices: deviceCount,
      classes: classes.length,
      classList: classes,
      lastCheck: lastCheck || 'never',
      timestamp: new Date().toISOString(),
    });
    
  } catch (error) {
    return res.status(500).json({
      error: error.message,
    });
  }
}
