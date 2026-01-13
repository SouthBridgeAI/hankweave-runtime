/**
 * Build-time constants injected by the build script via Bun's --define flag.
 * These are only available when running from a compiled executable.
 *
 * The values are replaced at compile-time, making them zero-cost at runtime.
 *
 * @see https://bun.com/docs/guides/runtime/build-time-constants
 */

declare const BUILD_VERSION: string;
declare const BUILD_DATE: string;
declare const BUILD_TARGET: string;
