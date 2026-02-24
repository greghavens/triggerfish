<script setup lang="ts">
defineProps<{
  status: 'active' | 'planned'
}>()
</script>

<template>
  <span class="status-badge" :class="status">
    <span v-if="status === 'active'" class="dot" />
    {{ status === 'active' ? 'ACTIVE' : 'PLANNED' }}
  </span>
</template>

<style scoped>
.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-family: var(--vp-font-family-mono);
  font-size: 0.65rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  border-radius: 100px;
  padding: 0.2rem 0.6rem;
  line-height: 1;
  white-space: nowrap;
}

.status-badge.active {
  background: rgba(74, 222, 128, 0.16);
  color: #4ADE80;
  border: 1px solid rgba(74, 222, 128, 0.2);
}

.status-badge.planned {
  background: rgba(245, 158, 11, 0.12);
  color: #F59E0B;
  border: 1px solid rgba(245, 158, 11, 0.2);
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #4ADE80;
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
</style>
