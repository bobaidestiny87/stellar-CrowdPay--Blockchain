const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const winston = require('winston');
const env = require('./env');
const logger = require('./logger');

const BACKEND = path.join(__dirname, '..', '..');

function resolve(vars) {
  const warnings = [];
  const result = logger.resolveLogConfig(vars, (message) => warnings.push(message));
  return { ...result, warnings };
}

test('env.js and logger.js share one log-level resolver (#398)', () => {
  assert.equal(env.resolveLogConfig, logger.resolveLogConfig);
  assert.equal(env.LOG_LEVELS, logger.LOG_LEVELS);
  assert.equal(env.DEFAULT_LOG_LEVEL, logger.DEFAULT_LOG_LEVEL);
  assert.deepEqual(logger.LOG_LEVELS, Object.keys(winston.config.npm.levels));
});

test('every winston level is accepted, case-insensitively', () => {
  for (const level of logger.LOG_LEVELS) {
    assert.deepEqual(resolve({ LOG_LEVEL: level.toUpperCase() }).level, level);
  }
});

test('an unknown LOG_LEVEL falls back to info with one warning', () => {
  const { level, warnings } = resolve({ LOG_LEVEL: 'loud' });
  assert.equal(level, 'info');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /invalid LOG_LEVEL "loud"/);
});

test('LOG_LEVEL_MODULES keeps valid entries and drops malformed or unknown ones', () => {
  const { moduleOverrides, warnings } = resolve({
    LOG_LEVEL_MODULES: 'ledgerMonitor=HTTP, api=debug, broken, =warn, webhooks=loud',
  });
  assert.deepEqual(moduleOverrides, { ledgerMonitor: 'http', api: 'debug' });
  assert.equal(warnings.length, 3);
});

// The bug: LOG_LEVEL=http passed startup validation, then the logger silently
// fell back to info. Boot both in a clean process and compare.
test('a level that passes startup validation is the level the logger uses', () => {
  for (const level of ['http', 'verbose', 'silly', 'debug']) {
    const script = `
      const env = require('./src/config/env');
      const logger = require('./src/config/logger');
      console.log(JSON.stringify({ validated: env.resolveLogConfig().level, used: logger.level }));
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: BACKEND,
      env: { PATH: process.env.PATH, LOG_LEVEL: level, NODE_ENV: 'test' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const { validated, used } = JSON.parse(result.stdout.trim().split('\n').pop());
    assert.equal(validated, level);
    assert.equal(used, level, `LOG_LEVEL=${level} validated but the logger used ${used}`);
    assert.doesNotMatch(result.stderr, /invalid LOG_LEVEL/);
  }
});
