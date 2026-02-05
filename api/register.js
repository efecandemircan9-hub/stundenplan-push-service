// api/register.js
// Device Registration Endpoint

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const { deviceToken, className, username } = req.body;
    
    if (!deviceToken || !className || !username) {
      return res.status(400).json({
        error: 'Missing required fields: deviceToken, className, username',
      });
    }
    
    // Speichere Device Info
    const device = {
      deviceToken,
      className,
      username,
      registeredAt: new Date().toISOString(),
    };
    
    await kv.set(`device:${deviceToken}`, device);
    
    // Füge zur Klassen-Liste hinzu
    const classTokens = await kv.get(`class:${className}`) || [];
    
    if (!classTokens.includes(deviceToken)) {
      classTokens.push(deviceToken);
      await kv.set(`class:${className}`, classTokens);
    }
    
    console.log(`✅ Registered: ${className} - ${deviceToken.substring(0, 10)}...`);
    
    return res.status(200).json({
      success: true,
      message: 'Device registered successfully',
      className,
    });
    
  } catch (error) {
    console.error('❌ Registration error:', error);
    return res.status(500).json({
      error: error.message,
    });
  }
}
