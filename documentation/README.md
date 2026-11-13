# Enclave documentation site

Nuxt 4 + Nuxt Content. Pages are Markdown with MDC (Markdown Components, Nuxt's equivalent of
MDX): write `::callout{type="tip" title="…"}` … `::` to use a component from
`app/components/content/`. Files and folders under `content/` are ordered by numeric prefix
(`1.getting-started.md`); the prefix is stripped from the URL.

```bash
cd documentation
npm install
npm run dev        # http://localhost:3000
npm run generate   # static site in .output/public
```

Deployment: `.github/workflows/docs.yml` generates the site on every push that touches
`documentation/` and publishes it to GitHub Pages. In the repository settings, set Pages →
Source to "GitHub Actions" once. The base URL is the repository name; the workflow derives it,
so renaming the repository needs no change here.
