// api/logs.js
// Zeigt historische Logs der letzten 30 Tage

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  try {
    const { adminKey, days, type, format, className } = req.query;
    
    // Security check
    const ADMIN_KEY = process.env.ADMIN_KEY || 'your-secret-key';
    if (adminKey !== ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    console.log('📋 Fetching logs...');
    
    // Hole alle Log-Keys
    const logKeys = await kv.keys('log:*');
    console.log(`Found ${logKeys.length} log entries`);
    
    // Hole alle Logs
    const logs = [];
    for (const key of logKeys) {
      const logData = await kv.get(key);
      if (logData) {
        let log;
        if (typeof logData === 'string') {
          log = JSON.parse(logData);
        } else {
          log = logData;
        }
        log.key = key; // Speichere Key für spätere Referenz
        logs.push(log);
      }
    }
    
    // Sortiere nach Timestamp (neueste zuerst)
    logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    // Filter nach Tagen
    const daysFilter = parseInt(days) || 30;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysFilter);
    
    let filteredLogs = logs.filter(log => {
      return new Date(log.timestamp) >= cutoffDate;
    });
    
    // Filter nach Type
    if (type) {
      filteredLogs = filteredLogs.filter(log => log.type === type);
    }
    
    // Filter nach Klasse (wenn in results vorhanden)
    if (className) {
      filteredLogs = filteredLogs.filter(log => {
        if (log.results) {
          return log.results.some(r => r.className === className);
        }
        return false;
      });
    }
    
    console.log(`Filtered to ${filteredLogs.length} logs`);
    
    // Statistiken
    const stats = {
      total: filteredLogs.length,
      byStatus: {},
      byType: {},
      totalChangesDetected: 0,
      totalPushesSent: 0,
      averageDuration: 0,
    };
    
    let totalDuration = 0;
    
    filteredLogs.forEach(log => {
      // Count by status
      stats.byStatus[log.status] = (stats.byStatus[log.status] || 0) + 1;
      
      // Count by type
      stats.byType[log.type] = (stats.byType[log.type] || 0) + 1;
      
      // Sum changes and pushes
      if (log.totalChanges) stats.totalChangesDetected += log.totalChanges;
      if (log.totalPushesSent) stats.totalPushesSent += log.totalPushesSent;
      
      // Sum duration
      if (log.duration) totalDuration += log.duration;
    });
    
    stats.averageDuration = filteredLogs.length > 0 
      ? Math.round(totalDuration / filteredLogs.length) 
      : 0;
    
    // Response Format
    if (format === 'text') {
      const logText = formatLogsAsText(filteredLogs, stats, daysFilter);
      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).send(logText);
    } else {
      return res.status(200).json({
        success: true,
        period: {
          days: daysFilter,
          from: cutoffDate.toISOString(),
          to: new Date().toISOString(),
        },
        stats,
        logs: filteredLogs,
      });
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({
      error: error.message,
    });
  }
}

function formatLogsAsText(logs, stats, days) {
  let text = '';
  
  text += '═══════════════════════════════════════════════════════════════\n';
  text += `                     SYSTEM LOGS (Last ${days} days)                 \n`;
  text += '═══════════════════════════════════════════════════════════════\n\n';
  
  // Statistics
  text += '📊 STATISTICS\n';
  text += '─────────────────────────────────────────────────────────────\n';
  text += `   Total Logs:              ${stats.total}\n`;
  text += `   Total Changes Detected:  ${stats.totalChangesDetected}\n`;
  text += `   Total Pushes Sent:       ${stats.totalPushesSent}\n`;
  text += `   Average Duration:        ${stats.averageDuration}ms\n\n`;
  
  text += '   Status Breakdown:\n';
  Object.entries(stats.byStatus).forEach(([status, count]) => {
    const icon = status === 'completed' ? '✅' : 
                 status === 'error' ? '❌' : 
                 status === 'no_classes' ? '⚠️' : '📝';
    text += `      ${icon} ${status}: ${count}\n`;
  });
  text += '\n';
  
  text += '   Type Breakdown:\n';
  Object.entries(stats.byType).forEach(([type, count]) => {
    text += `      • ${type}: ${count}\n`;
  });
  text += '\n';
  
  // Recent Logs
  text += '📋 LOG ENTRIES (Newest First)\n';
  text += '═══════════════════════════════════════════════════════════════\n\n';
  
  if (logs.length === 0) {
    text += '   No logs found for this period\n\n';
  } else {
    logs.forEach((log, index) => {
      const statusIcon = log.status === 'completed' ? '✅' : 
                        log.status === 'error' ? '❌' : 
                        log.status === 'no_classes' ? '⚠️' : '📝';
      
      text += `${statusIcon} [${new Date(log.timestamp).toLocaleString()}]\n`;
      text += `   Type:     ${log.type}\n`;
      text += `   Status:   ${log.status}\n`;
      
      if (log.duration) {
        text += `   Duration: ${log.duration}ms\n`;
      }
      
      if (log.classes) {
        text += `   Classes:  ${log.classes}\n`;
      }
      
      if (log.totalChanges) {
        text += `   Changes:  ${log.totalChanges}\n`;
      }
      
      if (log.totalPushesSent) {
        text += `   Pushes:   ${log.totalPushesSent}\n`;
      }
      
      if (log.error) {
        text += `   Error:    ${log.error}\n`;
      }
      
      if (log.results && log.results.length > 0) {
        text += `   Results:\n`;
        log.results.forEach(result => {
          if (result.status === 'changes_detected') {
            text += `      🚨 ${result.className}: ${result.changes} changes (${result.redCountChange})\n`;
          } else if (result.status === 'no_changes') {
            text += `      ✓ ${result.className}: No changes\n`;
          } else if (result.status === 'error') {
            text += `      ❌ ${result.className}: ${result.message}\n`;
          }
        });
      }
      
      text += '\n';
      
      // Nach 20 Einträgen eine Trennlinie
      if (index === 19 && logs.length > 20) {
        text += '   ... (showing first 20 entries)\n\n';
      }
    });
  }
  
  text += '═══════════════════════════════════════════════════════════════\n';
  text += 'End of Logs\n';
  text += '═══════════════════════════════════════════════════════════════\n';
  
  return text;
}
