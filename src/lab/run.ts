import { runLab } from './scenarios.js';

const results = await runLab();
const line = '─'.repeat(78);

console.log(`\n${line}\nPaywarden · Adversarial Commerce Lab\n${line}`);
for (const r of results) {
  console.log(`\n${r.protected ? '✅ PROTECTED' : '❌ FAILED   '}  ${r.id}  ${r.title}`);
  console.log(`   attack  : ${r.attack}`);
  console.log(`   defence : ${r.defence}`);
  console.log(`   evidence: ${r.evidence}`);
}
const ok = results.filter((r) => r.protected).length;
console.log(`\n${line}\n${ok}/${results.length} scenarios protected`);
console.log('Runs against the real gateway with an offline PayPal fake and the offline AI fallback.');
console.log(`${line}\n`);
process.exit(ok === results.length ? 0 : 1);
