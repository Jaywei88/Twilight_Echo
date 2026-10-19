export async function activate(context) {
  context.twilight.ui.onCommand('tag-workshop.open', () => ({ page: 'tag-workshop' }))
  await context.twilight.ui.register({
    id: 'tag-workshop',
    kind: 'sidebarPage',
    title: '标签工作台',
    description: '批量整理本地音乐的标签、封面、歌词与文件名',
    icon: 'ph ph-tag',
    command: 'tag-workshop.open'
  })
}

export function deactivate() {
  return undefined
}
