// Shows which PayPal and AI mode this server is running in, from the public /health endpoint.
(async () => {
  const env = document.getElementById('env');
  try {
    const res = await fetch('/health', { cache: 'no-store' });
    const h = await res.json();
    const pill = (label, value, warn) => {
      const span = document.createElement('span');
      span.className = `env-pill${warn ? ' env-pill-warn' : ''}`;
      const b = document.createElement('b');
      b.textContent = value;
      span.append(`${label} `, b);
      return span;
    };
    env.replaceChildren(
      pill('PayPal', h.paypal === 'fake' ? 'offline fake' : 'sandbox', h.paypal === 'fake'),
      pill('AI', String(h.ai).split(' (')[0], String(h.ai).startsWith('heuristic')),
    );
  } catch {
    env.textContent = '';
  }
})();
