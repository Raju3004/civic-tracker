// ---- Civic-themed animated background: a live city grid with issue pins dropping and pulsing ----
(function () {
  const canvas = document.getElementById('landing-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let w, h, cellSize, pins;

  function resize() {
    w = canvas.width = canvas.offsetWidth;
    h = canvas.height = canvas.offsetHeight;
    cellSize = Math.max(70, Math.min(110, w / 14));
  }

  function gridPoints() {
    const cols = Math.ceil(w / cellSize) + 1;
    const rows = Math.ceil(h / cellSize) + 1;
    const points = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        points.push({ x: c * cellSize, y: r * cellSize });
      }
    }
    return points;
  }

  function spawnPin(points) {
    const p = points[Math.floor(Math.random() * points.length)];
    return {
      x: p.x,
      y: p.y,
      age: 0,
      color: ['#E8A33D', '#3FA9A0', '#4C9A6A', '#E0685A'][Math.floor(Math.random() * 4)],
      life: 180 + Math.random() * 120,
    };
  }

  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function tick() {
    ctx.clearRect(0, 0, w, h);
    const points = gridPoints();

    ctx.strokeStyle = 'rgba(232, 163, 61, 0.06)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= w + cellSize; x += cellSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y <= h + cellSize; y += cellSize) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    if (Math.random() < 0.025 && pins.length < 14) {
      pins.push(spawnPin(points));
    }

    pins.forEach(pin => {
      pin.age++;
      const t = pin.age / pin.life;
      const dropIn = Math.min(1, pin.age / 20);
      const pulse = 1 + 0.25 * Math.sin(pin.age * 0.12);
      const alpha = t < 0.85 ? 1 : 1 - (t - 0.85) / 0.15;
      const radius = 5 * dropIn * pulse;

      ctx.beginPath();
      ctx.arc(pin.x, pin.y, radius * 2.2, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(pin.color, 0.08 * alpha);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(pin.x, pin.y - (1 - dropIn) * 30, radius, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(pin.color, 0.85 * alpha);
      ctx.fill();
    });
    pins = pins.filter(p => p.age < p.life);

    requestAnimationFrame(tick);
  }

  window.addEventListener('resize', resize);
  resize();
  pins = [];
  tick();
})();

// ---- Dismiss landing, hand off to the existing auth flow ----
(function () {
  const landing = document.getElementById('landing-view');
  if (!landing) return;

  if (localStorage.getItem('civictrack_token')) {
    landing.classList.add('hidden');
    return;
  }

  document.querySelectorAll('.landing-dismiss').forEach(btn => {
    btn.addEventListener('click', () => landing.classList.add('hidden'));
  });
})();