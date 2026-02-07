// api/apns-config-check.js
// Prüft APNs Konfiguration und zeigt Probleme

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  try {
    const { adminKey } = req.query;
    
    // Security check
    const ADMIN_KEY = process.env.ADMIN_KEY || 'your-secret-key';
    if (adminKey !== ADMIN_KEY) {
      return res.status(403).json({
        error: 'Unauthorized - Invalid admin key',
      });
    }
    
    // ============================================================
    // PRÜFE ALLE APNs ENVIRONMENT VARIABLES
    // ============================================================
    
    const config = {
      APNS_KEY_ID: process.env.APNS_KEY_ID,
      APNS_TEAM_ID: process.env.APNS_TEAM_ID,
      APNS_PRIVATE_KEY: process.env.APNS_PRIVATE_KEY,
      APNS_ENVIRONMENT: process.env.APNS_ENVIRONMENT,
    };
    
    const checks = [];
    let allGood = true;
    
    // Check 1: APNS_KEY_ID
    if (!config.APNS_KEY_ID) {
      checks.push({
        name: 'APNS_KEY_ID',
        status: '❌ Missing',
        issue: 'Not set',
        fix: 'Set to your 10-character Key ID from Apple Developer',
      });
      allGood = false;
    } else if (config.APNS_KEY_ID.length !== 10) {
      checks.push({
        name: 'APNS_KEY_ID',
        status: '⚠️  Warning',
        value: config.APNS_KEY_ID,
        issue: `Length is ${config.APNS_KEY_ID.length}, should be 10`,
        fix: 'Double-check the Key ID from Apple Developer',
      });
      allGood = false;
    } else {
      checks.push({
        name: 'APNS_KEY_ID',
        status: '✅ OK',
        value: config.APNS_KEY_ID,
      });
    }
    
    // Check 2: APNS_TEAM_ID
    if (!config.APNS_TEAM_ID) {
      checks.push({
        name: 'APNS_TEAM_ID',
        status: '❌ Missing',
        issue: 'Not set',
        fix: 'Set to your 10-character Team ID from Apple Developer',
      });
      allGood = false;
    } else if (config.APNS_TEAM_ID.length !== 10) {
      checks.push({
        name: 'APNS_TEAM_ID',
        status: '⚠️  Warning',
        value: config.APNS_TEAM_ID,
        issue: `Length is ${config.APNS_TEAM_ID.length}, should be 10`,
        fix: 'Double-check the Team ID from Apple Developer',
      });
      allGood = false;
    } else {
      checks.push({
        name: 'APNS_TEAM_ID',
        status: '✅ OK',
        value: config.APNS_TEAM_ID,
      });
    }
    
    // Check 3: APNS_ENVIRONMENT
    if (!config.APNS_ENVIRONMENT) {
      checks.push({
        name: 'APNS_ENVIRONMENT',
        status: '⚠️  Warning',
        value: 'not set (defaults to sandbox)',
        fix: 'Set to "sandbox" for development or "production" for App Store',
      });
    } else if (config.APNS_ENVIRONMENT !== 'sandbox' && config.APNS_ENVIRONMENT !== 'production') {
      checks.push({
        name: 'APNS_ENVIRONMENT',
        status: '❌ Invalid',
        value: config.APNS_ENVIRONMENT,
        issue: 'Must be "sandbox" or "production"',
        fix: 'Change to "sandbox" (Xcode) or "production" (App Store)',
      });
      allGood = false;
    } else {
      checks.push({
        name: 'APNS_ENVIRONMENT',
        status: '✅ OK',
        value: config.APNS_ENVIRONMENT,
        note: config.APNS_ENVIRONMENT === 'production' 
          ? '⚠️  Using PRODUCTION - only works for App Store builds!'
          : '✅ Using SANDBOX - works for Xcode development builds',
      });
    }
    
    // Check 4: APNS_PRIVATE_KEY
    if (!config.APNS_PRIVATE_KEY) {
      checks.push({
        name: 'APNS_PRIVATE_KEY',
        status: '❌ Missing',
        issue: 'Not set',
        fix: 'Set to your .p8 file contents (including BEGIN/END lines)',
      });
      allGood = false;
    } else {
      const key = config.APNS_PRIVATE_KEY;
      const issues = [];
      
      // Check if it has BEGIN/END markers
      if (!key.includes('-----BEGIN PRIVATE KEY-----')) {
        issues.push('Missing "-----BEGIN PRIVATE KEY-----"');
      }
      if (!key.includes('-----END PRIVATE KEY-----')) {
        issues.push('Missing "-----END PRIVATE KEY-----"');
      }
      
      // Check if it has newlines (should have at least 3 lines)
      const lines = key.split('\n').filter(l => l.trim());
      if (lines.length < 3) {
        issues.push(`Only ${lines.length} line(s) - should be multi-line with \\n characters`);
      }
      
      // Check length
      if (key.length < 100) {
        issues.push(`Too short (${key.length} chars) - should be ~200-300 chars`);
      }
      
      if (issues.length > 0) {
        checks.push({
          name: 'APNS_PRIVATE_KEY',
          status: '❌ Format Error',
          preview: key.substring(0, 50) + '...',
          issues: issues,
          fix: 'Copy the ENTIRE .p8 file content, preserving newlines',
        });
        allGood = false;
      } else {
        checks.push({
          name: 'APNS_PRIVATE_KEY',
          status: '✅ OK',
          preview: '-----BEGIN PRIVATE KEY----- (hidden)',
          lines: lines.length,
        });
      }
    }
    
    // ============================================================
    // EMPFEHLUNGEN
    // ============================================================
    
    const recommendations = [];
    
    if (config.APNS_ENVIRONMENT === 'production') {
      recommendations.push({
        type: 'warning',
        message: 'You are using PRODUCTION environment',
        details: 'This only works for App Store or TestFlight builds. For Xcode development, change to "sandbox"',
      });
    }
    
    if (!allGood) {
      recommendations.push({
        type: 'error',
        message: 'APNs configuration has errors',
        details: 'Fix the issues above before testing push notifications',
      });
    }
    
    // ============================================================
    // RESPONSE
    // ============================================================
    
    return res.status(200).json({
      success: allGood,
      message: allGood 
        ? '✅ APNs configuration looks good!' 
        : '❌ APNs configuration has issues',
      checks,
      recommendations: recommendations.length > 0 ? recommendations : undefined,
      apnsUrl: config.APNS_ENVIRONMENT === 'production'
        ? 'https://api.push.apple.com'
        : 'https://api.sandbox.push.apple.com',
      nextSteps: allGood ? [
        'Test with: curl .../api/test-apns-direct',
      ] : [
        'Fix the issues shown above',
        'Redeploy or wait 1 minute for changes to apply',
        'Then test again',
      ],
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({
      error: error.message,
    });
  }
}
