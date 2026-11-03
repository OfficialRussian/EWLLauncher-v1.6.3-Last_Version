'use strict';
/** Правила (rules) из JSON версий Minecraft: какие библиотеки/аргументы применимы к этой системе. */
const os = require('os');

function currentContext(overrides = {}) {
  const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
  const arch = process.arch === 'ia32' ? 'x86' : process.arch; // x86 | x64 | arm64
  return { platform, arch, osVersion: os.release(), features: {}, ...overrides };
}

function ruleApplies(rule, ctx) {
  if (rule.os) {
    if (rule.os.name && rule.os.name !== ctx.platform) return false;
    if (rule.os.arch && rule.os.arch !== ctx.arch) return false;
    if (rule.os.version) {
      try { if (!new RegExp(rule.os.version).test(ctx.osVersion)) return false; } catch (_) { return false; }
    }
  }
  if (rule.features) {
    for (const [k, v] of Object.entries(rule.features)) {
      if (!!ctx.features[k] !== !!v) return false;
    }
  }
  return true;
}

/** Без правил — разрешено. Иначе последнее подошедшее правило определяет результат. */
function isAllowed(rules, ctx) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let ok = false;
  for (const r of rules) {
    if (ruleApplies(r, ctx)) ok = r.action === 'allow';
  }
  return ok;
}

module.exports = { currentContext, ruleApplies, isAllowed };
