# Contributing to v-cube

Thanks for your interest in improving v-cube! This document covers how to get set up, the
quality bar, and how to propose changes.

## Getting started

```bash
git clone https://github.com/szautkin/v-cube.git
cd v-cube
npm install
npm run dev
```

You'll need Node.js 20+ and a WebGL2-capable browser. To experiment you need a FITS spectral
cube — any 3-axis `.fits` cube will do; public JCMT / JWST IFU `s3d` products are good test data.

## Before you open a pull request

Every change must pass the same checks CI runs:

```bash
npm run format:check   # prettier
npm run lint           # eslint
npm run typecheck      # tsc --noEmit
npm test               # vitest
npm run build          # production build succeeds
```

Run `npm run format` and `npm run lint:fix` to auto-fix most issues.

### Visual-truth end-to-end tests

The `scripts/verify-*.mjs` harnesses drive the app in a headless browser and assert that
rendered pixels and probe readouts match independently computed ground truth. They need a
running dev server and Playwright's browser:

```bash
npx playwright install chromium-headless-shell
npm run dev &                       # in one terminal
node scripts/verify-visuals.mjs     # value/colour truth
node scripts/verify-export.mjs      # export + figure plate
```

If you change rendering, normalization, WCS, or export, please run these and add a case for the
behaviour you touched.

## Coding guidelines

- **TypeScript, strict.** No new `tsc` errors.
- **Match the surrounding style** — Prettier (`printWidth: 120`, single quotes, semicolons,
  trailing commas) enforces formatting; ESLint enforces the rest.
- **Keep the `DataSource` seam clean.** Parser, WCS, ingest, and render code talk to the byte
  layer only through `read(offset, length)`. New transports (e.g. remote archives) should be a
  new `DataSource`, not special cases upstream.
- **Value truth is the product.** Slice mode shows exact file values; never let display
  quantization leak into a readout. If you touch the value→pixel path, extend the visual-truth
  harness.
- **Comments explain _why_,** not what — match the existing density.
- New source files carry the SPDX header:
  ```ts
  // SPDX-License-Identifier: AGPL-3.0-or-later
  // Copyright (C) <year> <you> and v-cube contributors
  ```

## Commit & PR

- Branch from `main`; keep PRs focused.
- Describe what changed and why; include before/after screenshots for visual changes.
- Link any related issue.
- By contributing you agree your contributions are licensed under AGPL-3.0-or-later.

## Reporting bugs & requesting features

Use the issue templates. For a bug, include the cube's dimensions/instrument (not the data
itself), your browser and GPU (the boot screen and the `GPU` badge report the WebGL renderer),
and steps to reproduce.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating you are
expected to uphold it.
