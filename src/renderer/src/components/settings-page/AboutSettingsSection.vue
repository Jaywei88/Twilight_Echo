<script setup lang="ts">
import { GITHUB_URL, RELEASES_URL, UPSTREAM_URL } from './types.ts'
import AppUpdatePanel from './AppUpdatePanel.vue'

defineProps<{ appVersion: string }>()
const emit = defineEmits<{ exportAudioDiagnostics: [] }>()

function openExternal(url: string): void {
  void window.api?.shell?.openExternal?.(url)
}
</script>

<template>
  <div id="about" class="section-block about-section">
    <div class="section-title-row">
      <i class="pi pi-info-circle"></i>
      <h3>版本与关于</h3>
    </div>

    <div data-setting-id="app-version" id="setting-app-version" class="about-hero">
      <div class="logo-shell">
        <div class="logo-mark">
          <img src="/icon.png" alt="Twilight Echo" class="logo-icon" />
        </div>
      </div>
      <div class="about-copy">
        <h3>Twilight Echo <span class="about-fork-badge">非官方分支</span></h3>
        <span>Version {{ appVersion || '—' }}</span>
        <p class="about-fork-warning">
          本项目是基于 Px-asen/Twilight_Echo 的非官方社区分支，未获官方背书。它是 vibe-coding
          产物，可能存在未知 bug，请谨慎下载、使用，并在批量修改标签或重命名前备份音乐文件。
        </p>
      </div>
    </div>

    <div class="about-cards">
      <AppUpdatePanel />
      <p class="about-fork-update-note">
        本分支不提供官方自动更新承诺；请只从本仓库 Releases 手动下载，并核对 SHA-256。
      </p>
    </div>

    <hr />

    <div data-setting-id="project-links" id="setting-project-links" class="about-links">
      <button type="button" @click="emit('exportAudioDiagnostics')">
        <i class="pi pi-file-export"></i> 导出音频诊断
      </button>
      <button type="button" @click="openExternal(GITHUB_URL)">
        <i class="pi pi-github"></i> 本分支 GitHub
      </button>
      <button type="button" @click="openExternal(RELEASES_URL)">
        <i class="pi pi-file-o"></i> 本分支 Releases
      </button>
      <button type="button" @click="openExternal(UPSTREAM_URL)">
        <i class="pi pi-external-link"></i> 上游项目
      </button>
    </div>
  </div>
</template>
