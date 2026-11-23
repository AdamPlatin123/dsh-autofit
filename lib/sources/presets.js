/**
 * Market presets: a curated, frozen list of community plugin markets the user can add as a source with one click.
 *
 * Why: dozens of community indexes exist and most users will never find their URLs. A preset carries the final URL
 * (user indexes are fetched with redirect:'error', so each URL was checked not to redirect), the reader it needs
 * (`format`: 'format1' or a community adapter id), and what we know about its terms, so the client can show licence
 * and attribution before the user adds it. Presets are data only: adding one goes through applySourceChange like any
 * user-typed URL, and every offering still passes the same reader and install-spec rules.
 *
 * Every preset was downloaded on `checkedAt` and read in full with its reader (`entries` = offerings read,
 * `plugins` = their install kinds, npm / git / other where other is a release tarball or an unpinned GitHub head).
 * Every format-1 preset also passed DSH's own parseMarketIndex that day, and every adapter preset was detected by
 * detectFormat as exactly 'community:<its format>'. `license` is the SPDX id of the data where the publisher states
 * one, else null; `attribution` records what the publisher asks of re-users, as a `{ zh, en }` text map (or null).
 * The downloads went through curl over this machine's proxy, not through DSH's own fetchJson; several presets are
 * 13-36 MB files on GitHub Pages / raw.githubusercontent, which is why user indexes get a longer fetch timeout
 * (store.js USER_INDEX_TIMEOUT_MS), but a slow or blocked direct connection can still fail them.
 *
 * Left out on purpose: brokep (Grok-bot conversions), DSH-Spicy (one plugin), CatGuard35 (copies of other markets),
 * qianyumeng0228/dsh-store (52% of entries have no versions, and DSH's parser rejects the whole index),
 * wsifan31-bit/Smart-DSH-Market (a stale 2026-08 copy of the YELEBAI registry: every entry is also in yelebai-registry).
 */

import { COMMUNITY_ADAPTERS } from './community/index.js'
import { normalizeSourceUrl } from './store.js'

const CHECKED_AT = '2026-11-21'

/** Community adapter ids a preset may name as its `format` (besides 'format1'). */
export const PRESET_ADAPTERS = Object.freeze(COMMUNITY_ADAPTERS.map((a) => a.id))

const f1 = (id, zh, en, url, homepage, repo, license, entries, npm, git, notes, attribution = null) =>
  ({ id, title: { zh, en }, url, format: 'format1', homepage, repo, license, attribution, entries, plugins: { npm, git, other: 0 }, notes, checkedAt: CHECKED_AT })

const ad = (id, format, zh, en, url, homepage, repo, license, [entries, npm, git, other], notes, attribution = null) =>
  ({ id, title: { zh, en }, url, format, homepage, repo, license, attribution, entries, plugins: { npm, git, other }, notes, checkedAt: CHECKED_AT })

