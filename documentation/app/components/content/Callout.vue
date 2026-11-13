<script setup lang="ts">
// MDC component. In a page:  ::callout{type="warning" title="Trust boundary"}  …text…  ::
defineProps<{ type?: 'note' | 'warning' | 'tip'; title?: string }>()
</script>

<template>
  <div class="callout" :class="type ?? 'note'">
    <p v-if="title" class="callout-title">{{ title }}</p>
    <slot />
  </div>
</template>
