const winston = require('winston');
const { getRequestContext } = require('./requestContext');

const isDev = process.env.NODE_ENV !== 'production';
const REDACTED = '[REDACTED]';
const STELLAR_SECRET_PATTERN = /^S[A-Z2-7]{55}$/;
const SENSITIVE_KEY_PATTERN = /(secret|private.?key|seed|token|authorization|cookie|password)/i;

function sanitizeValue(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    return STELLAR_SECRET_PATTERN.test(value) ? REDACTED : value;
  }

  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : sanitizeValue(entry, seen),
    ])
  );
}

function sanitizeInfoObject(info) {
  const sanitized = sanitizeValue(info);
  for (const key of Object.keys(info)) {
    delete info[key];
  }
  Object.assign(info, sanitized);
  return info;
}

const addRequestId = winston.format((info) => {
  const { requestId } = getRequestContext();
  if (requestId) info.request_id = requestId;
  return info;
});

const redactSensitiveValues = winston.format((info) => {
  return sanitizeInfoObject(info);
});

// Single source of truth for log-level configuration (#398). env.js validates
// startup with this same resolver, so a level accepted there is never silently
// replaced here.
const DEFAULT_LOG_LEVEL = 'info';
const LOG_LEVELS = Object.keys(winston.config.npm.levels);

function warnToStderr(message) {
  process.stderr.write(`[crowdpay] Warning: ${message}\n`);
}

function resolveLogLevel(rawLevel, warn = warnToStderr) {
  if (rawLevel === undefined || rawLevel === null || String(rawLevel).trim() === '') {
    return DEFAULT_LOG_LEVEL;
  }
  const normalized = String(rawLevel).trim().toLowerCase();
  if (LOG_LEVELS.includes(normalized)) return normalized;
  warn(
    `invalid LOG_LEVEL "${rawLevel}" — falling back to "${DEFAULT_LOG_LEVEL}". Valid levels: ${LOG_LEVELS.join(', ')}`
  );
  return DEFAULT_LOG_LEVEL;
}

/**
 * Parse LOG_LEVEL_MODULES ("module=level,module=level"). Malformed entries and
 * entries with an unknown level are ignored with a warning, so a typo never
 * changes a module's verbosity.
 */
function parseModuleOverrides(rawOverrides, warn = warnToStderr) {
  const overrides = {};
  if (!rawOverrides) return overrides;

  for (const entry of String(rawOverrides).split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      warn(`ignoring malformed LOG_LEVEL_MODULES entry "${trimmed}" (expected module=level)`);
      continue;
    }
    const moduleName = trimmed.slice(0, separatorIndex).trim();
    const level = trimmed.slice(separatorIndex + 1).trim().toLowerCase();
    if (!moduleName || !LOG_LEVELS.includes(level)) {
      warn(`ignoring invalid LOG_LEVEL_MODULES entry "${trimmed}"`);
      continue;
    }
    overrides[moduleName] = level;
  }

  return overrides;
}

/** Resolve { level, moduleOverrides } from LOG_LEVEL and LOG_LEVEL_MODULES. */
function resolveLogConfig(env = process.env, warn = warnToStderr) {
  return {
    level: resolveLogLevel(env.LOG_LEVEL, warn),
    moduleOverrides: parseModuleOverrides(env.LOG_LEVEL_MODULES, warn),
  };
}

const { level: baseLevel, moduleOverrides } = resolveLogConfig();

// Applies per-module level overrides by dropping records below the configured
// level for the module that emitted them. Records without a module (or with a
// module that has no override) are left untouched and use the base level.
const applyModuleLevelOverrides = winston.format((info) => {
  const moduleName = info.module || info.moduleName;
  if (!moduleName || !Object.prototype.hasOwnProperty.call(moduleOverrides, moduleName)) {
    return info;
  }
  const overrideLevel = moduleOverrides[moduleName];
  if (info.level !== overrideLevel && !winston.config.npm.levels[info.level]) {
    return info;
  }
  const threshold = winston.config.npm.levels[overrideLevel];
  const current = winston.config.npm.levels[info.level];
  if (current === undefined) return info;
  return current <= threshold ? info : false;
});

const logger = winston.createLogger({
  level: baseLevel,
  format: winston.format.combine(
    addRequestId(),
    redactSensitiveValues(),
    applyModuleLevelOverrides(),
    winston.format.timestamp(),
    isDev
      ? winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, request_id, ...meta }) => {
            const idStr = request_id ? ` [${String(request_id).slice(0, 8)}]` : '';
            const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
            return `${timestamp}${idStr} ${level}: ${message}${metaStr}`;
          })
        )
      : winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});

logger.levels = winston.config.npm.levels;
logger.moduleOverrides = moduleOverrides;

module.exports = logger;
module.exports.LOG_LEVELS = LOG_LEVELS;
module.exports.DEFAULT_LOG_LEVEL = DEFAULT_LOG_LEVEL;
module.exports.resolveLogConfig = resolveLogConfig;
