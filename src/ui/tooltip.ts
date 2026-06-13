// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Serhii Zautkin and v-cube contributors
/**
 * HUD tooltips — one delegated listener; any element with data-tip gets a
 * cockpit-styled tooltip after a short hover dwell. Native title attributes
 * are not used so the look stays consistent with the rest of the chrome.
 */
export function initTooltips(): void {
  const tip = document.createElement('div');
  tip.id = 'hudTip';
  tip.hidden = true;
  document.body.appendChild(tip);

  let timer = 0;
  let current: HTMLElement | null = null;

  const hide = (): void => {
    window.clearTimeout(timer);
    tip.hidden = true;
    current = null;
  };

  document.addEventListener('pointerover', (e) => {
    const target = (e.target as HTMLElement).closest?.('[data-tip]') as HTMLElement | null;
    if (target === current) return;
    window.clearTimeout(timer);
    tip.hidden = true;
    current = target;
    if (!target) return;
    timer = window.setTimeout(() => {
      tip.textContent = target.dataset.tip ?? '';
      tip.hidden = false;
      const r = target.getBoundingClientRect();
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      let x = r.left + r.width / 2 - tw / 2;
      x = Math.max(8, Math.min(x, window.innerWidth - tw - 8));
      let y = r.bottom + 9;
      if (y + th > window.innerHeight - 8) y = r.top - th - 9;
      tip.style.left = `${x}px`;
      tip.style.top = `${y}px`;
    }, 350);
  });

  // Hide while interacting (slider drags, clicks) and when leaving the window.
  document.addEventListener('pointerdown', hide);
  document.addEventListener('pointerout', (e) => {
    if (!e.relatedTarget) hide();
  });
}
