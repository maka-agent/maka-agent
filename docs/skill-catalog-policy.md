# Skill catalog policy

Maka keeps skill bodies out of the always-on system prompt. The prompt contains
only a bounded catalog; the read-only `Skill` tool loads full instructions when
a task matches a skill.

The catalog is selected deterministically in this order:

1. Discover skill directories in source precedence order. Project-level paths
   precede workspace compatibility paths, which precede user-level paths.
   Duplicate ids use first-found wins. Skills within one directory are ordered
   by display name.
2. Exclude disabled skills.
3. When the host supplies capabilities, exclude skills whose explicit
   `required-tools` or `required-capabilities` are unavailable. `allowed-tools`
   remains informational and never grants permission.
4. Add catalog entries in the resulting order until the selected model's
   catalog budget is reached. The budget is 2% of its context window, clamped
   to 4,000–8,000 estimated tokens and converted at four characters per token.
   If the context window is unavailable, use the backward-compatible
   `MAX_SKILLS_PROMPT_CHARS = 18000` character budget.

The lower bound keeps useful catalogs available on small-context models. The
upper bound prevents large-context models from turning the catalog into an
unbounded always-on cost. Because changing models can change the selected
catalog, the model context window is an explicit prompt input rather than an
implicit provider lookup inside the skill scanner.

When the budget omits entries, the prompt lists their ids. Omission affects only
catalog advertisement: an enabled, host-compatible omitted skill remains
loadable by id or name through the `Skill` tool. Skill instructions are subject
to their separate lazy-load body limit.
