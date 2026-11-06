/**
 * Client half of the dsh-autofit bundle.
 *
 * Contributes two entries to the Plugins page:
 *  - `plugins.add.actions`: "Install with Autofit…", which opens a spec dialog, calls the Host
 *    `check` endpoint, shows the verdict/profile impact, and offers install only on `pass`.
 *  - `plugins.detail.section`: an "Autofit check" section for an installed bundle, which checks
 *    `name@version` through the same endpoint.
 *
 * The dialog itself lives in `shell.overlay` so closing the add-plugin menu does not unmount it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-autofit',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const CHECK_PATH = '/api/autofit/check'
    const LOCALE_NS = 'dshAutofit'

    /* ------------------------------------------------------------------ locale */

    const DICTIONARY = {
      zh: {
        menuTitle: '使用 Autofit 安装…',
        menuDescription: '先在临时 profile 中试装并检查，再决定是否安装',
        dialogTitle: '使用 Autofit 安装',
        dialogSubtitle: '在临时 profile 中真实安装并加载插件；当前 profile 不会被改动。通常需要 30–60 秒。',
        specLabel: '插件 spec',
        specPlaceholder: 'npm 名[@版本]、git 地址、tarball 或本地路径',
        check: '开始检查',
        recheck: '重新检查',
        checking: '正在试装…',
        checkingHint: 'L1 真实安装 + L2 启动加载；请让此窗口保持打开。',
        close: '关闭',
        install: '安装',
        installing: '正在安装…',
        installed: '已安装',
        installHint: '试装通过。安装将调用 DSH 原生的插件安装入口。',
        installBlocked: '只有结论为「通过」时才能安装。',
        installDone: '已通过 DSH 原生安装入口完成。',
        installFailed: '安装失败',
        installRunning: '正在调用 DSH 原生安装入口…',
        restartRequired: '安装已保存，需要重启 DSH 后才会生效。',
        overridden: '安装已保存，但被更高优先级的层覆盖。',
        pendingBuilds: '这些依赖的构建脚本需要单独批准：',
        pendingBuildsHint: '本界面不会自动批准构建脚本。请在插件页的安装对话框中批准后重试。',
        installWarnings: '安装警告',
        installErrorCode: '错误码',
        verdict: '结论',
        verdictPass: '通过',
        verdictFail: '未通过',
        verdictIncompatible: '不兼容',
        verdictInfraFail: '环境失败',
        verdictInconclusive: '无法判定',
        verdictNotPublished: '未发布',
        layerL1: 'L1 安装',
        layerL2Host: 'L2 Host 加载',
        layerL2Client: 'L2 Client 加载',
        statusInstalled: '已安装',
        statusClean: '正常',
        statusFailed: '失败',
        statusTimeout: '超时',
        statusUnverified: '未验证',
        statusNotExecuted: '未执行',
        statusIncompatible: '不兼容',
        statusNotPublished: '未发布',
        statusInfraFail: '环境失败',
        statusError: '错误',
        codes: '诊断码',
        none: '无',
        profile: '插件画像',
        kind: '类型',
        targetProfile: '目标 profile',
        impact: 'Profile 影响',
        impactLow: '低',
        impactMedium: '中',
        impactHigh: '高',
        impactHighWarning: '高影响：安装会停用或重配现有 profile 的核心行，可能改变安全相关设置。请先确认影响范围。',
        impactAck: '我已了解上述影响，仍要继续安装',
        impactDisables: '停用核心行',
        impactReconfigures: '重配核心行',
        impactSecurity: '安全相关行',
        impactRemoves: '移除行',
        impactOther: '其他行',
        impactInserts: '新增行',
        notes: '备注',
        logTail: '日志尾部',
        failures: '失败项',
        reason: '未通过原因',
        notPassHint: '结论不是「通过」，因此不提供安装入口。',
        errorEmpty: '请填写插件 spec。',
        errorBusy: '已有一次 Autofit 检查正在运行，请稍后再试。',
        errorRpc: '无法调用宿主检查。',
        errorNativeInstall: 'DSH 原生安装入口不可用。',
        errorUnexpected: '发生未预期的错误。',
        specChanged: 'spec 已修改，请重新检查后再安装。',
        bundleSectionTitle: 'Autofit 检查',
        bundleSectionDescription: '对这个已安装组合包重新做一次 L1/L2 试装；检查使用临时 profile，不改动当前 profile。',
        bundleCheck: 'Autofit 检查',
        bundleChecking: '正在检查…',
        bundleSpec: '检查对象',
        duration: '耗时',
        hostVersion: '宿主版本',
        spec: 'Spec',
      },
      en: {
        menuTitle: 'Install with Autofit…',
        menuDescription: 'Trial-install and inspect in a throwaway profile before deciding',
        dialogTitle: 'Install with Autofit',
        dialogSubtitle: 'Really installs and loads the plugin in a throwaway profile; your current profile is untouched. Usually 30–60 seconds.',
        specLabel: 'Plugin spec',
        specPlaceholder: 'npm name[@version], Git URL, tarball, or local path',
        check: 'Run check',
        recheck: 'Check again',
        checking: 'Trial-installing…',
        checkingHint: 'L1 real install + L2 boot load. Keep this window open.',
        close: 'Close',
        install: 'Install',
        installing: 'Installing…',
        installed: 'Installed',
        installHint: 'The trial passed. Install uses DSH’s native plugin installation entry point.',
        installBlocked: 'Install is available only when the verdict is Pass.',
        installDone: 'Completed through DSH’s native installation entry point.',
        installFailed: 'Install failed',
        installRunning: 'Calling DSH’s native installation entry point…',
        restartRequired: 'The installation was saved and takes effect after DSH restarts.',
        overridden: 'The installation was saved but a higher-priority layer overrides it.',
        pendingBuilds: 'These dependencies need explicit build-script approval:',
        pendingBuildsHint: 'This UI does not approve build scripts. Approve them in the Plugins install dialog and retry.',
        installWarnings: 'Install warnings',
        installErrorCode: 'Error code',
        verdict: 'Verdict',
        verdictPass: 'Pass',
        verdictFail: 'Fail',
        verdictIncompatible: 'Incompatible',
        verdictInfraFail: 'Infra failure',
        verdictInconclusive: 'Inconclusive',
        verdictNotPublished: 'Not published',
        layerL1: 'L1 install',
        layerL2Host: 'L2 Host load',
        layerL2Client: 'L2 Client load',
        statusInstalled: 'Installed',
        statusClean: 'Clean',
        statusFailed: 'Failed',
        statusTimeout: 'Timed out',
        statusUnverified: 'Unverified',
        statusNotExecuted: 'Not executed',
        statusIncompatible: 'Incompatible',
        statusNotPublished: 'Not published',
        statusInfraFail: 'Infra failure',
        statusError: 'Error',
        codes: 'Diagnostic codes',
        none: 'None',
        profile: 'Plugin profile',
        kind: 'Kind',
        targetProfile: 'Target profile',
        impact: 'Profile impact',
        impactLow: 'Low',
        impactMedium: 'Medium',
        impactHigh: 'High',
        impactHighWarning: 'High impact: installation disables or reconfigures core rows of the existing profile and may change security-relevant settings. Review the impact first.',
        impactAck: 'I understand the impact above and still want to install',
        impactDisables: 'Disables core rows',
        impactReconfigures: 'Reconfigures core rows',
        impactSecurity: 'Security rows',
        impactRemoves: 'Removes rows',
        impactOther: 'Other rows',
        impactInserts: 'Inserts rows',
        notes: 'Notes',
        logTail: 'Log tail',
        failures: 'Failures',
        reason: 'Why it did not pass',
        notPassHint: 'The verdict is not Pass, so no install action is offered.',
        errorEmpty: 'Enter a plugin spec.',
        errorBusy: 'Another Autofit check is already running. Try again shortly.',
        errorRpc: 'Could not reach the Host check.',
        errorNativeInstall: 'DSH’s native installation entry point is unavailable.',
        errorUnexpected: 'An unexpected error occurred.',
        specChanged: 'The spec changed. Run the check again before installing.',
        bundleSectionTitle: 'Autofit check',
        bundleSectionDescription: 'Run another L1/L2 trial for this installed bundle in a throwaway profile; the current profile is not touched.',
        bundleCheck: 'Autofit check',
        bundleChecking: 'Checking…',
        bundleSpec: 'Subject',
        duration: 'Duration',
        hostVersion: 'Host version',
        spec: 'Spec',
      },
    }

    /* ------------------------------------------------------------------ styles */

    const CSS = `
.dsh-autofit-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.45);pointer-events:auto}
.dsh-autofit-dialog{width:min(760px,100%);max-height:86vh;overflow:auto;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.35);font:inherit}
.dsh-autofit-head{display:flex;align-items:flex-start;gap:12px;padding:18px 20px 0}
.dsh-autofit-head-copy{flex:1;min-width:0}
.dsh-autofit-title{margin:0;font-size:16px;font-weight:600;line-height:1.4}
.dsh-autofit-subtitle{margin:6px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
.dsh-autofit-body{display:flex;flex-direction:column;gap:14px;padding:16px 20px 20px}
.dsh-autofit-close{flex:none;width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:18px;line-height:1;cursor:pointer}
.dsh-autofit-close:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-autofit-close:disabled{opacity:.4;cursor:default}
.dsh-autofit-field{display:flex;flex-direction:column;gap:6px}
.dsh-autofit-label{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:500}
.dsh-autofit-input{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.dsh-autofit-input:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}
.dsh-autofit-input:disabled{opacity:.65}
.dsh-autofit-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-autofit-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:30px;padding:5px 12px;border-radius:7px;border:1px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.dsh-autofit-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-autofit-btn:disabled{opacity:.5;cursor:not-allowed}
.dsh-autofit-btn-primary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground)}
.dsh-autofit-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dsh-autofit-spinner{display:inline-block;width:13px;height:13px;border:2px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:dsh-autofit-spin .9s linear infinite}
@keyframes dsh-autofit-spin{to{transform:rotate(360deg)}}
.dsh-autofit-progress{display:flex;align-items:flex-start;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2)}
.dsh-autofit-progress-title{font-size:13px;font-weight:600}
.dsh-autofit-progress-text{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
.dsh-autofit-summary{display:flex;flex-direction:column;gap:12px}
.dsh-autofit-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-autofit-badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;line-height:1.6;white-space:nowrap}
.dsh-autofit-badge-success{background:var(--dsw-alias-state-success-secondary);color:var(--dsw-alias-state-success-primary)}
.dsh-autofit-badge-warn{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary)}
.dsh-autofit-badge-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent);color:var(--dsw-alias-state-error-primary)}
.dsh-autofit-badge-neutral{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}
.dsh-autofit-box{padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:1.6}
.dsh-autofit-box-warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,var(--dsw-alias-border-l2));background:var(--dsw-alias-state-warn-tertiary)}
.dsh-autofit-box-error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,var(--dsw-alias-border-l2))}
.dsh-autofit-grid{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 14px;align-items:start;font-size:12px;line-height:1.55}
.dsh-autofit-grid .dsh-autofit-label{padding-top:1px}
.dsh-autofit-value{color:var(--dsw-alias-label-primary);word-break:break-word}
.dsh-autofit-value-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}
.dsh-autofit-chips{display:flex;gap:6px;flex-wrap:wrap}
.dsh-autofit-chip{display:inline-flex;padding:1px 7px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;line-height:1.7}
.dsh-autofit-pre{margin:6px 0 0;padding:8px;max-height:180px;overflow:auto;border-radius:6px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.dsh-autofit-details{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-autofit-details summary{cursor:pointer;user-select:none}
.dsh-autofit-check-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}
.dsh-autofit-checkbox{display:flex;align-items:flex-start;gap:7px;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsh-autofit-checkbox input{margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary)}
.dsh-autofit-menu-item{display:flex;align-items:flex-start;gap:10px;width:100%;height:72px;box-sizing:border-box;padding:10px 12px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);text-align:left;font:inherit;cursor:pointer}
.dsh-autofit-menu-item:hover,.dsh-autofit-menu-item:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:none}
.dsh-autofit-menu-icon{flex:none;display:flex;align-items:center;justify-content:center;width:22px;height:22px;margin-top:2px;color:var(--dsw-alias-brand-primary)}
.dsh-autofit-menu-copy{display:flex;flex-direction:column;gap:3px;min-width:0}
.dsh-autofit-menu-title{font-size:13px;font-weight:600;line-height:1.4}
.dsh-autofit-menu-desc{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dsh-autofit-section{margin-top:16px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:8px;font-size:12px}
.dsh-autofit-section-title{margin:0;font-size:13px;font-weight:600}
.dsh-autofit-section-desc{margin:0;color:var(--dsw-alias-label-secondary);line-height:1.6}
`.trim()

    function StyleTag() {
      return h('style', { 'data-dsh-autofit': 'style' }, CSS)
    }

    /* ------------------------------------------------------------------ icons */

    function ShieldCheckIcon({ size = 18 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M12 3.2 18.8 6v5.1c0 4.3-2.9 7.8-6.8 9.7-3.9-1.9-6.8-5.4-6.8-9.7V6L12 3.2Z' }),
        h('path', { d: 'm8.7 11.9 2.2 2.2 4.5-4.7' }),
        h('path', { d: 'M18.7 2.8l.5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2-1.2-.5 1.2-.5.5-1.2Z' }),
      )
    }

    /* ------------------------------------------------------------------ dialog store */

    let dialogState = { open: false, initialSpec: '' }
    const dialogListeners = new Set()

    function emitDialog() {
      for (const listener of dialogListeners) listener()
    }

    function openAutofitDialog(spec) {
      dialogState = { open: true, initialSpec: typeof spec === 'string' ? spec : '' }
      emitDialog()
    }

    function closeAutofitDialog() {
      dialogState = { open: false, initialSpec: '' }
      emitDialog()
    }

    function useAutofitDialog() {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => force((value) => value + 1)
        dialogListeners.add(listener)
        return () => {
          dialogListeners.delete(listener)
        }
      }, [])
      return dialogState
    }

    /* ------------------------------------------------------------------ shared helpers */

    function statusLabel(t, status) {
      if (!status) return t('statusNotExecuted')
      const key = {
        installed: 'statusInstalled',
        clean: 'statusClean',
        failed: 'statusFailed',
        timeout: 'statusTimeout',
        unverified: 'statusUnverified',
        'not-executed': 'statusNotExecuted',
        incompatible: 'statusIncompatible',
        'not-published': 'statusNotPublished',
        'infra-fail': 'statusInfraFail',
        error: 'statusError',
      }[status]
      return key ? t(key) : String(status)
    }

    function verdictLabel(t, verdict) {
      const key = {
        pass: 'verdictPass',
        fail: 'verdictFail',
        incompatible: 'verdictIncompatible',
        'infra-fail': 'verdictInfraFail',
        inconclusive: 'verdictInconclusive',
        'not-published': 'verdictNotPublished',
      }[verdict]
      return key ? t(key) : String(verdict ?? '—')
    }

    function toneFor(verdict) {
      if (verdict === 'pass') return 'success'
      if (verdict === 'fail') return 'error'
      if (verdict === 'incompatible' || verdict === 'not-published' || verdict === 'infra-fail' || verdict === 'inconclusive') return 'warn'
      return 'neutral'
    }


    /**
     * Call the Host's exact Connection Fetch route. The browser sends the same-origin session
     * cookie; Connection admits it as the owner Peer before dispatching the route.
     */
    async function callCheck(spec, signal) {
      let response
      try {
        response = await fetch(CHECK_PATH, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spec }),
          signal,
        })
      } catch (error) {
        return { ok: false, error: { code: 'autofit/network', message: error && error.message ? String(error.message) : 'request failed' } }
      }
      let result
      try {
        result = await response.json()
      } catch {
        return { ok: false, error: { code: 'autofit/bad-response', message: `HTTP ${response.status}` } }
      }
      if (!result || typeof result.ok !== 'boolean') {
        return { ok: false, error: { code: 'autofit/bad-response', message: `HTTP ${response.status}` } }
      }
      return result
    }

    function ErrorBox({ t, message, code }) {
      return h(
        'div',
        { className: 'dsh-autofit-box dsh-autofit-box-error' },
        h('strong', null, message || t('errorUnexpected')),
        code ? h('div', { className: 'dsh-autofit-label', style: { marginTop: 4 } }, `${t('installErrorCode')}: ${code}`) : null,
      )
    }

    function CheckSummary({ t, result }) {
      if (!result) return null
      const describe = result.L1 && result.L1.describe ? result.L1.describe : null
      const impact = describe && describe.profileImpact ? describe.profileImpact : null
      const high = Boolean(impact && impact.level === 'high')
      const codes = Array.isArray(result.codes) ? result.codes : []
      const failures = []
      const hostFailures = result.L2 && result.L2.host && Array.isArray(result.L2.host.failures) ? result.L2.host.failures : []
      const clientFailures = result.L2 && result.L2.client && Array.isArray(result.L2.client.failures) ? result.L2.client.failures : []
      for (const item of hostFailures) failures.push(item)
      for (const item of clientFailures) failures.push(item)

      const impactRows = []
      if (impact) {
        if (impact.disablesCore && impact.disablesCore.length) impactRows.push([t('impactDisables'), impact.disablesCore])
        if (impact.reconfiguresCore && impact.reconfiguresCore.length) impactRows.push([t('impactReconfigures'), impact.reconfiguresCore])
        if (impact.security && impact.security.length) impactRows.push([t('impactSecurity'), impact.security])
        if (impact.removes && impact.removes.length) impactRows.push([t('impactRemoves'), impact.removes])
        if (impact.touchesOther && impact.touchesOther.length) impactRows.push([t('impactOther'), impact.touchesOther])
        if (impact.inserts && impact.inserts.length) impactRows.push([t('impactInserts'), impact.inserts])
      }

      return h(
        'div',
        { className: 'dsh-autofit-summary' },
        h(
          'div',
          { className: 'dsh-autofit-row' },
          h('span', { className: 'dsh-autofit-label' }, t('verdict')),
          h('span', { className: `dsh-autofit-badge dsh-autofit-badge-${toneFor(result.verdict)}` }, verdictLabel(t, result.verdict)),
          result.host && result.host.version
            ? h('span', { className: 'dsh-autofit-label' }, `${t('hostVersion')} ${result.host.version}`)
            : null,
          Number.isFinite(result.durationMs)
            ? h('span', { className: 'dsh-autofit-label' }, `${t('duration')} ${Math.max(0, Math.round(result.durationMs / 1000))}s`)
            : null,
        ),
        result.requestedSpec || result.spec ? h('div', { className: 'dsh-autofit-check-row' }, h('span', { className: 'dsh-autofit-label' }, t('spec')), h('code', { className: 'dsh-autofit-value-mono' }, result.requestedSpec || result.spec)) : null,
        high ? h('div', { className: 'dsh-autofit-box dsh-autofit-box-warn' }, h('strong', null, t('impactHigh')), ' — ', t('impactHighWarning')) : null,
        describe
          ? h(
              'div',
              { className: 'dsh-autofit-grid' },
              h('span', { className: 'dsh-autofit-label' }, t('profile')),
              h('span', { className: 'dsh-autofit-value' }, `${describe.name ?? '—'}${describe.version ? `@${describe.version}` : ''}`),
              h('span', { className: 'dsh-autofit-label' }, t('kind')),
              h('span', { className: 'dsh-autofit-value' }, describe.kind ?? '—'),
              h('span', { className: 'dsh-autofit-label' }, t('targetProfile')),
              h('span', { className: 'dsh-autofit-value' }, describe.targetProfile ?? '—'),
              h('span', { className: 'dsh-autofit-label' }, t('impact')),
              h(
                'span',
                { className: 'dsh-autofit-value' },
                h('span', { className: `dsh-autofit-badge dsh-autofit-badge-${high ? 'error' : impact && impact.level === 'medium' ? 'warn' : 'neutral'}` }, impact && impact.level ? t(`impact${impact.level[0].toUpperCase()}${impact.level.slice(1)}`) : '—'),
              ),
            )
          : null,
        impactRows.length
          ? h(
              'div',
              { className: 'dsh-autofit-grid' },
              ...impactRows.flatMap(([label, values], index) => [
                h('span', { className: 'dsh-autofit-label', key: `impact-label-${index}` }, label),
                h('span', { className: 'dsh-autofit-value dsh-autofit-value-mono', key: `impact-value-${index}` }, values.join(', ')),
              ]),
            )
          : null,
        describe && describe.notes && describe.notes.length
          ? h(
              'div',
              { className: 'dsh-autofit-grid' },
              h('span', { className: 'dsh-autofit-label' }, t('notes')),
              h('span', { className: 'dsh-autofit-value' }, ...describe.notes.map((note, index) => h('div', { key: `note-${index}` }, note))),
            )
          : null,
        h(
          'div',
          { className: 'dsh-autofit-grid' },
          h('span', { className: 'dsh-autofit-label' }, t('layerL1')),
          h('span', { className: 'dsh-autofit-value' }, statusLabel(t, result.L1 && result.L1.status)),
          h('span', { className: 'dsh-autofit-label' }, t('layerL2Host')),
          h('span', { className: 'dsh-autofit-value' }, statusLabel(t, result.L2 && result.L2.host && result.L2.host.status)),
          h('span', { className: 'dsh-autofit-label' }, t('layerL2Client')),
          h(
            'span',
            { className: 'dsh-autofit-value' },
            statusLabel(t, result.L2 && result.L2.client && result.L2.client.status),
            result.L2 && result.L2.client && result.L2.client.reason ? h('span', { className: 'dsh-autofit-label' }, ` — ${result.L2.client.reason}`) : null,
          ),
        ),
        h(
          'div',
          { className: 'dsh-autofit-grid' },
          h('span', { className: 'dsh-autofit-label' }, t('codes')),
          h(
            'span',
            { className: 'dsh-autofit-chips' },
            codes.length ? codes.map((code) => h('span', { className: 'dsh-autofit-chip', key: code }, code)) : h('span', { className: 'dsh-autofit-value' }, t('none')),
          ),
        ),
        failures.length
          ? h(
              'div',
              { className: 'dsh-autofit-box dsh-autofit-box-error' },
              h('strong', null, t('failures')),
              ...failures.map((item, index) =>
                h(
                  'div',
                  { key: `failure-${index}`, style: { marginTop: 6 } },
                  h('code', { className: 'dsh-autofit-value-mono' }, item.package || item.entry || '—'),
                  item.error ? h('div', { className: 'dsh-autofit-label' }, item.error) : null,
                ),
              ),
            )
          : null,
        result.L1 && result.L1.error ? h('div', { className: 'dsh-autofit-box dsh-autofit-box-error' }, h('strong', null, t('reason')), h('div', { style: { marginTop: 4 } }, result.L1.error)) : null,
        result.L1 && result.L1.describeError ? h('div', { className: 'dsh-autofit-box' }, result.L1.describeError) : null,
        result.L1 && result.L1.logTail
          ? h(
              'details',
              { className: 'dsh-autofit-details' },
              h('summary', null, t('logTail')),
              h('pre', { className: 'dsh-autofit-pre' }, result.L1.logTail),
            )
          : null,
      )
    }

    /* ------------------------------------------------------------------ install outcome */

    function InstallOutcome({ t, state }) {
      if (!state) return null
      if (state.status === 'running') {
        return h(
          'div',
          { className: 'dsh-autofit-progress' },
          h('span', { className: 'dsh-autofit-spinner', 'aria-hidden': 'true' }),
          h('div', { className: 'dsh-autofit-progress-text' }, t('installRunning')),
        )
      }
      if (state.status === 'error') {
        return h(ErrorBox, { t, message: state.message || t('installFailed'), code: state.code })
      }
      const value = state.value || {}
      const application = value.application
      const pending = Array.isArray(value.pendingBuilds) ? value.pendingBuilds : []
      const warnings = Array.isArray(value.warnings) ? value.warnings : []
      const isError = application === 'failed' || application === 'cancelled'
      const tone = isError ? 'error' : application === 'applied' ? 'success' : 'warn'
      return h(
        'div',
        { className: `dsh-autofit-box ${isError ? 'dsh-autofit-box-error' : application === 'applied' ? '' : 'dsh-autofit-box-warn'}` },
        h('div', { className: 'dsh-autofit-row' }, h('span', { className: `dsh-autofit-badge dsh-autofit-badge-${tone}` }, application || t('installFailed'))),
        application === 'applied' ? h('div', { style: { marginTop: 6 } }, t('installDone')) : null,
        application === 'restart-required' ? h('div', { style: { marginTop: 6 } }, t('restartRequired')) : null,
        application === 'overridden' ? h('div', { style: { marginTop: 6 } }, t('overridden')) : null,
        value.error
          ? h(
              'div',
              { style: { marginTop: 6 } },
              h('strong', null, value.error.diagnostic || value.error.code || t('installFailed')),
              value.error.code ? h('span', { className: 'dsh-autofit-label' }, ` (${value.error.code})`) : null,
            )
          : null,
        pending.length
          ? h(
              'div',
              { style: { marginTop: 8 } },
              h('strong', null, t('pendingBuilds')),
              h('div', { className: 'dsh-autofit-value-mono', style: { marginTop: 4 } }, pending.join(', ')),
              h('div', { className: 'dsh-autofit-label', style: { marginTop: 4 } }, t('pendingBuildsHint')),
            )
          : null,
        warnings.length
          ? h(
              'div',
              { style: { marginTop: 8 } },
              h('strong', null, t('installWarnings')),
              ...warnings.map((warning, index) => h('div', { key: `warning-${index}`, className: 'dsh-autofit-label' }, warning)),
            )
          : null,
        value.bundle || value.version
          ? h('div', { className: 'dsh-autofit-label', style: { marginTop: 6 } }, `${value.bundle || ''}${value.version ? `@${value.version}` : ''}`)
          : null,
      )
    }

    /* ------------------------------------------------------------------ menu action */

    function AutofitAddMenuItem({ t, onDismiss }) {
      return h(
        React.Fragment,
        null,
        h(StyleTag),
        h(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            className: 'dsh-autofit-menu-item',
            onClick: () => {
              onDismiss()
              openAutofitDialog('')
            },
          },
          h('span', { className: 'dsh-autofit-menu-icon' }, h(ShieldCheckIcon, { size: 20 })),
          h(
            'span',
            { className: 'dsh-autofit-menu-copy' },
            h('span', { className: 'dsh-autofit-menu-title' }, t('menuTitle')),
            h('span', { className: 'dsh-autofit-menu-desc' }, t('menuDescription')),
          ),
        ),
      )
    }

    /* ------------------------------------------------------------------ dialog */

    function AutofitDialog({ t, ctx, initialSpec, onClose }) {
      const [spec, setSpec] = useState(initialSpec || '')
      const [phase, setPhase] = useState('idle')
      const [result, setResult] = useState(null)
      const [error, setError] = useState(null)
      const [installState, setInstallState] = useState(null)
      const [ackHigh, setAckHigh] = useState(false)
      const inputRef = useRef(null)
      const alive = useRef(true)
      const busy = phase === 'checking' || phase === 'installing'

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      useEffect(() => {
        if (initialSpec) setSpec(initialSpec)
      }, [initialSpec])

      useEffect(() => {
        const timer = setTimeout(() => {
          if (inputRef.current) inputRef.current.focus()
        }, 30)
        return () => clearTimeout(timer)
      }, [])

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape' && !busy) onClose()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [busy, onClose])

      const runCheck = useCallback(async () => {
        const value = spec.trim()
        if (!value) {
          setError(t('errorEmpty'))
          return
        }
        setPhase('checking')
        setResult(null)
        setError(null)
        setInstallState(null)
        setAckHigh(false)
        try {
          const response = await callCheck(value)
          if (!alive.current) return
          if (!response.ok) {
            const code = response.error && response.error.code
            setError(code === 'autofit/busy' ? t('errorBusy') : code === 'autofit/invalid-spec' ? t('errorEmpty') : (response.error && response.error.message) || t('errorRpc'))
            setPhase('error')
            return
          }
          setResult(response.value)
          setPhase('result')
        } catch (caught) {
          if (!alive.current) return
          setError(caught && caught.message ? String(caught.message) : t('errorRpc'))
          setPhase('error')
        }
      }, [ctx, spec, t])

      const runInstall = useCallback(async () => {
        if (!result || result.verdict !== 'pass') return
        if (result.L1 && result.L1.describe && result.L1.describe.profileImpact && result.L1.describe.profileImpact.level === 'high' && !ackHigh) return
        // Never install something different from the spec the trial actually checked.
        const value = typeof result.requestedSpec === 'string' && result.requestedSpec ? result.requestedSpec : typeof result.spec === 'string' && result.spec ? result.spec : spec.trim()
        if (!value || value !== spec.trim()) return
        const manager = ctx.remote && ctx.remote.pluginManager
        if (!manager || typeof manager.installBundle !== 'function') {
          setInstallState({ status: 'error', message: t('errorNativeInstall') })
          return
        }
        setPhase('installing')
        setInstallState({ status: 'running' })
        try {
          const response = await manager.installBundle(value)
          if (!alive.current) return
          if (!response.ok) {
            setInstallState({
              status: 'error',
              message: (response.error && response.error.message) || t('installFailed'),
              code: response.error && response.error.code,
            })
            setPhase('result')
            return
          }
          setInstallState({ status: 'done', value: response.value })
          setPhase('installed')
        } catch (caught) {
          if (!alive.current) return
          setInstallState({ status: 'error', message: caught && caught.message ? String(caught.message) : t('installFailed') })
          setPhase('result')
        }
      }, [ackHigh, ctx, result, spec, t])

      const high = Boolean(result && result.L1 && result.L1.describe && result.L1.describe.profileImpact && result.L1.describe.profileImpact.level === 'high')
      const pass = Boolean(result && result.verdict === 'pass')
      const checkedSpec = result && typeof result.requestedSpec === 'string' ? result.requestedSpec : result && typeof result.spec === 'string' ? result.spec : ''
      const specChanged = Boolean(checkedSpec && checkedSpec !== spec.trim())
      const installDone = Boolean(installState && installState.status === 'done')

      return h(
        'div',
        {
          className: 'dsh-autofit-overlay',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !busy) onClose()
          },
        },
        h(
          'div',
          { className: 'dsh-autofit-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('dialogTitle') },
          h(
            'div',
            { className: 'dsh-autofit-head' },
            h(
              'div',
              { className: 'dsh-autofit-head-copy' },
              h('h2', { className: 'dsh-autofit-title' }, t('dialogTitle')),
              h('p', { className: 'dsh-autofit-subtitle' }, t('dialogSubtitle')),
            ),
            h(
              'button',
              { type: 'button', className: 'dsh-autofit-close', 'aria-label': t('close'), title: t('close'), disabled: busy, onClick: onClose },
              '×',
            ),
          ),
          h(
            'div',
            { className: 'dsh-autofit-body' },
            h(
              'div',
              { className: 'dsh-autofit-field' },
              h('label', { className: 'dsh-autofit-label', htmlFor: 'dsh-autofit-spec' }, t('specLabel')),
              h('input', {
                id: 'dsh-autofit-spec',
                ref: inputRef,
                className: 'dsh-autofit-input',
                type: 'text',
                value: spec,
                disabled: busy,
                placeholder: t('specPlaceholder'),
                spellCheck: false,
                autoComplete: 'off',
                onChange: (event) => setSpec(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && !event.nativeEvent?.isComposing && !busy) {
                    event.preventDefault()
                    void runCheck()
                  }
                },
              }),
            ),
            phase === 'checking'
              ? h(
                  'div',
                  { className: 'dsh-autofit-progress' },
                  h('span', { className: 'dsh-autofit-spinner', 'aria-hidden': 'true' }),
                  h(
                    'div',
                    null,
                    h('div', { className: 'dsh-autofit-progress-title' }, t('checking')),
                    h('div', { className: 'dsh-autofit-progress-text' }, t('checkingHint')),
                  ),
                )
              : null,
            h(
              'div',
              { className: 'dsh-autofit-actions' },
              h(
                'button',
                { type: 'button', className: 'dsh-autofit-btn dsh-autofit-btn-primary', disabled: busy || !spec.trim(), onClick: () => void runCheck() },
                busy ? t('checking') : result ? t('recheck') : t('check'),
              ),
            ),
            error ? h(ErrorBox, { t, message: error }) : null,
            result ? h(CheckSummary, { t, result }) : null,
            result && !pass ? h('div', { className: 'dsh-autofit-box' }, h('strong', null, t('reason')), h('div', { style: { marginTop: 4 } }, t('notPassHint'))) : null,
            pass && specChanged ? h('div', { className: 'dsh-autofit-box dsh-autofit-box-warn' }, t('specChanged')) : null,
            pass
              ? h(
                  'div',
                  { className: 'dsh-autofit-box' },
                  h('div', null, t('installHint')),
                  high ? h('label', { className: 'dsh-autofit-checkbox', style: { marginTop: 8 } }, h('input', { type: 'checkbox', checked: ackHigh, onChange: (event) => setAckHigh(event.target.checked) }), h('span', null, t('impactAck'))) : null,
                  h(
                    'div',
                    { className: 'dsh-autofit-actions', style: { marginTop: 10 } },
                    h(
                      'button',
                      { type: 'button', className: 'dsh-autofit-btn dsh-autofit-btn-primary', disabled: busy || specChanged || installDone || (high && !ackHigh), onClick: () => void runInstall() },
                      installDone ? t('installed') : phase === 'installing' ? t('installing') : t('install'),
                    ),
                  ),
                )
              : null,
            phase === 'installing' ? h(InstallOutcome, { t, state: { status: 'running' } }) : null,
            installState && phase !== 'installing' ? h(InstallOutcome, { t, state: installState }) : null,
          ),
        ),
      )
    }

    function AutofitOverlayHost({ t, ctx }) {
      const state = useAutofitDialog()
      return h(
        React.Fragment,
        null,
        h(StyleTag),
        state.open ? h(AutofitDialog, { t, ctx, initialSpec: state.initialSpec, onClose: closeAutofitDialog }) : null,
      )
    }

    /* ------------------------------------------------------------------ detail section */

    function AutofitDetailSection({ t, ctx, subject }) {
      const installed = Boolean(subject && subject.kind === 'bundle' && subject.pkg && subject.pkg.installed)
      const pkg = installed ? subject.pkg : null
      const spec = pkg ? (pkg.version ? `${pkg.name}@${pkg.version}` : pkg.name) : ''
      const [phase, setPhase] = useState('idle')
      const [result, setResult] = useState(null)
      const [error, setError] = useState(null)
      const alive = useRef(true)
      const runId = useRef(0)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      useEffect(() => {
        runId.current += 1
        setPhase('idle')
        setResult(null)
        setError(null)
      }, [spec])

      const run = useCallback(async () => {
        if (!installed || !spec) return
        const token = ++runId.current
        setPhase('checking')
        setResult(null)
        setError(null)
        try {
          const response = await callCheck(spec)
          if (!alive.current || token !== runId.current) return
          if (!response.ok) {
            const code = response.error && response.error.code
            setError(code === 'autofit/busy' ? t('errorBusy') : (response.error && response.error.message) || t('errorRpc'))
            setPhase('error')
            return
          }
          setResult(response.value)
          setPhase('result')
        } catch (caught) {
          if (!alive.current || token !== runId.current) return
          setError(caught && caught.message ? String(caught.message) : t('errorRpc'))
          setPhase('error')
        }
      }, [ctx, installed, spec, t])

      if (!installed) return null

      return h(
        'section',
        { className: 'dsh-autofit-section' },
        h(StyleTag),
        h('h3', { className: 'dsh-autofit-section-title' }, t('bundleSectionTitle')),
        h('p', { className: 'dsh-autofit-section-desc' }, t('bundleSectionDescription')),
        h(
          'div',
          { className: 'dsh-autofit-check-row' },
          h('span', { className: 'dsh-autofit-label' }, t('bundleSpec')),
          h('code', { className: 'dsh-autofit-value-mono' }, spec),
          h(
            'button',
            { type: 'button', className: 'dsh-autofit-btn', disabled: phase === 'checking', onClick: () => void run() },
            phase === 'checking' ? t('bundleChecking') : t('bundleCheck'),
          ),
        ),
        phase === 'checking'
          ? h(
              'div',
              { className: 'dsh-autofit-progress' },
              h('span', { className: 'dsh-autofit-spinner', 'aria-hidden': 'true' }),
              h('div', { className: 'dsh-autofit-progress-text' }, t('checkingHint')),
            )
          : null,
        error ? h(ErrorBox, { t, message: error }) : null,
        result ? h(CheckSummary, { t, result }) : null,
      )
    }

    /* ------------------------------------------------------------------ plugin */

    return {
      inject: ['slots', 'locale', 'connection', 'remote'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(LOCALE_NS, DICTIONARY), 'dsh-autofit: locale dictionary')

        ctx.slots.inject('plugins.add.actions', () =>
          ctx.slots.register(
            {
              name: 'plugins.add.actions',
              id: 'dsh-autofit-install',
              order: 100,
              locale: LOCALE_NS,
            },
            AutofitAddMenuItem,
          ),
        )

        ctx.slots.inject('plugins.detail.section', () =>
          ctx.slots.register(
            {
              name: 'plugins.detail.section',
              id: 'dsh-autofit-check',
              order: 100,
              locale: LOCALE_NS,
            },
            AutofitDetailSection,
          ),
        )

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'dsh-autofit.dialog',
              order: 100,
              locale: LOCALE_NS,
            },
            AutofitOverlayHost,
          ),
        )
      },
    }
  },
})
