// Static documentation site. `npm run generate` writes .output/public, which GitHub Pages serves.
// The base URL is the repository name on Pages (https://<user>.github.io/<repo>/); the deploy
// workflow sets NUXT_APP_BASE_URL, and locally it defaults to '/'.
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  modules: ['@nuxt/content'],
  ssr: true,
  devtools: { enabled: false },
  app: {
    baseURL: process.env.NUXT_APP_BASE_URL || '/',
    head: {
      htmlAttrs: { lang: 'en' },
      title: 'Enclave documentation',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'Enclave: a local-first AI agent for research software, with workflow-harnesses, for VS Code, the browser and the terminal.' }
      ]
    }
  },
  css: ['~/assets/main.css'],
  content: {
    // Node ≥ 22.5 ships sqlite; using it avoids compiling better-sqlite3 on install.
    experimental: { nativeSqlite: true },
    build: {
      markdown: {
        toc: { depth: 3, searchDepth: 3 },
        highlight: {
          theme: { default: 'github-light', dark: 'github-dark' },
          langs: ['json', 'bash', 'shell', 'yaml', 'typescript', 'javascript', 'python', 'markdown', 'html', 'diff']
        }
      }
    }
  },
  nitro: { prerender: { crawlLinks: true, routes: ['/'] } }
})
