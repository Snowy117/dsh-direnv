/**
 * The inline message tables and the translate seat.
 *
 * The tables are inline on purpose: the panel must read in the operator's
 * language even when the locale service is absent, unregistered, or misses a
 * key, so a reader never sees a raw key. `locale/*.json` carries the same key
 * set and `test/client-contract.test.mjs` compares them key by key.
 */

import { PLUGIN_ID } from './constants.ts'
import type { Dispose } from './ctx.ts'
import { isUnknownArray } from './ctx.ts'

export type MessageParams = Record<string, string | number>

export type Translate = (key: string, params?: MessageParams | undefined) => string

export interface Tables {
  zh: Record<string, string>
  en: Record<string, string>
}

export function dictionaries(): Tables {
  const zh = {
    'meta.title': 'direnv',
    'meta.description': '让每个工作区的 direnv 环境自动进入 harness 运行的每一条命令。',
    tab: 'direnv',
    'guide.description': '本工作区的 direnv 环境状态',
    'state.loading': '加载中',
    'state.idle': '等待求值',
    'state.ok': '已就绪',
    'state.absent': '无 .envrc',
    'state.unreadable': '无法读取 .envrc',
    'state.blocked': '被 block',
    'state.envrc-failed': '.envrc 求值失败',
    'state.config-error': 'direnv 配置错误',
    'state.error': '出错',
    'state.direnv-unavailable': 'direnv 未安装',
    'state.disabled': '已禁用',
    'state.route-down': '状态不可用',
    'state.unknown': '未知状态：{state}',
    'label.dir': '目录',
    'label.envrcPath': '.envrc',
    'label.duration': '耗时',
    'label.updated': '更新于',
    'label.memoHit': '缓存',
    'label.memoHitYes': '命中',
    'label.memoHitNo': '未命中',
    'label.error': '错误摘要',
    'label.warnings': '警告',
    'label.variables': '环境变量',
    'label.path': 'PATH 条目',
    'label.credentials': '凭据名单',
    'label.search': '搜索变量名',
    'label.count': '共 {count} 项',
    'action.reload': '重新加载',
    'action.reloading': '正在重新加载…',
    'action.copyName': '复制变量名',
    'action.reveal': '点击展开原值',
    'action.hide': '点击遮蔽原值',
    'composer.loading': 'direnv：正在加载 .envrc…',
    'time.now': '刚刚',
    'time.minutes': '{n} 分钟',
    'time.hours': '{n} 小时',
    'time.days': '{n} 天',
    'time.months': '{n} 个月',
    'time.years': '{n} 年',
    'hint.pathOrder': '靠前的条目优先级更高；+ 绿色 = 本次新增，× 红色 = 已被本次加载移除',
    'hint.pathEmpty': '（空 → 当前目录）',
    'hint.pathUnset': 'PATH 已被该 .envrc 移除',
    'hint.masked': '值默认遮蔽为 ••••，展开单行可查看原值',
    'hint.noValues': '展开任意一行以获取变量值',
    'hint.credentials': '这些会出现在子进程环境中',
    'hint.copyHint': '展开行后点击复制按钮可复制变量名',
    'hint.copied': '已复制',
    'hint.routeDown': '状态路由暂不可用，正在静默重试',
    'hint.noSession': '没有会话上下文，无法读取 direnv 状态',
    'hint.noWorkspace': 'host 还没有这个会话的工作区目录',
    'hint.empty': '无',
    'hint.valueUnset': '—',
    'hint.valueRemoved': '（已删除）',
    'hint.poll': '每 {seconds} 秒轮询 /plugins/dsh-direnv/status.json',
    'notify.blocked': '{name} 尚未 allow：请在真实终端里执行 direnv allow',
    'notify.unreadable': '无法读取 {name}',
    'notify.envrcFailed': '.envrc 求值失败：{detail}',
    'notify.configError': 'direnv 配置错误：{detail}',
    'notify.error': 'direnv 求值出错：{detail}',
    'notify.noDirenv': '未找到 direnv 可执行文件，已跳过环境加载',
    'notify.reloadFailed': '重新加载请求失败：{detail}',
  }

  const en = {
    'meta.title': 'direnv',
    'meta.description': "Load each workspace's direnv environment into every command the harness runs.",
    tab: 'direnv',
    'guide.description': "This workspace's direnv environment status",
    'state.loading': 'Loading',
    'state.idle': 'Waiting',
    'state.ok': 'Ready',
    'state.absent': 'No .envrc',
    'state.unreadable': '.envrc unreadable',
    'state.blocked': 'Blocked',
    'state.envrc-failed': '.envrc evaluation failed',
    'state.config-error': 'direnv config error',
    'state.error': 'Error',
    'state.direnv-unavailable': 'direnv not installed',
    'state.disabled': 'Disabled',
    'state.route-down': 'Status unavailable',
    'state.unknown': 'Unknown state: {state}',
    'label.dir': 'Directory',
    'label.envrcPath': '.envrc',
    'label.duration': 'Duration',
    'label.updated': 'Updated',
    'label.memoHit': 'Cache',
    'label.memoHitYes': 'hit',
    'label.memoHitNo': 'miss',
    'label.error': 'Error summary',
    'label.warnings': 'Warnings',
    'label.variables': 'Environment',
    'label.path': 'PATH',
    'label.credentials': 'Credential roster',
    'label.search': 'Search variable names',
    'label.count': '{count} entries',
    'action.reload': 'Reload',
    'action.reloading': 'Reloading…',
    'action.copyName': 'Copy variable name',
    'action.reveal': 'Click to reveal the value',
    'action.hide': 'Click to mask the value',
    'composer.loading': 'direnv: loading .envrc…',
    'time.now': 'now',
    'time.minutes': '{n}min',
    'time.hours': '{n}h',
    'time.days': '{n}d',
    'time.months': '{n}mo',
    'time.years': '{n}y',
    'hint.pathOrder': 'Earlier entries take precedence; + green = added, × red = removed by this load',
    'hint.pathEmpty': '(empty → current directory)',
    'hint.pathUnset': 'PATH was removed by this .envrc',
    'hint.masked': 'Values are masked as ••••; expand a row to see the original',
    'hint.noValues': 'Expand any row to fetch the variable values',
    'hint.credentials': 'These appear in subprocess environments',
    'hint.copyHint': 'Expand a row, then use its copy button to copy the name',
    'hint.copied': 'Copied',
    'hint.routeDown': 'Status route unavailable; retrying silently',
    'hint.noSession': 'No session context, so direnv status cannot be read',
    'hint.noWorkspace': 'The host has no workspace directory for this session yet',
    'hint.empty': 'None',
    'hint.valueUnset': '—',
    'hint.valueRemoved': '(removed)',
    'hint.poll': 'Polls /plugins/dsh-direnv/status.json every {seconds}s',
    'notify.blocked': '{name} is not allowed yet: run direnv allow in a real terminal',
    'notify.unreadable': 'Cannot read {name}',
    'notify.envrcFailed': '.envrc evaluation failed: {detail}',
    'notify.configError': 'direnv configuration error: {detail}',
    'notify.error': 'direnv evaluation error: {detail}',
    'notify.noDirenv': 'No direnv executable found; environment loading was skipped',
    'notify.reloadFailed': 'Reload request failed: {detail}',
  }

  return { zh: zh, en: en }
}

