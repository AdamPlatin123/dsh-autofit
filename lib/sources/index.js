/**
 * Public entry of the multi-source catalog layer (`dsh-autofit/sources`): readers that turn catalog documents into
 * Offerings, the merge/search over many sources, and the store that configures, fetches and caches sources.
 * Re-exports only; see each module for the contracts.
 */

export { compare, parse, prerelease, rcompare, satisfies, valid, validRange } from './semver.js'
export {
  DEFAULT_REGISTRY, DESCRIPTION_MAX, KEYWORDS_MAX, SKIP, SPEC_MAX, TITLE_MAX, chooseVersion, enginesAdmit,
  isPackageName, isSafeSpec, makeOffering,
} from './offer.js'
export { readFormat1 } from './format1.js'
export { detectFormat, npmSearchUrls, readNpmSearch, readRadarRepos, readShop, shopDataUrl } from './adapters.js'
export { buildIndex, compareVersions, mergeCatalog, queryCatalog } from './merge.js'
export {
  AWESOME_SOURCES, DEFAULT_SOURCES, SOURCE_KINDS, applySourceChange, fetchJson, hostMarketSources, loadRadar,
  loadSource, loadSourceConfig, normalizeSourceUrl, probeSource, saveSourceConfig,
} from './store.js'
