# Contributing to Kute

Contributions are welcome! Please read this before you open a pull request, it saves both of us time.

## Where to start

Issues labeled [`help wanted`](https://github.com/NullDev/Kute/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22help%20wanted%22) are the best place to start. These are things I actually want in the client, so a good PR for one of them will most likely get merged.

Bug fixes are always welcome too.

## New features: ask first

If you want to add a new feature, please [open an issue](https://github.com/NullDev/Kute/issues/new) and ask before you start working on it. There is no guarantee that a feature gets merged, even if it is well made.

Kute aims for a balance between simplicity and usefulness. It is not meant to have every feature possible, and feature overload is something I actively try to avoid. Asking first means you do not spend hours on something that will not be accepted.

## Human written and tested code only

All submitted code must be at least audited and tested by a human. That means you have read and understood every line you submit, and you have actually run the client with your change.

AI generated PRs and purely "vibe coded" submissions will be closed without review.

AI assisted code is fine as long as it is reviewed, tested, and understood by a human before submission.

## Performance comes first

Code must **never** impact performance in a negative way. This is a performance-focused client, and that is not negotiable.

- If a feature costs performance for everyone, it will not be added.
- If a feature costs performance but is still worth having for some players, it has to be behind a setting that is **off by default**.
- If your change touches something that runs every frame, on a timer, or inside an observer during a match, expect to be asked how you measured it.

## Before you open a PR

- Run `bun run lint` and `bun run typecheck`.
- Run `cargo fmt --all` and `cargo clippy --workspace --features editor-ignore,verbose-logs` if you changed Rust code.
- The same checks run automatically on every pull request, and a PR has to pass them.
- Keep the PR focused on one thing. Unrelated changes make it harder to review.
- Describe what you changed, why, and how you tested it.

See [BUILDING.md](BUILDING.md) for how to set up and build the project.
