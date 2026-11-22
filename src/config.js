'use strict';
const os = require('os');
const path = require('path');

function loadConfig(overrides = {}) {
  try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* no .env file */ }
  const env = process.env;
  const int = (k, d) => { const v = parseInt(env[k], 10); return Number.isFinite(v) ? v : d; };
  const bool = (k, d) => { const v = env[k]; if (v === undefined || v === '') return d; return /^(1|true|yes|on)$/i.test(v); };
  const list = (k, d) => (env[k] ?? d).split(',').map((s) => s.trim()).filter(Boolean);

  const cfg = {
    host: env.HOST || '127.0.0.1',
    port: int('PORT', 3000),
    tempRoot: env.TEMP_ROOT || path.join(os.tmpdir(), 'webcollector'),
    // Session lifetime
    sessionIdleMinutes: int('SESSION_IDLE_MINUTES', 45),
    sessionMaxMinutes: int('SESSION_MAX_MINUTES', 240),
    cleanupIntervalSec: int('CLEANUP_INTERVAL_SEC', 30),
    maxSessions: int('MAX_SESSIONS', 2),
    // Collection limits
    maxFileBytes: int('MAX_FILE_MB', 50) * 1024 * 1024,
    maxTotalBytes: int('MAX_TOTAL_MB', 500) * 1024 * 1024,
    maxFiles: int('MAX_FILES', 5000),
    maxPages: int('MAX_PAGES', 300),
    maxSnapshotsPerPage: int('MAX_SNAPSHOTS_PER_PAGE', 12),
    maxScreenshotsPerPage: int('MAX_SCREENSHOTS_PER_PAGE', 4),
    maxConcurrentCollect: int('MAX_CONCURRENT_COLLECT', 6),
    collectJson: bool('COLLECT_JSON', true),
    collectSourceMaps: bool('COLLECT_SOURCE_MAPS', true),
    collectMedia: bool('COLLECT_MEDIA', false),
    navTimeoutMs: int('NAV_TIMEOUT_MS', 30000),
    // Browser
    chromiumNoSandbox: bool('CHROMIUM_NO_SANDBOX', false),
    screencastQuality: int('SCREENCAST_QUALITY', 60),
    // Network policy
    allowedPorts: list('ALLOWED_PORTS', '80,443,8080,8443').map(Number).filter(Boolean),
    // Entries "host:port" that skip the private-address block. TESTING ONLY.
    testAllowHosts: list('TEST_ALLOW_HOSTS', ''),
    // HTTP
    allowedOrigins: list('ALLOWED_ORIGINS', ''),
    trustProxy: bool('TRUST_PROXY', false),
    cookieSecure: env.COOKIE_SECURE || 'auto', // auto | always | never
    rateLimitPerMinute: int('RATE_LIMIT_PER_MINUTE', 600),
    startLimitPerMinute: int('START_LIMIT_PER_MINUTE', 12),
    logLevel: env.LOG_LEVEL || 'info',
  };
  return Object.assign(cfg, overrides);
}

module.exports = { loadConfig };
