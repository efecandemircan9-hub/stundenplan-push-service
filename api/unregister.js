// api/unregister.js
// Device Unregistration Endpoint

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
    const { deviceToken } = req.body;
    
    if (!deviceToken) {
      return res.status(400).json({
        error: 'Missing deviceToken',
      });
    }
    
    // Hole Device Info
    const deviceData = await kv.get(`device:${deviceToken}`);
    
    if (deviceData) {
      // Parse device data
      let device;
      if (typeof deviceData === 'string') {
        device = JSON.parse(deviceData);
      } else {
        device = deviceData;
      }
      
      console.log(`🗑️ Unregistering: ${device.className} - ${deviceToken.substring(0, 10)}...`);
      
      // Entferne aus Klassen-Liste
      const classTokens = await kv.get(`class:${device.className}`) || [];
      const filtered = classTokens.filter(t => t !== deviceToken);
      
      if (filtered.length > 0) {
        await kv.set(`class:${device.className}`, filtered);
      } else {
        // Keine Devices mehr in dieser Klasse - lösche Liste
        await kv.del(`class:${device.className}`);
      }
    }
    
    // Entferne Device
    await kv.del(`device:${deviceToken}`);
    
    console.log(`✅ Unregistered: ${deviceToken.substring(0, 10)}...`);
    
    return res.status(200).json({
      success: true,
      message: 'Device unregistered successfully',
    });
    
  } catch (error) {
    console.error('❌ Unregister error:', error);
    return res.status(500).json({
      error: error.message,
    });
  }
}
