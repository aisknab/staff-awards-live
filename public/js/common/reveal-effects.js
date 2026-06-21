const COLORS = ['#ffd166', '#67d89a', '#ff7a90', '#7b8cff', '#f4f6fb', '#35d0ba'];

export function playRevealBurst(container, { variant = 'participant' } = {}) {
  if (!container) return;
  container.classList.add('winner-burst-active');
  if (prefersReducedMotion()) {
    container.classList.add('winner-burst-reduced');
    return;
  }

  const count = variant === 'display' ? 84 : 42;
  const burst = document.createElement('div');
  burst.className = `confetti-burst confetti-burst-${variant}`;
  burst.setAttribute('aria-hidden', 'true');

  const fragment = document.createDocumentFragment();
  for (let index = 0; index < count; index += 1) {
    const piece = document.createElement('span');
    piece.className = 'confetti-piece';
    const angle = (Math.PI * 2 * index) / count;
    const spread = variant === 'display' ? 520 : 260;
    const distance = spread * (0.42 + Math.random() * 0.58);
    const x = Math.cos(angle) * distance;
    const y = Math.sin(angle) * distance - (variant === 'display' ? 80 : 36);
    piece.style.setProperty('--x', `${x.toFixed(1)}px`);
    piece.style.setProperty('--y', `${y.toFixed(1)}px`);
    piece.style.setProperty('--fall', `${(variant === 'display' ? 170 : 90) + Math.random() * 90}px`);
    piece.style.setProperty('--rot', `${Math.round(Math.random() * 360)}deg`);
    piece.style.setProperty('--piece-color', COLORS[index % COLORS.length]);
    piece.style.animationDelay = `${Math.random() * 120}ms`;
    if (index % 3 === 0) piece.classList.add('round');
    fragment.append(piece);
  }

  burst.append(fragment);
  container.prepend(burst);
  window.setTimeout(() => burst.remove(), 3200);
}

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
