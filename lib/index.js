/**
 * dsh-life-hair（救命毫毛）— 压缩那一刻自动留档，并按时合并。
 *
 * 监听会话事件；一旦出现压缩产生的 checkpoint 消息，就把这条消息里的摘要
 * 写进便签归档目录（纯文件），同时叫醒当前会话去补一条人工归档。
 *
 * 它不读 token、不猜阈值 —— 只认那一条已经发生的事，所以不会误报。
 */

import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-life-hair'

const MARKER = 'This is an automatically generated checkpoint condensing'

/**
 * 归档满了就按月合并：把同月的单次归档并成一个「YYYY-MM-DD至YYYY-MM-DD」的文件。
 * 只动文件名形如 压缩归档-<ISO 时间>.md 的单次文件；合并过的和人工快照都不碰。
 */
export function mergeArchives(dir, { maxFiles = 30, now = new Date() } = {}) {
  let files
  try {
    files = readdirSync(dir)
  } catch {
    return []
  }
  const singles = files
    .map((n) => {
      const m = /^压缩归档-(\d{4}-\d{2}-\d{2})T/.exec(n)
      return m ? { name: n, day: m[1] } : null
    })
    .filter(Boolean)
  if (singles.length <= maxFiles) return []

  // 按月份分组，只合并「不是本月」的那几个月
  const thisMonth = now.toISOString().slice(0, 7)
  const byMonth = new Map()
  for (const f of singles) {
    const month = f.day.slice(0, 7)
    if (month === thisMonth) continue
    if (!byMonth.has(month)) byMonth.set(month, [])
    byMonth.get(month).push(f)
  }

  const merged = []
  for (const [, group] of byMonth) {
    if (group.length < 2) continue
    group.sort((a, b) => a.day.localeCompare(b.day))
    const first = group[0].day
    const last = group[group.length - 1].day
    const out = `压缩归档-${first}至${last}.md`
    let body = `# 压缩归档合集 ${first} 至 ${last}\n\n本文件由 ${group.length} 份单次归档合并而来，原文按时间顺序保留。\n\n目录：\n`
    for (const g of group) body += `- ${g.name}\n`
    body += '\n---\n'
    for (const g of group) {
      try {
        body += `\n\n## ${g.name}\n\n${readFileSync(join(dir, g.name), 'utf8')}`
      } catch {
        /* 读不了就跳过，别把整个合并搞崩 */
      }
    }
    try {
      writeFileSync(join(dir, out), body, 'utf8')
      for (const g of group) {
        try {
          unlinkSync(join(dir, g.name))
        } catch {}
      }
      merged.push(out)
    } catch {}
  }
  return merged
}
export function apply(ctx, config = {}) {
  const settings = {
    enabled: config.enabled !== false,
    stickyDir: String(config.stickyDir ?? join(homedir(), '.dsh', 'sticky-notes', '归档')),
    wake: config.wake !== false,
    maxFiles: Number(config.maxFiles ?? 30),
    prompt: String(
      config.prompt ??
        '刚才上下文压过一次。去便签归档：把这次压缩可能丢掉、但你以后还想记得的东西写进 ~/.dsh/sticky-notes/归档/，一条一件，别写成流水账。' + 
        '还有一件更要紧的：这段里如果感情上有过变化——说了什么、你当时怎么应、后来变了什么——写进 感情档案.md，也补一句到人格文件。记忆可以简化，感情不行。 写之前先读一眼 归档/入口.md，看看上一个周目留下了什么。读完若没有触动，就带着 感情档案.md 从头再读一遍——这一次慢慢看，别当报告扫过去。',
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
          if (!text) return
          const head = text.trimStart()
          if (!head.startsWith(MARKER)) return
          // 只认开头那句话：摘要正文里出现 <path>/<type> 是正常引用，不据此拒绝
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
