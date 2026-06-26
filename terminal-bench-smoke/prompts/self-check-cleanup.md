Before finishing, restore the task workspace to a verifier-clean state.

If you run any self-check that creates temporary outputs, logs, probes,
instrumented files, caches, or other validation artifacts, delete those
self-check artifacts after you finish using them. Do not leave stale runtime
outputs that the official verifier is expected to create fresh.

Keep the final required answer files or implementation files intact. Only remove
self-check byproducts and temporary validation state.
