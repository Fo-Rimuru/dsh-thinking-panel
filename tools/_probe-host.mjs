/**
 * 诊断脚本：用假 ctx 跑一遍 Host 半部的 apply()，看它是否抛错、
 * 以及 registerUpdateRoutes 到底有没有被调用。
 *   node tools/_probe-host.mjs
 */
import { apply } from '../index.js';

const calls = [];
const fakeDisposer = () => { calls.push('dispose'); };

const ctx = {
  inject(deps, cb) {
    calls.push(`inject(${deps.join(',')})`);
    // 故意不调用 cb —— 真实环境里它只在服务就绪时才跑，
    // 这里只验证「有没有走到这一步」。
  },
  effect(fn, label) {
    calls.push(`effect(${label})`);
    try {
      const result = fn();
      return typeof result === 'function' ? result : fakeDisposer;
    } catch (error) {
      calls.push(`effect THREW: ${error && error.message}`);
      throw error;
    }
  },
  systemPrompt: {
    section(spec) { calls.push(`section(${spec.name})`); return fakeDisposer; },
    context(spec) { calls.push(`context(${spec.name})`); return fakeDisposer; },
  },
  locale: { register() {}, bind: () => (key) => key },
  slots: { inject() {}, register() {} },
};

try {
  apply(ctx, { mode: 'auto' });
  console.log('apply() returned normally');
} catch (error) {
  console.log('apply() THREW:', error && error.message);
  console.log(String(error && error.stack).split('\n').slice(0, 6).join('\n'));
}
console.log('--- call trace ---');
for (const line of calls) console.log(' ', line);
