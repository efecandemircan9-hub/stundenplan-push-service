// api/remove-device.js
// Entfernt ein einzelnes Gerät vom Push-System

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const { deviceToken, adminKey } = req.body;
    
    // Security check
    const ADMIN_KEY = process.env.ADMIN_KEY || 'your-secret-key';
    if (adminKey !== ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    if (!deviceToken) {
      return res.status(400).json({
        error: 'Missing deviceToken',
        usage: 'POST /api/remove-device with { deviceToken: "xxx", adminKey: "5757" }',
      });
    }
    
    console.log(`🗑️ Removing device: ${deviceToken.substring(0, 20)}...`);
    
    // Hole Device-Info
    const deviceData = await kv.get(`device:${deviceToken}`);
    
    if (!deviceData) {
      console.log(`⚠️ Device not found in system`);
      return res.status(404).json({
        success: false,
        error: 'Device not found',
        deviceToken: deviceToken.substring(0, 20) + '...',
      });
    }
    
    let device;
    if (typeof deviceData === 'string') {
      device = JSON.parse(deviceData);
    } else {
      device = deviceData;
    }
    
    const className = device.className;
    const username = device.username;
    
    console.log(`   Device belongs to: ${className} (${username})`);
    
    // Entferne von Klasse
    const classTokens = await kv.get(`class:${className}`) || [];
    const filteredTokens = classTokens.filter(t => t !== deviceToken);
    
    if (filteredTokens.length < classTokens.length) {
      await kv.set(`class:${className}`, filteredTokens);
      console.log(`   ✅ Removed from class: ${className}`);
      console.log(`   Devices left in class: ${filteredTokens.length}`);
    } else {
      console.log(`   ℹ️  Device was not in class array`);
    }
    
    // Lösche Device Entry
    await kv.del(`device:${deviceToken}`);
    console.log(`   ✅ Deleted device entry`);
    
    return res.status(200).json({
      success: true,
      message: 'Device removed successfully',
      device: {
        token: deviceToken.substring(0, 20) + '...',
        className: className,
        username: username,
      },
      remainingInClass: filteredTokens.length,
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({
      error: error.message,
    });
  }
}
