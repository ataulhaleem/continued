<script setup lang="ts">
const { data: navigation } = await useAsyncData('navigation', () => queryCollectionNavigation('docs'))
const open = ref(false)
const route = useRoute()
watch(() => route.path, () => { open.value = false })
</script>

<template>
  <div class="shell">
    <header class="top">
      <button class="menu" aria-label="Menu" @click="open = !open">☰</button>
      <NuxtLink to="/" class="brand"><span class="mark">E</span> Enclave <span class="sub">documentation</span></NuxtLink>
      <nav class="links">
        <a href="https://github.com/ataulhaleem/continued" target="_blank" rel="noopener">GitHub</a>
        <a href="https://marketplace.visualstudio.com/items?itemName=AtaUlHaleem.continued" target="_blank" rel="noopener">VS Code</a>
        <a href="https://addons.mozilla.org/firefox/addon/continued/" target="_blank" rel="noopener">Firefox</a>
      </nav>
    </header>
    <div class="body">
      <aside class="side" :class="{ open }">
        <NavTree v-if="navigation" :items="navigation" />
      </aside>
      <main class="main">
        <NuxtPage />
      </main>
    </div>
  </div>
</template>