const RAW = [
  f1('dsh-so', 'DSH.SO 安装验证市场', 'DSH.SO install-verified market', 'https://cdn.dsh.so/market/index.json',
    'https://www.dsh.so', null, 'CC-BY-4.0', 15411, 6774, 8637, 'CC-BY-4.0，需署名；大规模镜像前先联系对方',
    {
      zh: '按 dsh.so 数据条款适用 CC-BY-4.0：注明来源 dsh.so，保留其新鲜度标记（generatedAt/asOf/checkedAt），批量导出或完整镜像前先联系 dsh.so。',
      en: 'CC-BY-4.0 per dsh.so data terms: credit dsh.so, keep its freshness markers (generatedAt/asOf/checkedAt), and contact dsh.so before bulk exports or full mirrors.',
    }),
  f1('dsh-works', 'dsh.works awesome 插件', 'dsh.works awesome-dsh-plugins', 'https://dsh.works/awesome-dsh-plugins/market/index.json',
    'https://dsh.works/awesome-dsh-plugins/', 'dshworks/awesome-dsh-plugins', 'MIT', 12780, 12780, 0, '仅 npm 包；MIT'),
  f1('dshdesk', 'DSH Desk 插件目录', 'DSH Desk plugin registry', 'https://plugin.dshdesk.com/data/plugin-index.json',
    'https://plugin.dshdesk.com', 'majiayu000/dsh-plugin-registry', 'MIT', 20428, 0, 20428, '全部为固定到 commit 的 git 安装；MIT'),
  f1('realguan', 'realguan 插件市场', 'realguan plugin market', 'https://realguan.github.io/dsh-plugin-market/dsh-index.json',
    'https://realguan.github.io/dsh-plugin-market/', 'realguan/dsh-plugin-market', 'CC0-1.0', 11789, 6474, 5315,
    '数据转自 awesome-dsh-plugin（CC0），与内置 awesome 大量重复'),
  f1('dshfind', 'dshfind 插件目录', 'dshfind plugin directory', 'https://api.dshfind.com/market/dsh-index.json',
    'https://dshfind.com', 'hikariming/dshfind', null, 8954, 8954, 0, '许可证不明；仅 npm 包'),
  f1('dshopen', '开放插件市场', 'Open Plugin Market', 'https://dshopen.org/index.json',
    'https://dshopen.org/', 'polang233/dsh-plugin-index', 'GPL-3.0', 1341, 1191, 150, 'GPL-3.0'),
  f1('bruc3van', 'Bruce 的精选插件', "Bruce's plugin picks", 'https://raw.githubusercontent.com/bruc3van/awesome-dsh-plugin-pro/main/data/dsh-market-index.json',
    'https://github.com/bruc3van/awesome-dsh-plugin-pro', 'bruc3van/awesome-dsh-plugin-pro', 'MIT', 2553, 1539, 1014, '人工精选；MIT'),
  f1('ccch1mneyyy', 'DSH Go 插件市场', 'DSH Go plugins', 'https://ccch1mneyyy.github.io/dsh-go-market/index.json',
    'https://ccch1mneyyy.github.io/dsh-go-market/', 'ccch1mneyyy/dsh-go-market', 'AGPL-3.0', 41, 41, 0, 'AGPL-3.0；小型精选'),
  f1('vlln', 'vlln 的插件', "vlln's plugins", 'https://raw.githubusercontent.com/vlln/plugin-registry/main/index.json',
    'https://github.com/vlln/plugin-registry', 'vlln/plugin-registry', 'MIT', 13, 10, 3, '个人作者自己的插件；MIT'),
  f1('jingjiangze', 'DSH 插件索引（中文）', 'DSH plugin index (zh)', 'https://dsh.jiangjiangze.icu/index.zh.json',
    'https://dsh.jiangjiangze.icu', 'jingjiangze/dsh-market', 'GPL-3.0', 13854, 6338, 7516, 'GPL-3.0；条目数每日变化'),
  f1('xfish987', 'DSH 插件索引（自建）', 'DSH plugin index (self-hosted)', 'https://xfish987.github.io/dsh-plugin-index/index.json',
    'https://xfish987.github.io/dsh-plugin-index/', 'xfish987/dsh-plugin-index', 'MIT', 13971, 13971, 0, '仅 npm 包；MIT'),
  f1('whoishuhu', 'DSH 插件索引（dsh-plugin 标签）', 'DSH plugin index (dsh-plugin tag)', 'https://whoishuhu.github.io/dsh-plugin-index/index.json',
    'https://whoishuhu.github.io/dsh-plugin-index/', 'whoishuhu/dsh-plugin-index', null, 24110, 5092, 19018, '许可证不明（生成器 dsh-tag-index 为 MIT）'),

  ad('awesome-plugins', 'awesome-plugins', 'awesome 全量目录', 'awesome full catalog', 'https://awesome-dsh-plugin.com/plugins.json',
    'https://awesome-dsh-plugin.com', 'awesome-dsh-plugin/awesome-dsh-plugin', 'CC0-1.0', [11713, 6486, 0, 5227], 'CC0；内置 awesome 索引之外的 git/tarball 条目'),
  ad('yelebai-registry', 'yelebai-registry', 'YELEBAI 插件市场', 'YELEBAI plugin marketplace', 'https://raw.githubusercontent.com/YELEBAI/dsh-plugin-marketplace/HEAD/registry/plugins.json',
    'https://github.com/YELEBAI/dsh-plugin-marketplace', 'YELEBAI/dsh-plugin-marketplace', 'MIT', [18715, 1678, 17037, 0], 'MIT；约 25 MB'),
  ad('omni-catalog', 'omni-catalog', 'Omni DSH 插件目录', 'Omni DSH plugin catalog', 'https://dsh-plugins.omniskill.online/catalog.json',
    'https://dsh-plugins.omniskill.online', 'diegosouzapw/awesome-omni-dsh-plugins', 'CC0-1.0', [3626, 1611, 2015, 0], '目录数据 CC0（代码 MIT）'),
  ad('lanshu-api', 'lanshu-api', 'Lanshu 插件中心', 'Lanshu plugin hub', 'https://dsh.lanshuagent.com/api/plugins',
    'https://dsh.lanshuagent.com/', 'cclank/dsh-plugin-hub', 'MIT', [132, 0, 132, 0], 'MIT；接口不支持 HEAD 请求；只收录站点给出安装命令的条目'),
  ad('webcasa-plugins', 'webcasa-plugins', 'web-casa 插件精选', 'web-casa awesome plugins', 'https://raw.githubusercontent.com/web-casa/Awesome-DeepSeek-Harness-Plugins/main/data/plugins.json',
    'https://github.com/web-casa/Awesome-DeepSeek-Harness-Plugins', 'web-casa/Awesome-DeepSeek-Harness-Plugins', null, [331, 120, 0, 211], '许可证不明'),
  ad('dshmk-api', 'dshmk-api', 'dshmk 插件市场', 'dshmk plugin market', 'https://api.dshmk.com/',
    'https://dshmk.com', 'ZASENJC/dsh-plugins-store', 'MIT', [2500, 0, 2500, 0], 'MIT；多为雷达已收录的仓库'),
  ad('w2112515-catalog', 'w2112515-catalog', 'w2112515 插件市场', 'w2112515 plugin marketplace', 'https://w2112515.github.io/dsh-plugin-marketplace/plugin-marketplace/catalog-v1.json',
    'https://w2112515.github.io/dsh-plugin-marketplace/', 'w2112515/dsh-plugin-marketplace', 'MIT', [26553, 0, 26553, 0], 'MIT；全部为 git 条目'),
]

