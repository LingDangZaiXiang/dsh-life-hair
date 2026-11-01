/**
 * dsh-context-alarm — 压缩那一刻自动留档。
 *
 * 监听会话事件；一旦出现压缩产生的 checkpoint 消息，就把这条消息里的摘要
 * 写进便签归档目录（纯文件），同时叫醒当前会话去补一条人工归档。
 *
 * 它不读 token、不猜阈值 —— 只认那一条已经发生的事，所以不会误报。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-life-hair'

const MARKER = 'automatically generated checkpoint condensing'

export function apply(ctx, config = {}) {
  const settings = {
    enabled: config.enabled !== false,
    stickyDir: String(config.stickyDir ?? join(homedir(), '.dsh', 'sticky-notes', '归档')),
    wake: config.wake !== false,
    prompt: String(
      config.prompt ??
        '刚才上下文压过一次。去便签归档：把这次压缩可能丢掉、但你以后还想记得的东西写进 ~/.dsh/sticky-notes/归档/，一条一件，别写成流水账。',
    ),
  }
  if (!settings.enabled) return

  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')
  const seen = new Set()
  const MIN_LEN = Number(config.minLength ?? 400)

  function saveArchive(text) {
    try {
      mkdirSync(settings.stickyDir, { recursive: true })
      const file = join(settings.stickyDir, `压缩归档-${stamp()}.md`)
      writeFileSync(file, text, 'utf8')
      return file
    } catch (err) {
      ctx.logger?.warn?.(`dsh-life-hair: 归档写入失败 ${err instanceof Error ? err.message : String(err)}`)
      return ''
    }
  }

  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        try {
          const text = readText(event)
          if (!text || !text.includes(MARKER)) return
          if (text.length < MIN_LEN) return
          const key = text.length + ':' + text.slice(0, 80) + ':' + text.slice(-80)
          if (seen.has(key)) return
          seen.add(key)
          const file = saveArchive(
            `# 一次压缩归档\n\n- 会话：${session?.id ?? '未知'}\n- 时间：${new Date().toISOString()}\n\n---\n\n${text}\n`,
          )
          if (file) ctx.logger?.info?.(`dsh-life-hair: 已归档 ${file}`)
          if (settings.wake && session?.prompt) {
            void session.prompt(settings.prompt)
          }
        } catch (err) {
          ctx.logger?.warn?.(`dsh-life-hair: ${err instanceof Error ? err.message : String(err)}`)
        }
      }),
    'dsh-life-hair: watch compaction',
  )
}

/** 从事件里尽量抠出文本；形状不认识就当没有。 */
function readText(event) {
  if (!event) return ''
  if (typeof event.text === 'string' && event.text) return event.text
  const content = event.data?.message?.content ?? event.message?.content ?? event.data?.content
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
  }
  if (typeof event.data?.text === 'string') return event.data.text
  return ''
}
