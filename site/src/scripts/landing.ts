/*
 * The demo's four states (components/landing/Demo.astro). All this does is
 * set `data-step` on the frame and say which step is current; the CSS draws
 * the rest.
 *
 * It plays by itself while it is on screen, slowly, and stops for good the
 * moment the reader takes over: a click on a step, or on Pause. With
 * `prefers-reduced-motion` it never starts on its own, and the steps still
 * work (the CSS drops their transitions).
 */

const STEP_MS = [2600, 3200, 2600, 4200];

for (const demo of document.querySelectorAll<HTMLElement>("[data-demo]")) {
  const frame = demo.querySelector<HTMLElement>(".frame");
  const buttons = [...demo.querySelectorAll<HTMLButtonElement>("[data-go]")];
  const play = demo.querySelector<HTMLButtonElement>("[data-play]");
  const label = demo.querySelector<HTMLElement>("[data-play-label]");
  if (!frame || !play || !label || buttons.length === 0) continue;

  const still = matchMedia("(prefers-reduced-motion: reduce)");
  let step = 0;
  let playing = !still.matches;
  let visible = false;
  let hovered = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // The frame is a window: it keeps the height of its fullest state, so the
  // page below does not move when two rows merge away.
  const hold = () => {
    const at = frame.dataset.step ?? "0";
    frame.classList.add("measuring");
    frame.dataset.step = "0";
    frame.style.minHeight = "";
    frame.style.minHeight = `${frame.offsetHeight}px`;
    frame.dataset.step = at;
    // Let the restored state apply before transitions are back.
    void frame.offsetHeight;
    frame.classList.remove("measuring");
  };

  const show = (next: number) => {
    step = (next + buttons.length) % buttons.length;
    frame.dataset.step = String(step);
    buttons.forEach((button, i) => {
      if (i === step) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    });
  };

  const schedule = () => {
    clearTimeout(timer);
    if (!playing || !visible || hovered) return;
    timer = setTimeout(() => {
      show(step + 1);
      schedule();
    }, STEP_MS[step]);
  };

  const setPlaying = (on: boolean) => {
    playing = on;
    play.setAttribute("aria-pressed", String(on));
    label.textContent = on ? "Pause" : "Play";
    schedule();
  };

  for (const button of buttons) {
    button.addEventListener("click", () => {
      show(Number(button.dataset.go));
      setPlaying(false);
    });
  }

  play.hidden = false;
  play.addEventListener("click", () => setPlaying(!playing));
  setPlaying(playing);

  // Reading it is not the moment for it to change.
  demo.addEventListener("pointerenter", () => {
    hovered = true;
    schedule();
  });
  demo.addEventListener("pointerleave", () => {
    hovered = false;
    schedule();
  });

  new IntersectionObserver(
    ([entry]) => {
      visible = entry?.isIntersecting ?? false;
      schedule();
    },
    { threshold: 0.4 },
  ).observe(frame);

  still.addEventListener("change", () => {
    if (still.matches) setPlaying(false);
  });

  hold();
  void document.fonts?.ready.then(hold);
  // Only a new width changes the frame's height (a phone's address bar
  // resizes the window all the time, and only in height).
  let width = innerWidth;
  addEventListener("resize", () => {
    if (innerWidth === width) return;
    width = innerWidth;
    hold();
  });
}
