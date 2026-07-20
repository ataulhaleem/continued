# Contributing to Continued

Thanks for helping improve Continued.

## Quick Start

1. Fork the repository
2. Create a branch from `main`
3. Make your changes
4. Run checks locally:
   - `npm run check-types`
   - `npm run lint`
   - `npm run compile`
5. Open a Pull Request

## Development Guidelines

- Keep changes focused and minimal.
- Preserve existing behavior unless the PR is explicitly a behavior change.
- Prefer clear naming and readable code over clever shortcuts.
- Add or update docs when changing UX or workflows.

## Plugin System Contributions

Continued supports community plugins under `.continued/plugins/` using:

- `tool` plugins (`execute(args)`)
- `resource` plugins (`fetch()`)
- `skill` plugins (`execute()`)

If your contribution affects plugin behavior, include:

- expected user flow
- edge cases handled
- backward compatibility notes

## Pull Request Checklist

- [ ] Feature or fix is scoped and documented
- [ ] Type check passes
- [ ] Lint passes
- [ ] Build succeeds
- [ ] No unrelated refactors included

## Reporting Issues

Please use GitHub issue templates for:

- Bug reports
- Feature requests
- Plugin showcase ideas

## Code of Conduct

Be respectful, constructive, and concise.
