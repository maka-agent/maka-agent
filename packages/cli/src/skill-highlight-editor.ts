import { Editor } from '@earendil-works/pi-tui';
import { ansi } from './tui-ansi.js';
import { SKILL_INVOCATION_TOKEN_SOURCE } from './skill-token.js';

/**
 * Editor with `/skill:<name>` invocation highlighting (issue #1148). Valid
 * tokens render in the CLI brand accent; anything else stays plain — the
 * absence of the affordance IS the inactive state, so there is deliberately
 * no "failed" style.
 *
 * pi-tui's Editor has no span-decoration hook (its theme covers borders and
 * the autocomplete list only), so this subclass post-processes the rendered
 * lines: tokens are ASCII and the regex is prefix-anchored, so it can never
 * match inside the editor's own escape sequences (border colors, the inline
 * cursor's reverse-video marker). Two known, self-healing limits: a token
 * split across word-wrapped lines, and a token with the cursor inside it
 * (cursor escape codes break the plain-text match) render unhighlighted.
 */
export class MakaSkillHighlightEditor extends Editor {
  private isInvocable: (name: string) => boolean = () => false;

  /**
   * Swap the validator used by the render pass. Must be synchronous and
   * cheap (called per token per render) — the runner feeds it a snapshot of
   * the last fetched invocable-skill list.
   */
  setSkillTokenValidator(validator: (name: string) => boolean): void {
    this.isInvocable = validator;
    this.invalidate();
  }

  override render(width: number): string[] {
    const pattern = new RegExp(SKILL_INVOCATION_TOKEN_SOURCE, 'g');
    return super.render(width).map((line) =>
      line.replace(pattern, (whole, name: string) =>
        this.isInvocable(name) ? ansi.accent(whole) : whole,
      ),
    );
  }
}
