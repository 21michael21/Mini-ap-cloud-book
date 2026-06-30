# Reader Screenshot Baselines

Full pixel visual regression is intentionally not enabled yet. The reader e2e
suite can save local screenshots to `tests/screenshots/artifacts/` with:

```bash
cd miniapp
npm run e2e:reader:screenshots
```

Commit curated baselines here only after the reader UI stabilizes enough for
threshold-based visual comparison.
