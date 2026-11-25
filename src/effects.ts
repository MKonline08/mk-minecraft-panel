// Interactive flourishes for the "neon overworld" theme.
// Everything is delegated from document so it works for any card React renders,
// and it all switches off when the visitor prefers reduced motion.

const GLOW =
  ".server-card, .stat, .panel, .resource-card, .player-card, .auth-box, .modal";
const TILT = ".server-card";
const RIPPLE = "button, .button";

const reduced = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

function pointerGlow(event: PointerEvent) {
  const target = event.target as Element | null;
  const card = target?.closest?.(GLOW) as HTMLElement | null;
  if (!card) return;
  const box = card.getBoundingClientRect();
  card.style.setProperty("--mx", `${event.clientX - box.left}px`);
  card.style.setProperty("--my", `${event.clientY - box.top}px`);
  if (reduced() || !card.matches(TILT)) return;
  const x = (event.clientX - box.left) / box.width - 0.5;
  const y = (event.clientY - box.top) / box.height - 0.5;
  card.style.setProperty("--tilt-x", `${(-y * 5).toFixed(2)}deg`);
  card.style.setProperty("--tilt-y", `${(x * 7).toFixed(2)}deg`);
}

function resetTilt(event: PointerEvent) {
  const card = (event.target as Element | null)?.closest?.(
    TILT,
  ) as HTMLElement | null;
  if (!card || card.contains(event.relatedTarget as Node | null)) return;
  card.style.setProperty("--tilt-x", "0deg");
  card.style.setProperty("--tilt-y", "0deg");
}

function ripple(event: PointerEvent) {
  if (reduced() || event.button !== 0) return;
  const button = (event.target as Element | null)?.closest?.(
    RIPPLE,
  ) as HTMLElement | null;
  if (!button || (button as HTMLButtonElement).disabled) return;
  const box = button.getBoundingClientRect();
  const size = Math.max(box.width, box.height) * 2;
  const wave = document.createElement("span");
  wave.className = "mk-ripple";
  wave.style.width = wave.style.height = `${size}px`;
  wave.style.left = `${event.clientX - box.left - size / 2}px`;
  wave.style.top = `${event.clientY - box.top - size / 2}px`;
  button.appendChild(wave);
  wave.addEventListener("animationend", () => wave.remove(), { once: true });
}

function scrolled() {
  document.documentElement.classList.toggle("mk-scrolled", window.scrollY > 8);
}

export function installEffects() {
  if (typeof window === "undefined") return;
  document.documentElement.classList.add("mk-fx");
  document.addEventListener("pointermove", pointerGlow, { passive: true });
  document.addEventListener("pointerout", resetTilt, { passive: true });
  document.addEventListener("pointerdown", ripple, { passive: true });
  window.addEventListener("scroll", scrolled, { passive: true });
  scrolled();
}
