// ---- EduMate-style animated network background ----
(function () {
  const canvas = document.getElementById('landing-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let w, h, nodes;

  function resize() {
    w = canvas.width = canvas.offsetWidth;
    h = canvas.height = canvas.offsetHeight;
  }

  function makeNodes() {
    const count = Math.floor((w * h) / 22000);
    nodes = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.25,
      vy: (Math.random() - 0.5) * 0.25,
      gold: Math.random() < 0.12,
    }));
  }

  function tick() {
    ctx.clearRect(0, 0, w, h);
    nodes.forEach(n => {
      n.x += n.vx;
      n.y += n.vy;
      if (n.x < 0 || n.x > w) n.vx *= -1;
      if (n.y < 0 || n.y > h) n.vy *= -1;
    });
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 140) {
          ctx.strokeStyle = `rgba(217, 174, 85, ${0.12 * (1 - dist / 140)})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(nodes[i].x, nodes[i].y);
          ctx.lineTo(nodes[j].x, nodes[j].y);
          ctx.stroke();
        }
      }
    }
    nodes.forEach(n => {
      ctx.fillStyle = n.gold ? '#D9AE55' : 'rgba(139, 156, 187, 0.5)';
      ctx.fillRect(n.x - 2, n.y - 2, n.gold ? 5 : 3, n.gold ? 5 : 3);
    });
    requestAnimationFrame(tick);
  }

  window.addEventListener('resize', () => {
    resize();
    makeNodes();
  });
  resize();
  makeNodes();
  tick();
})();

// ---- Dismiss landing, hand off to the existing auth flow ----
(function () {
  const landing = document.getElementById('landing-view');
  if (!landing) return;

  // Already-logged-in users skip the landing page entirely
  if (localStorage.getItem('civictrack_token')) {
    landing.classList.add('hidden');
    return;
  }

  document.querySelectorAll('.landing-dismiss').forEach(btn => {
    btn.addEventListener('click', () => landing.classList.add('hidden'));
  });
})();