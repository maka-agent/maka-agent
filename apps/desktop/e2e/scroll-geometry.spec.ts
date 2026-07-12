import { test, expect } from './fixtures';

/**
 * Scroll-geometry contract for content-visibility chat turns.
 *
 * `.maka-turn` renders off-screen turns at a 250px contain-intrinsic-size
 * placeholder. On a fresh mount of a long session that geometry is a ~25x
 * underestimate, which used to (a) strand the pinned viewport mid-document
 * once turns inflated (inflation fires no mutation and no scroll event) and
 * (b) make upward scrolling "endless": the document grew turn by turn while
 * scroll anchoring kept repositioning. The idle warm-up + the pinned-bottom
 * ResizeObserver channel fix both; this spec locks the two user-visible
 * invariants.
 *
 * Probes read only scroller metrics. Per-turn getBoundingClientRect would
 * force-render skipped turns and mask the regression being tested.
 */

const probeScroller = `(() => {
  const scroller = document.querySelector('.maka-chatViewport');
  return {
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
    distanceFromBottom: Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight),
  };
})()`;

test('long session opens pinned to bottom and stays pinned while geometry settles', async ({ longTranscriptWindow: page }) => {
  await expect(page.locator('.maka-turn')).toHaveCount(24);

  // Pinned from the start: the session-open pin must hold. During the idle
  // warm-up the document grows by thousands of pixels with no mutation and
  // no scroll event — the follower must ride every growth step, so the
  // distance stays 0 while scrollHeight rises to its final value.
  await expect.poll(async () => (await page.evaluate(probeScroller)).distanceFromBottom).toBe(0);

  // Geometry settled = two consecutive reads agree on scrollHeight while
  // still pinned. A fixed sleep would race the warm-up on slow machines.
  let previousHeight = -1;
  await expect.poll(async () => {
    const current = await page.evaluate(probeScroller) as { scrollHeight: number; distanceFromBottom: number };
    const settled = current.scrollHeight === previousHeight && current.distanceFromBottom === 0;
    previousHeight = current.scrollHeight;
    return settled;
  }, { timeout: 15_000, intervals: [500] }).toBe(true);
});

test('scrolling a settled long session to the top never inflates the document', async ({ longTranscriptWindow: page }) => {
  await expect(page.locator('.maka-turn')).toHaveCount(24);

  // Wait for the warm-up to settle so this test isolates invariant (b);
  // the pinned test above owns the during-warm-up behavior.
  let previousHeight = -1;
  await expect.poll(async () => {
    const current = await page.evaluate(probeScroller) as { scrollHeight: number };
    const settled = current.scrollHeight === previousHeight;
    previousHeight = current.scrollHeight;
    return settled;
  }, { timeout: 15_000, intervals: [500] }).toBe(true);

  const run = await page.evaluate(async () => {
    const scroller = document.querySelector('.maka-chatViewport') as HTMLElement;
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    scroller.scrollTop = scroller.scrollHeight;
    await frame();
    const heights = new Set<number>([scroller.scrollHeight]);
    let steps = 0;
    // Viewport-sized steps, like a fast user scroll. The cap is a runaway
    // guard far above the honest step count.
    for (; steps < 120; steps++) {
      scroller.scrollBy(0, -scroller.clientHeight);
      await frame();
      heights.add(scroller.scrollHeight);
      if (scroller.scrollTop === 0) break;
    }
    return {
      atTop: scroller.scrollTop === 0,
      distinctHeights: [...heights],
      steps,
      honestSteps: Math.ceil(scroller.scrollHeight / scroller.clientHeight),
    };
  });

  expect(run.atTop).toBe(true);
  // One height for the whole climb: no placeholder inflated mid-scroll.
  expect(run.distinctHeights).toHaveLength(1);
  // And the climb took the honest number of steps — the "endless scroll"
  // symptom was precisely needing ~2x more.
  expect(run.steps).toBeLessThanOrEqual(run.honestSteps + 2);
});
