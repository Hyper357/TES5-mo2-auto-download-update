# Architecture Notes

`v3.1-*` through `v3.7-*` document how individual safety layers were introduced. They are **historical/on-demand maintenance references**, not mandatory Agent startup context.

For normal operation use, in order:

1. `npm run agent:status`
2. `AGENTS.md` for hard safety rules
3. `SKILL.md` for operating workflow
4. only the specific `docs/v3.*` note that matches the subsystem being maintained

Current architecture is summarized in the root `README.md`.

Do not feed all versioned documents to an AI Agent for a routine audit/download task; they intentionally contain historical detail and can waste context or conflict with newer rules.
