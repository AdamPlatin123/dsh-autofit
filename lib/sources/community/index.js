/**
 * Registry of the community catalog adapters: one module per format family that is widely used, pinned and
 * readable from a single document (see each module's header). detectFormat in ../adapters.js falls back to this
 * registry after the built-in formats, and store.js reads a 'community:<id>' document through readCommunity.
 *
 * Why strict: a document claimed by the wrong reader would show wrong install specs. Every adapter's detect is
 * strict on its own, and here a document that more than one adapter claims is treated as unknown (detectCommunity
 * answers null, readCommunity throws) so ambiguity can never pick a reader silently.
 */

import * as awesomePlugins from './awesome-plugins.js'
import * as dshmkApi from './dshmk-api.js'
import * as lanshuApi from './lanshu-api.js'
import * as omniCatalog from './omni-catalog.js'
import * as w2112515Catalog from './w2112515-catalog.js'
import * as webcasaPlugins from './webcasa-plugins.js'
import * as yelebaiRegistry from './yelebai-registry.js'

const adapter = (m) => Object.freeze({ id: m.id, title: Object.freeze({ ...m.title }), detect: m.detect, read: m.read })

/** The adapters, frozen `{ id, title: { zh, en }, detect, read }`. */
export const COMMUNITY_ADAPTERS = Object.freeze([
  awesomePlugins, yelebaiRegistry, omniCatalog, lanshuApi, webcasaPlugins, dshmkApi, w2112515Catalog,
].map(adapter))

const BY_ID = new Map(COMMUNITY_ADAPTERS.map((a) => [a.id, a]))

/** The adapter with this id, or null. */
export function communityAdapter(id) {
  return typeof id === 'string' ? BY_ID.get(id) ?? null : null
}

/** Ids of every adapter whose detect accepts `doc` (a detect that throws counts as no). */
export function communityClaims(doc) {
  const out = []
  for (const a of COMMUNITY_ADAPTERS) {
    let yes = false
    try {
      yes = a.detect(doc) === true
    } catch { /* a detect must not throw; treat it as not claimed */ }
    if (yes) out.push(a.id)
  }
  return out
}

/** The one adapter that claims `doc`, or null when none or more than one does. */
export function detectCommunity(doc) {
  const ids = communityClaims(doc)
  return ids.length === 1 ? BY_ID.get(ids[0]) : null
}

/**
 * Read `doc` with the adapter that claims it (or the one named by `options.adapterId`, which must also claim it).
 * @returns the adapter's `{ offerings, skipped, skippedBy, warnings }` plus `{ adapter: id, title }`.
 * @throws TypeError when no adapter or more than one claims the document, or the named one does not.
 */
export function readCommunity(doc, { sourceId, hostVersion, adapterId } = {}) {
  const ids = communityClaims(doc)
  if (ids.length > 1) throw new TypeError(`ambiguous community format: ${ids.join(', ')}`)
  if (!ids.length) throw new TypeError('not a known community catalog format')
  if (adapterId !== undefined && adapterId !== ids[0]) throw new TypeError(`document is ${ids[0]}, not ${String(adapterId)}`)
  const a = BY_ID.get(ids[0])
  const r = a.read(doc, { sourceId, hostVersion })
  return {
    offerings: r.offerings,
    skipped: r.skipped ?? 0,
    skippedBy: r.skippedBy ?? {},
    warnings: Array.isArray(r.warnings) ? r.warnings : [],
    adapter: a.id,
    title: { ...a.title },
  }
}