const freeze = (p) => Object.freeze({
  ...p,
  title: Object.freeze({ ...p.title }),
  attribution: p.attribution && Object.freeze({ ...p.attribution }),
  plugins: p.plugins && Object.freeze({ ...p.plugins }),
})

/** The presets, in display order (format-1 markets first, then adapter markets). */
export const PRESETS = Object.freeze(RAW.map(freeze))

const BY_ID = new Map(PRESETS.map((p) => [p.id, p]))

/**
 * The preset with this id, or null when there is none.
 * @throws TypeError when `id` is not a string.
 */
export function presetById(id) {
  if (typeof id !== 'string') throw new TypeError('preset id must be a string')
  return BY_ID.get(id) ?? null
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

function codedTypeError(code, message) {
  const err = new TypeError(message)
  err.code = code
  return err
}

/**
 * The presets for the client, each with `alreadyAdded` and `sourceId`: whether a configured source already has the
 * preset's URL (compared normalized, as applySourceChange does), and that source's id, else null.
 * @param sources - the effective source list (loadSourceConfig).
 */
export function presetStatus(sources) {
  const byKey = new Map()
  for (const s of Array.isArray(sources) ? sources : []) {
    if (!isObject(s) || typeof s.id !== 'string') continue
    for (const u of [s.url, ...(Array.isArray(s.urls) ? s.urls : [])]) {
      const key = typeof u === 'string' ? normalizeSourceUrl(u).key : undefined
      if (key && !byKey.has(key)) byKey.set(key, s.id)
    }
  }
  return PRESETS.map((p) => {
    const sourceId = byKey.get(normalizeSourceUrl(p.url).key) ?? null
    return { ...p, alreadyAdded: sourceId !== null, sourceId }
  })
}

/**
 * Turn `{ add: { presetId, trust? } }` into the `{ add: { url, title, trust } }` change applySourceChange takes;
 * any other change is returned as is. The URL and title come from the preset only; trust defaults to 'browse'.
 * @throws TypeError with `.code` 'invalid' (presetId not a string, or mixed with url/title/other fields) or
 *   'not-found' (no such preset).
 */
export function resolvePresetChange(change) {
  if (!isObject(change) || !isObject(change.add) || !Object.hasOwn(change.add, 'presetId')) return change
  const { presetId, ...rest } = change.add
  if (typeof presetId !== 'string') throw codedTypeError('invalid', 'presetId must be a string')
  if (Object.keys(rest).some((k) => k !== 'trust')) throw codedTypeError('invalid', 'a preset add takes only presetId and trust')
  const preset = presetById(presetId)
  if (!preset) throw codedTypeError('not-found', `no preset ${presetId.slice(0, 100)}`)
  return { add: { url: preset.url, title: { ...preset.title }, trust: rest.trust ?? 'browse' } }
}