function interpolate(template: string, params: MessageParams | undefined): string {
  if (params === undefined || params === null) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  )
}

/** The browser's own language, when one of the inline tables speaks it. */
function detectLocale(tables: Record<string, Record<string, string>>): string {
  let tags: string[] = []
  try {
    if (typeof navigator !== 'undefined') {
      if (isUnknownArray(navigator.languages)) {
        for (const tag of navigator.languages) tags.push(String(tag))
      }
      if (typeof navigator.language === 'string') tags.push(navigator.language)
    }
  } catch {
    tags = []
  }
  for (const tag of tags) {
    const primary = String(tag).toLowerCase().split('-')[0]
    if (primary !== undefined && Object.prototype.hasOwnProperty.call(tables, primary)) return primary
  }
  return 'en'
}

interface LocaleService {
  register?: ((id: string, tables: unknown) => unknown) | undefined
  bind?: ((id: string) => unknown) | undefined
  getLocale?: (() => unknown) | undefined
}

/**
 * The locale service as this plugin probes it. The service is a cordis proxy, so
 * the shape is asserted once here and every member is still checked with
 * `typeof` before it is called — the same duck typing the panel has always done.
 */
function localeServiceOf(value: unknown): LocaleService | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as LocaleService
}

/**
 * Build the translate seat. The locale service is used when it exists — its
 * dictionaries then follow the user's language switch — and the inline
 * dictionaries answer whenever it is absent, unregistered, or misses a key.
 */
export function createTranslate(localeFace: unknown, disposers: Dispose[]): Translate {
  const tables = dictionaries()
  const all: Record<string, Record<string, string>> = { zh: tables.zh, en: tables.en }
  const face = localeServiceOf(localeFace)
  let bound: ((key: string, params?: MessageParams | undefined) => unknown) | undefined
  let active: () => string = () => detectLocale(all)

  if (face !== undefined) {
    if (typeof face.register === 'function') {
      try {
        const dispose = face.register(PLUGIN_ID, { en: tables.en, zh: tables.zh })
        if (typeof dispose === 'function') disposers.push(dispose as Dispose)
      } catch {
        /* already registered (HMR overlap) or a malformed id — inline copy still works */
      }
    }
    if (typeof face.bind === 'function') {
      const bind = face.bind
      try {
        const candidate = bind(PLUGIN_ID)
        if (typeof candidate === 'function') {
          bound = candidate as (key: string, params?: MessageParams | undefined) => unknown
        }
      } catch {
        bound = undefined
      }
    }
    if (typeof face.getLocale === 'function') {
      const getLocale = face.getLocale
      active = () => {
        try {
          const snapshot = getLocale()
          const id =
            snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot)
              ? (snapshot as { active?: unknown }).active
              : undefined
          if (typeof id === 'string' && Object.prototype.hasOwnProperty.call(all, id)) return id
        } catch {
          /* fall through to browser detection */
        }
        return detectLocale(all)
      }
    }
  }

  return function t(key: string, params?: MessageParams | undefined): string {
    if (bound !== undefined) {
      try {
        const text = bound(key, params)
        if (typeof text === 'string' && text !== key && text !== '') return text
      } catch {
        /* fall through to the inline dictionary */
      }
    }
    const dictionary = all[active()] ?? tables.en
    const template = dictionary[key] ?? tables.en[key] ?? key
    return interpolate(template, params)
  }
}
