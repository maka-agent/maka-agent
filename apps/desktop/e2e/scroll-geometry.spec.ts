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
    // The warm-up forces inline content-visibility per chunk and clears it on
    // release; any remaining forced turn means the walk is still in flight.
    // Guards against a stalled compositor freezing MID-WALK geometry into a
    // false "settled" (frozen reads are equal reads).
    warming: Boolean(document.querySelector('.maka-turn[style*="content-visibility"]')),
  };
})()`;

// The fixture's 24 turns are 60 filler lines each (>1000px real, 250px as a
// placeholder), so the whole transcript is ~15k px un-warmed vs ~32k warmed.
// A settle check must first see final-scale height — two early reads agreeing
// on the PLACEHOLDER height would otherwise declare "settled" before the
// warm-up even starts (fonts / lazy-markdown gates delay it on slow machines).
const WARMED_HEIGHT_FLOOR = 24 * 800;

async function settleGeometry(page: import('@playwright/test').Page, options: { pinned: boolean }): Promise<void> {
  let previousHeight = -1;
  await expect.poll(async () => {
    const current = await page.evaluate(probeScroller) as {
      scrollHeight: number;
      distanceFromBottom: number;
      warming: boolean;
    };
    const settled = !current.warming
      && current.scrollHeight > WARMED_HEIGHT_FLOOR
      && current.scrollHeight === previousHeight
      && (!options.pinned || current.distanceFromBottom === 0);
    previousHeight = current.scrollHeight;
    return settled;
  }, { timeout: 15_000, intervals: [500] }).toBe(true);
}

test('long session opens pinned to bottom and stays pinned while geometry settles', async ({ longTranscriptWindow: page }) => {
  await expect(page.locator('.maka-turn')).toHaveCount(24);

  // Pinned from the start: the session-open pin must hold. During the idle
  // warm-up the document grows by thousands of pixels with no mutation and
  // no scroll event — the follower must ride every growth step, so the
  // distance stays 0 while scrollHeight rises to its final value.
  await expect.poll(async () => (await page.evaluate(probeScroller)).distanceFromBottom).toBe(0);

  // Geometry settled = final-scale height and two consecutive reads agreeing
  // on it while still pinned. A fixed sleep would race the warm-up.
  await settleGeometry(page, { pinned: true });
});

async function climbToTop(page: import('@playwright/test').Page) {
  return await page.evaluate(async () => {
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
}

function expectHonestClimb(run: Awaited<ReturnType<typeof climbToTop>>): void {
  expect(run.atTop).toBe(true);
  // One height for the whole climb: no placeholder inflated mid-scroll.
  expect(run.distinctHeights).toHaveLength(1);
  // And the climb took the honest number of steps — the "endless scroll"
  // symptom was precisely needing ~2x more.
  expect(run.steps).toBeLessThanOrEqual(run.honestSteps + 2);
}

test('scrolling a settled long session to the top never inflates the document', async ({ longTranscriptWindow: page }) => {
  await expect(page.locator('.maka-turn')).toHaveCount(24);

  // Wait for the warm-up to settle so this test isolates invariant (b);
  // the pinned test above owns the during-warm-up behavior.
  await settleGeometry(page, { pinned: false });

  expectHonestClimb(await climbToTop(page));
});

test('returning to the session after visiting skills re-settles the new transcript DOM', async ({ longTranscriptWindow: page }) => {
  await expect(page.locator('.maka-turn')).toHaveCount(24);
  await settleGeometry(page, { pinned: true });

  // A mode switch unmounts the chat scroller; coming back rebuilds every
  // `.maka-turn` node with no remembered size, so the warm-up must walk the
  // NEW DOM. Fixture windows don't pass OS hit-testing — dispatch clicks.
  await page.locator('button[aria-label="展开侧边栏"]').dispatchEvent('click');
  await page.locator('button[aria-label="技能"]').dispatchEvent('click');
  await expect(page.locator('.maka-turn')).toHaveCount(0);
  await page.getByText('超长会话滚动几何').first().dispatchEvent('click');
  await expect(page.locator('.maka-turn')).toHaveCount(24);

  await settleGeometry(page, { pinned: true });
  expectHonestClimb(await climbToTop(page));
});
