/**
 * The one place the harness version lives (WP-53).
 *
 * `pnpm check:version` fails when this disagrees with the root package.json, so
 * the release feed comparison and `bootstrap.version` can never drift from the
 * version that was actually built.
 */
export const HARNESS_VERSION = '0.5.0'
