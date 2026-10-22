# Patches requiring elevated permissions

## `ci-node-matrix.patch`

Fixes review finding **B3** in `.github/workflows/node.js.yml`.

This change could not be pushed by the automated tooling: the GitHub App token
in use is granted contents permission but **not** `workflows` permission, so
any push touching `.github/workflows/` is rejected with:

```
remote rejected (refusing to allow a GitHub App to create or update workflow
`.github/workflows/node.js.yml` without `workflows` permission)
```

Apply it yourself from the repository root:

```bash
git apply patches/ci-node-matrix.patch
git commit -am "ci: use Node 22/24 and run npm run check"
git push
```

### What it changes and why

1. **Node matrix `[18.x, 20.x, 22.x]` → `[22.x, 24.x]`.**
   `wrangler@4.136.1` declares `engines.node >=22.0.0` and `vitest@4.1.10`
   declares `^20.0.0 || ^22.0.0 || >=24.0.0`. Node 18 satisfies neither and has
   been past end-of-life since April 2025, so that leg of the matrix can never
   pass.

2. **`npm run build --if-present` → `npm run check`.**
   There is no `build` script, so the old step was a silent no-op that always
   "succeeded". `npm run check` runs `tsc --noEmit && wrangler deploy
   --dry-run`, which is this project's actual verification and currently
   passes.

Without this patch the workflow still runs the (now green) test suite, but the
`18.x` leg will fail on the Node version alone.
