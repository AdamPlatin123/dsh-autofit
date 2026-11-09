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
    /** The plugin context, kept for slot components whose props do not carry it. */
    let pluginCtx = null
    /** `remote.pluginManager`, present only while the host serves it (DSH 0.1.7+); see apply(). */
    let pluginManagerRemote = null

// The remote's arity differs across DSH versions: newer ones validate (spec, options) and reject a call with one
// argument ("expected 2 argument(s), got 1"); older ones take only the spec. Try the current shape, fall back.
async function installBundleCompat(manager, spec) {
  const arity = (x) => /expected 1 argument/.test(String((x && x.message) || (x && x.error && x.error.message) || ''))
  try {
    const r = await manager.installBundle(spec, {})
    if (r && r.ok === false && arity(r)) return await manager.installBundle(spec)
    return r
  } catch (e) {
    if (arity(e)) return await manager.installBundle(spec)
    throw e
  }
}

    /* ------------------------------------------------------------------ locale */

    const DICTIONARY = {
      zh: {
        dockTitle: 'Autofit 安装',
        dockMinimize: '收起',
        dockClose: '关闭（后台继续）',
        dockCancel: '取消',
        dockExpand: '展开',
        dockQueued: '排队中…',
        dockRunning: '进行中…',
        dockInstalling: '正在安装…',
        dockInstalled: '已安装',
        dockFailed: '未能安装',
        dockCancelled: '已取消',
        dockStageTrial: '试装原版…',
        dockStageUnpack: '取得源码…',
        dockStageRules: '套用修复规则（第 {n} 轮）',
        dockStageAgent: '修复 agent 接手（{model}）',
        dockTrialOriginal: '原版试装：{v}',
        dockTrialRules: '规则修复后试装：{v}',
        dockAgentTrial: 'agent 试装：{v}',
        dockAgentTrialStart: 'agent 正在试装修改后的版本…',
        dockPass: '试装通过，开始安装',
        dockFixed: '已修复（{by}），开始安装修复版',
        dockByRules: '规则',
        dockByAgent: 'agent',
        dockUnfixed: '修不好：{reason}',
        dockApproval: '需要你批准：{why}',
        dockApprove: '允许并重试',
        dockReview: '待你确认',
        dockFixedReview: 'agent 修好了，改了 {n} 行。确认改动后才会安装',
        dockReviewHint: '这是 agent 对插件代码的改动（相对规则修复后的版本）。确认没问题再安装；放弃则不会安装。',
        dockInstallReviewed: '安装修复版',
        dockDecline: '放弃',
        dockTrialRefused: '试装被拒：{why}',
        dockCountReview: '{n} 个待确认',
        dockRetry: '重试',
        dockDismiss: '移除',
        dockCountBusy: '{n} 个进行中',
        dockCountInstalled: '{n} 个已安装',
        dockCountFailed: '{n} 个未装上',
        installWithAutofix: '用 Autofit 安装',
        checkOnly: '只检查',
        nextStep: '下一步',
        tryFix: '尝试自动修复',
        fixing: '正在自动修复…',
        fixingHint: '逐轮：套用修复规则 → 重新打包 → 再次试装（每轮约 30–60 秒，最多 3 轮）。',
        fixTitle: '自动修复',
        fixRound: '第 {n} 轮',
        fixRoundInitial: '原版',
        fixChanges: '修改内容',
        fixNoChanges: '没有可以自动套用的修复规则。',
        fixFixed: '已修复：修复版通过了试装。',
        fixNotFixed: '自动修复后仍未通过。',
        fixArtifact: '修复版',
        installFixed: '安装修复版',
        needsApproval: '需要你批准',
        allowBuildsRetry: '允许这些构建脚本并重试',
        unresolvedTitle: '无法自动修复',
        tierA: '机械',
        tierB: '规则',
        tabLabel: 'Autofit',
        tabSearch: '搜索插件（名称、描述、分类）',
        tabSource: '来源',
        tabRadar: '雷达',
        tabLoading: '正在加载目录…',
        tabEmpty: '没有匹配的插件。',
        tabMore: '加载更多',
        detailOpen: '详情',
        detailClose: '关闭',
        detailVersion: '最新版本',
        detailEngines: '要求的 DSH 版本',
        detailSpec: '安装标识',
        detailRadar: '雷达判定',
        detailRadarNone: '雷达还没有测过',
        detailRepo: '源码仓库',
        detailHomepage: '主页',
        detailHow: '点「用 Autofit 安装」后会先在临时环境里试装；不通过就自动修复，修好后再装进当前 profile。进度在右下角的胶囊里，点开可看详情。',
        tabInstall: '用 Autofit 安装',
        tabOf: '共 {total} 个',
        radarOk: '雷达实测通过',
        radarIncompatible: '雷达实测不兼容',
        radarPending: '雷达待测',
        badgePass: 'Autofit 通过',
        badgeFail: 'Autofit 未通过',
        badgeOther: 'Autofit：{v}',
        backgroundTitle: '装后自动检查',
        backgroundAt: '检查于 {at}',
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
        verdictInstallOnly: '可安装（后台只做了安装检查）',
        verdictFixed: '已修复',
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
        notPassHint: '原版没有通过试装，因此不直接提供安装；可以尝试自动修复。',
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
        dockTitle: 'Autofit install',
        dockMinimize: 'Minimize',
        dockClose: 'Close (keeps running)',
        dockCancel: 'Cancel',
        dockExpand: 'Expand',
        dockQueued: 'Queued…',
        dockRunning: 'Working…',
        dockInstalling: 'Installing…',
        dockInstalled: 'Installed',
        dockFailed: 'Not installed',
        dockCancelled: 'Cancelled',
        dockStageTrial: 'Trialling the original…',
        dockStageUnpack: 'Fetching the source…',
        dockStageRules: 'Applying repair rules (round {n})',
        dockStageAgent: 'Repair agent takes over ({model})',
        dockTrialOriginal: 'Original trial: {v}',
        dockTrialRules: 'Trial after rules: {v}',
        dockAgentTrial: 'Agent trial: {v}',
        dockAgentTrialStart: 'Agent is trialling its edit…',
        dockPass: 'Trial passed — installing',
        dockFixed: 'Fixed by {by} — installing the repaired build',
        dockByRules: 'rules',
        dockByAgent: 'the agent',
        dockUnfixed: 'Could not fix: {reason}',
        dockApproval: 'Needs your approval: {why}',
        dockApprove: 'Allow and retry',
        dockReview: 'Needs your review',
        dockFixedReview: 'The agent fixed it ({n} lines changed). Nothing is installed until you approve the changes',
        dockReviewHint: 'These are the agent\'s edits to the plugin code (relative to the rule-repaired copy). Install only if they look right; Discard installs nothing.',
        dockInstallReviewed: 'Install repaired build',
        dockDecline: 'Discard',
        dockTrialRefused: 'Trial refused: {why}',
        dockCountReview: '{n} awaiting review',
        dockRetry: 'Retry',
        dockDismiss: 'Dismiss',
        dockCountBusy: '{n} working',
        dockCountInstalled: '{n} installed',
        dockCountFailed: '{n} not installed',
        installWithAutofix: 'Install with autofix',
        checkOnly: 'Check only',
        nextStep: 'Next step',
        tryFix: 'Try autofix',
        fixing: 'Autofixing…',
        fixingHint: 'Round by round: apply repair rules → repack → trial again (about 30–60 s per round, at most 3 rounds).',
        fixTitle: 'Autofix',
        fixRound: 'Round {n}',
        fixRoundInitial: 'Original',
        fixChanges: 'Changes',
        fixNoChanges: 'No repair rule applies automatically.',
        fixFixed: 'Fixed: the repaired build passed the trial.',
        fixNotFixed: 'Still not passing after autofix.',
        fixArtifact: 'Repaired build',
        installFixed: 'Install repaired build',
        needsApproval: 'Needs your approval',
        allowBuildsRetry: 'Allow these build scripts and retry',
        unresolvedTitle: 'Cannot be fixed automatically',
        tierA: 'mechanical',
        tierB: 'rule',
        tabLabel: 'Autofit',
        tabSearch: 'Search plugins (name, description, category)',
        tabSource: 'Source',
        tabRadar: 'Radar',
        tabLoading: 'Loading catalog…',
        tabEmpty: 'No matching plugins.',
        tabMore: 'Load more',
        detailOpen: 'Details',
        detailClose: 'Close',
        detailVersion: 'Latest version',
        detailEngines: 'Requires DSH',
        detailSpec: 'Install spec',
        detailRadar: 'Radar verdict',
        detailRadarNone: 'Not measured by the radar yet',
        detailRepo: 'Source',
        detailHomepage: 'Homepage',
        detailHow: '"Install with autofix" first trial-installs it in a throwaway profile; if that fails it is repaired automatically, and the passing build is installed into this profile. Progress lives in the pill in the bottom-right corner — click it for details.',
        tabInstall: 'Install with autofix',
        tabOf: '{total} plugins',
        radarOk: 'Radar: runs',
        radarIncompatible: 'Radar: incompatible',
        radarPending: 'Radar: not yet tested',
        badgePass: 'Autofit: pass',
        badgeFail: 'Autofit: fail',
        badgeOther: 'Autofit: {v}',
        backgroundTitle: 'Post-install check',
        backgroundAt: 'Checked at {at}',
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
        verdictInstallOnly: 'Installs (background check: install only)',
        verdictFixed: 'Fixed',
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
        notPassHint: 'The original did not pass the trial, so it is not offered for install; you can try autofix.',
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
.dsh-autofit-dock{transform-origin:100% 100%;width:380px;max-width:calc(100vw - 32px);max-height:min(520px,calc(100vh - 32px - var(--dsh-frame-chrome-top,0px)));display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 40px rgba(0,0,0,.18);overflow:hidden;font-size:12.5px}
.dsh-autofit-dock-head{display:flex;align-items:center;gap:8px;padding:10px 10px 8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dsh-autofit-dock-title{flex:1;min-width:0;display:flex;flex-direction:column}
.dsh-autofit-dock-title code{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-autofit-icon-btn{width:26px;height:26px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:16px;line-height:1}
.dsh-autofit-icon-btn:hover{background:var(--dsw-alias-bg-layer-3)}
.dsh-autofit-dock-jobs{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column}
.dsh-autofit-job{border-bottom:1px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;min-height:0}
.dsh-autofit-job:last-child{border-bottom:0}
.dsh-autofit-job.is-open{flex:1}
.dsh-autofit-job-row{display:flex;align-items:center;gap:8px;width:100%;padding:8px 12px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsh-autofit-job-row:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-autofit-job-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-autofit-job-chev{flex:none;color:var(--dsw-alias-label-tertiary)}
.dsh-autofit-dock-log{flex:1;min-height:80px;max-height:300px;overflow:auto;padding:4px 12px 8px;display:flex;flex-direction:column;gap:6px}
.dsh-autofit-dock-line{display:flex;gap:8px;align-items:flex-start;line-height:1.5;word-break:break-word}
.dsh-autofit-dock-line.is-dim{color:var(--dsw-alias-label-tertiary);font-size:11.5px}
.dsh-autofit-dock-line.is-agent{background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:6px 8px}
.dsh-autofit-dock-icon{flex:none;width:16px;text-align:center}
.dsh-autofit-dock-detail{display:block;white-space:pre-wrap;color:var(--dsw-alias-label-tertiary);font-size:11px;margin-top:2px}
.dsh-autofit-dock-review{display:flex;flex-direction:column;gap:4px}
.dsh-autofit-diff{margin:0;max-height:220px;overflow:auto;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre;color:var(--dsw-alias-label-secondary)}
.dsh-autofit-diff .is-add{color:var(--dsw-alias-state-success-primary)}
.dsh-autofit-diff .is-del{color:var(--dsw-alias-state-error-primary)}
.dsh-autofit-diff .is-hunk{color:var(--dsw-alias-label-tertiary)}
.dsh-autofit-dock-foot{display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsh-autofit-pill{display:inline-flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 6px 24px rgba(0,0,0,.16);cursor:pointer;font-size:12px;color:var(--dsw-alias-label-primary)}
.dsh-autofit-list{margin:4px 0 0;padding-left:18px;font-size:12px;line-height:1.7}
.dsh-autofit-tab{display:flex;flex-direction:column;gap:12px;padding:4px 0 24px}
.dsh-autofit-tab-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-autofit-tab-head input{flex:1;min-width:240px}
.dsh-autofit-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px}
.dsh-autofit-card{display:flex;flex-direction:column;gap:6px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.dsh-autofit-card-title{font-weight:600;font-size:13.5px;line-height:1.35;word-break:break-word}
.dsh-autofit-card-desc{font-size:12px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.dsh-autofit-card-meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-autofit-card-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:auto}
.dsh-autofit-overlay{position:fixed;inset:var(--dsh-frame-chrome-top,0px) 0 0 0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.45);pointer-events:auto}
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
.dsh-autofit-pill.is-alert{border-color:var(--dsw-alias-state-error,#d33)}
.dsh-autofit-card-open{all:unset;cursor:pointer;display:block;border-radius:4px}
.dsh-autofit-card-open:hover .dsh-autofit-card-title{text-decoration:underline}
.dsh-autofit-card-open:focus-visible{outline:2px solid var(--dsw-alias-border-focus,#4c8bf5);outline-offset:2px}
.dsh-autofit-detail-backdrop{position:fixed;inset:var(--dsh-frame-chrome-top,0px) 0 0 0;z-index:2147482990;background:rgba(0,0,0,.28);display:flex;justify-content:flex-end}
.dsh-autofit-detail{width:min(440px,100vw);height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);box-shadow:-12px 0 40px rgba(0,0,0,.18);font-size:13px}
.dsh-autofit-detail-head{display:flex;gap:8px;align-items:flex-start;padding:16px 16px 12px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dsh-autofit-detail-head code{font-size:11.5px;color:var(--dsw-alias-label-tertiary);word-break:break-all}
.dsh-autofit-detail-title{font-size:16px;font-weight:600;line-height:1.35;word-break:break-word}
.dsh-autofit-detail-body{flex:1;overflow:auto;padding:12px 16px;display:flex;flex-direction:column;gap:12px}
.dsh-autofit-detail-desc{margin:0;line-height:1.6;white-space:pre-wrap;color:var(--dsw-alias-label-secondary)}
.dsh-autofit-detail-rows{display:flex;flex-direction:column;gap:6px}
.dsh-autofit-detail-row{display:grid;grid-template-columns:120px 1fr;gap:8px;font-size:12.5px}
.dsh-autofit-detail-row>span:first-child{color:var(--dsw-alias-label-tertiary)}
.dsh-autofit-detail-row a{color:var(--dsw-alias-label-link,#2f6fe4);word-break:break-all}
.dsh-autofit-detail-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsh-autofit-progress{display:flex;align-items:flex-start;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2)}
.dsh-autofit-progress-title{font-size:13px;font-weight:600}
.dsh-autofit-progress-text{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
.dsh-autofit-summary{display:flex;flex-direction:column;gap:12px}
.dsh-autofit-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-autofit-badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;line-height:1.6;white-space:nowrap}
.dsh-autofit-badge-success{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 16%,transparent);color:var(--dsw-alias-state-success-primary)}
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
        installed: 'verdictInstallOnly',
        fixed: 'verdictFixed',
        fail: 'verdictFail',
        incompatible: 'verdictIncompatible',
        'infra-fail': 'verdictInfraFail',
        inconclusive: 'verdictInconclusive',
        'not-published': 'verdictNotPublished',
      }[verdict]
      return key ? t(key) : String(verdict ?? '—')
    }

    function toneFor(verdict) {
      if (verdict === 'pass' || verdict === 'fixed') return 'success'
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

    const FIX_PATH = '/api/autofit/fix'
    const CATALOG_PATH = '/api/autofit/catalog'
    const STATUS_PATH = '/api/autofit/status'

    async function callJson(url, init) {
      let response
      try {
        response = await fetch(url, { credentials: 'same-origin', ...init })
      } catch (error) {
        return { ok: false, error: { code: 'autofit/network', message: error && error.message ? String(error.message) : 'request failed' } }
      }
      try {
        const body = await response.json()
        return body && typeof body.ok === 'boolean' ? body : { ok: false, error: { code: 'autofit/bad-response', message: `HTTP ${response.status}` } }
      } catch {
        return { ok: false, error: { code: 'autofit/bad-response', message: `HTTP ${response.status}` } }
      }
    }

    const callFix = (spec, allowBuilds) => callJson(FIX_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spec, allowBuilds: allowBuilds || [] }) })

    function fmt(t, key, vars) {
      let s = t(key)
      for (const [k, v] of Object.entries(vars || {})) s = String(s).split(`{${k}}`).join(String(v))
      return s
    }

    function FixSummary({ t, fix, busy, onAllowBuilds }) {
      const rows = []
      for (const r of fix.rounds || []) {
        rows.push(h('div', { key: `r${r.round}`, className: 'dsh-autofit-row' },
          h('span', { className: 'dsh-autofit-label' }, r.round === 0 ? t('fixRoundInitial') : fmt(t, 'fixRound', { n: r.round })),
          h('span', { className: `dsh-autofit-badge dsh-autofit-badge-${toneFor(r.verdict)}` }, verdictLabel(t, r.verdict)),
          r.codes && r.codes.length ? h('code', { className: 'dsh-autofit-value-mono' }, r.codes.join(', ')) : null))
      }
      const changes = (fix.changes || []).map((c, i) => h('li', { key: i },
        h('span', { className: 'dsh-autofit-chip' }, c.tier === 'A' ? t('tierA') : t('tierB')), ' ',
        h('code', null, c.rule), ' · ', h('code', null, c.file), ' — ', c.detail))
      return h('div', { className: `dsh-autofit-box ${fix.verdict === 'fixed' ? '' : 'dsh-autofit-box-warn'}` },
        h('strong', null, t('fixTitle')),
        h('div', { style: { marginTop: 6 } }, rows),
        h('div', { style: { marginTop: 8 } }, h('div', { className: 'dsh-autofit-label' }, t('fixChanges')),
          changes.length ? h('ul', { className: 'dsh-autofit-list' }, changes) : h('div', null, t('fixNoChanges'))),
        fix.verdict === 'fixed'
          ? h('div', { style: { marginTop: 8 } }, t('fixFixed'), fix.artifact ? h('div', null, h('span', { className: 'dsh-autofit-label' }, t('fixArtifact')), ' ', h('code', { className: 'dsh-autofit-value-mono' }, fix.artifact.version)) : null)
          : h('div', { style: { marginTop: 8 } }, t('fixNotFixed')),
        (fix.needsApproval || []).length
          ? h('div', { style: { marginTop: 8 } }, h('strong', null, t('needsApproval')),
              (fix.needsApproval || []).map((a, i) => h('div', { key: i }, `${a.why} · `, h('code', null, (a.packages || []).join(', ')),
                a.kind === 'allow-builds' ? h('button', { type: 'button', className: 'dsh-autofit-btn', style: { marginLeft: 8 }, disabled: busy, onClick: () => onAllowBuilds(a.packages || []) }, t('allowBuildsRetry')) : null)))
          : null,
        (fix.unresolved || []).length
          ? h('div', { style: { marginTop: 8 } }, h('strong', null, t('unresolvedTitle')),
              h('ul', { className: 'dsh-autofit-list' }, (fix.unresolved || []).map((u, i) => h('li', { key: i }, h('code', null, u.code), ' — ', u.hint))))
          : null,
        fix.error ? h(ErrorBox, { t, message: fix.error }) : null)
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
      const [fix, setFix] = useState(null)
      const inputRef = useRef(null)
      const alive = useRef(true)
      const busy = phase === 'checking' || phase === 'installing' || phase === 'fixing'

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
        setFix(null)
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
        const manager = pluginManagerRemote
        if (!manager || typeof manager.installBundle !== 'function') {
          setInstallState({ status: 'error', message: t('errorNativeInstall') })
          return
        }
        setPhase('installing')
        setInstallState({ status: 'running' })
        try {
          const response = await installBundleCompat(manager, value)
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


      const runFix = useCallback(async (allowBuilds) => {
        const value = spec.trim()
        if (!value) return
        setPhase('fixing')
        setError(null)
        setInstallState(null)
        try {
          const response = await callFix(value, allowBuilds)
          if (!alive.current) return
          if (!response.ok) {
            setError(response.error && response.error.code === 'autofit/busy' ? t('errorBusy') : (response.error && response.error.message) || t('errorRpc'))
            setPhase('result')
            return
          }
          setFix(response.value)
          setPhase('result')
        } catch (caught) {
          if (!alive.current) return
          setError(caught && caught.message ? String(caught.message) : t('errorRpc'))
          setPhase('result')
        }
      }, [spec, t])

      const installFixed = useCallback(async () => {
        if (!fix || fix.verdict !== 'fixed' || !fix.artifact || !fix.artifact.usable) return
        const manager = pluginManagerRemote
        if (!manager || typeof manager.installBundle !== 'function') {
          setInstallState({ status: 'error', message: t('errorNativeInstall') })
          return
        }
        setPhase('installing')
        setInstallState({ status: 'running' })
        try {
          const response = await installBundleCompat(manager, fix.artifact.file)
          if (!alive.current) return
          if (!response.ok) {
            setInstallState({ status: 'error', message: (response.error && response.error.message) || t('installFailed'), code: response.error && response.error.code })
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
      }, [ctx, fix, t])

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
                  if (event.key === 'Enter' && !event.nativeEvent?.isComposing && !busy && spec.trim()) {
                    event.preventDefault()
                    void startAutofitJob(spec.trim(), null, { from: rectOf(event.currentTarget) })
                    onClose()
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
                { type: 'button', className: 'dsh-autofit-btn dsh-autofit-btn-primary', disabled: busy || !spec.trim(), onClick: (event) => { void startAutofitJob(spec.trim(), null, { from: rectOf(event.currentTarget) }); onClose() } },
                t('installWithAutofix'),
              ),
              h(
                'button',
                { type: 'button', className: 'dsh-autofit-btn', disabled: busy || !spec.trim(), onClick: () => void runCheck() },
                busy ? t('checking') : result ? t('recheck') : t('checkOnly'),
              ),
            ),
            error ? h(ErrorBox, { t, message: error }) : null,
            result ? h(CheckSummary, { t, result }) : null,
            result && !pass ? h('div', { className: 'dsh-autofit-box' }, h('strong', null, t('nextStep')), h('div', { style: { marginTop: 4 } }, t('notPassHint')),
              !fix && (result.verdict === 'fail' || result.verdict === 'incompatible')
                ? h('div', { className: 'dsh-autofit-actions', style: { marginTop: 10 } }, h('button', { type: 'button', className: 'dsh-autofit-btn dsh-autofit-btn-primary', disabled: busy || specChanged, onClick: () => void runFix([]) }, t('tryFix')))
                : null) : null,
            phase === 'fixing'
              ? h('div', { className: 'dsh-autofit-progress' }, h('span', { className: 'dsh-autofit-spinner', 'aria-hidden': 'true' }),
                  h('div', null, h('div', { className: 'dsh-autofit-progress-title' }, t('fixing')), h('div', { className: 'dsh-autofit-progress-text' }, t('fixingHint'))))
              : null,
            fix ? h(FixSummary, { t, fix, busy, onAllowBuilds: (pkgs) => void runFix(pkgs) }) : null,
            fix && fix.verdict === 'fixed' && fix.artifact && fix.artifact.usable
              ? h('div', { className: 'dsh-autofit-actions', style: { marginTop: 10 } },
                  h('button', { type: 'button', className: 'dsh-autofit-btn dsh-autofit-btn-primary', disabled: busy || installDone, onClick: () => void installFixed() },
                    installDone ? t('installed') : phase === 'installing' ? t('installing') : t('installFixed')))
              : null,
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

    /** Hosts without `shell.overlay` (DSH 0.1.5) never mount the overlay; the tab then shows the dialog inline. */
    let overlayHosts = 0

    function AutofitOverlayHost({ t, ctx }) {
      const state = useAutofitDialog()
      useEffect(() => {
        overlayHosts += 1
        return () => { overlayHosts -= 1 }
      }, [])
      return h(
        React.Fragment,
        null,
        h(StyleTag),
        state.open ? h(AutofitDialog, { t, ctx, initialSpec: state.initialSpec, onClose: closeAutofitDialog }) : null,
        h(AutofitDock, { t }),
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
        !result && pkg ? h(BackgroundResult, { t, name: pkg.name }) : null,
      )
    }


    /* ------------------------------------------------------------------ Autofit tab */

    function pickText(v) {
      if (!v) return ''
      if (typeof v === 'string') return v
      const lang = (document.documentElement.lang || navigator.language || 'en').toLowerCase()
      return (lang.startsWith('zh') ? v.zh || v.en : v.en || v.zh) || Object.values(v)[0] || ''
    }

    function radarChip(t, radar) {
      if (!radar) return null
      const key = radar === 'ok' ? 'radarOk' : radar === 'incompatible' ? 'radarIncompatible' : 'radarPending'
      const tone = radar === 'ok' ? 'success' : radar === 'incompatible' ? 'error' : 'neutral'
      return h('span', { className: `dsh-autofit-badge dsh-autofit-badge-${tone}` }, t(key))
    }

    function AutofitTab({ t, ctx }) {
      const dialog = useAutofitDialog()
      const [q, setQ] = useState('')
      const [items, setItems] = useState([])
      const [total, setTotal] = useState(0)
      const [meta, setMeta] = useState(null)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState(null)
      const [detail, setDetail] = useState(null)
      const seq = useRef(0)

      const load = useCallback(async (query, offset) => {
        const token = ++seq.current
        setLoading(true)
        setError(null)
        const r = await callJson(CATALOG_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: query, offset, limit: 30 }) })
        if (token !== seq.current) return
        setLoading(false)
        if (!r.ok) { setError((r.error && r.error.message) || t('errorRpc')); return }
        setTotal(r.value.total)
        setMeta({ source: r.value.source, radarAt: r.value.radarAt })
        setItems((prev) => (offset ? prev.concat(r.value.items) : r.value.items))
      }, [t])

      useEffect(() => {
        const timer = setTimeout(() => void load(q, 0), q ? 300 : 0)
        return () => clearTimeout(timer)
      }, [q, load])

      return h('div', { className: 'dsh-autofit-tab' }, h(StyleTag),
        dialog.open && overlayHosts === 0 ? h(AutofitDialog, { t, ctx, initialSpec: dialog.initialSpec, onClose: closeAutofitDialog }) : null,
        h(AutofitDock, { t, inline: true }),  // shows only when no overlay dock owns the page
        h('div', { className: 'dsh-autofit-tab-head' },
          h('input', { className: 'dsh-autofit-input', type: 'search', value: q, placeholder: t('tabSearch'), onChange: (e) => setQ(e.target.value) }),
          h('span', null, fmt(t, 'tabOf', { total })),
          meta ? h('span', null, `${t('tabSource')}: ${String(meta.source || '').replace(/^https?:\/\//, '').split('/')[0]}${meta.radarAt ? ` · ${t('tabRadar')} ${String(meta.radarAt).slice(0, 10)}` : ''}`) : null),
        error ? h(ErrorBox, { t, message: error }) : null,
        detail ? h(CatalogDetail, { t, item: detail, onClose: () => setDetail(null) }) : null,
        h('div', { className: 'dsh-autofit-cards' }, items.map((it) => h('div', { key: it.name, className: 'dsh-autofit-card' },
          h('button', { type: 'button', className: 'dsh-autofit-card-open', title: t('detailOpen'), onClick: () => setDetail(it) },
            h('span', { className: 'dsh-autofit-card-title' }, pickText(it.title) || it.name)),
          h('div', { className: 'dsh-autofit-card-meta' }, h('code', null, it.spec), it.category ? h('span', { className: 'dsh-autofit-chip' }, it.category) : null,
            it.stars != null ? h('span', null, `★ ${it.stars}`) : null, radarChip(t, it.radar)),
          h('div', { className: 'dsh-autofit-card-desc' }, pickText(it.description)),
          h('div', { className: 'dsh-autofit-card-foot' },
            h('button', { type: 'button', className: 'dsh-autofit-btn', onClick: () => setDetail(it) }, t('detailOpen')),
            h('button', { type: 'button', className: 'dsh-autofit-btn dsh-autofit-btn-primary', onClick: (event) => void startAutofitJob(it.spec, null, { from: rectOf(event.currentTarget) }) }, t('tabInstall')))))),
        loading ? h('div', { className: 'dsh-autofit-progress' }, h('span', { className: 'dsh-autofit-spinner', 'aria-hidden': 'true' }), h('div', { className: 'dsh-autofit-progress-text' }, t('tabLoading'))) : null,
        !loading && !error && !items.length ? h('div', { className: 'dsh-autofit-section-desc' }, t('tabEmpty')) : null,
        !loading && items.length < total ? h('div', { className: 'dsh-autofit-actions' }, h('button', { type: 'button', className: 'dsh-autofit-btn', onClick: () => void load(q, items.length) }, t('tabMore'))) : null)
    }

    /** Catalog item detail: everything the index and the radar know, plus our own check if it is installed here. */
    function CatalogDetail({ t, item, onClose }) {
      useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      const link = (href, label) => (href ? h('a', { href: String(href).replace(/^git\+/, '').replace(/\.git$/, ''), target: '_blank', rel: 'noreferrer noopener' }, label) : null)
      const row = (k, v) => (v == null || v === '' ? null : h('div', { className: 'dsh-autofit-detail-row' }, h('span', null, k), h('span', null, v)))
      const install = (event) => { const from = rectOf(event.currentTarget); onClose(); void startAutofitJob(item.spec, null, { from }) }
      return h('div', { className: 'dsh-autofit-detail-backdrop', onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() } },
        h('aside', { className: 'dsh-autofit-detail', role: 'dialog', 'aria-modal': 'true', 'aria-label': pickText(item.title) || item.name },
          h('div', { className: 'dsh-autofit-detail-head' },
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { className: 'dsh-autofit-detail-title' }, pickText(item.title) || item.name),
              h('code', null, item.name)),
            h('button', { type: 'button', className: 'dsh-autofit-icon-btn', 'aria-label': t('detailClose'), title: t('detailClose'), onClick: onClose }, '×')),
          h('div', { className: 'dsh-autofit-detail-body' },
            h('div', { className: 'dsh-autofit-card-meta' }, radarChip(t, item.radar), item.category ? h('span', { className: 'dsh-autofit-chip' }, item.category) : null, item.stars != null ? h('span', null, `★ ${item.stars}`) : null),
            pickText(item.description) ? h('p', { className: 'dsh-autofit-detail-desc' }, pickText(item.description)) : null,
            h('div', { className: 'dsh-autofit-detail-rows' },
              row(t('detailVersion'), item.version),
              row(t('detailEngines'), item.engines),
              row(t('detailSpec'), h('code', null, item.spec)),
              row(t('detailRadar'), item.radar ? radarChip(t, item.radar) : t('detailRadarNone')),
              row(t('detailRepo'), link(item.repository, String(item.repository || '').replace(/^git\+/, '').replace(/^https?:\/\//, '').replace(/\.git$/, ''))),
              row(t('detailHomepage'), link(item.homepage, String(item.homepage || '').replace(/^https?:\/\//, '')))),
            h(BackgroundResult, { t, name: item.name }),
            h('p', { className: 'dsh-autofit-section-desc' }, t('detailHow'))),
          h('div', { className: 'dsh-autofit-detail-foot' },
            h('button', { type: 'button', className: 'dsh-autofit-btn', onClick: onClose }, t('detailClose')),
            h('button', { type: 'button', className: 'dsh-autofit-btn dsh-autofit-btn-primary', autoFocus: true, onClick: install }, t('tabInstall')))))
    }

    /* ------------------------------------------------------------------ background check (badge + section) */

    function useBackgroundCheck(name) {
      const [check, setCheck] = useState(null)
      useEffect(() => {
        if (!name) return undefined
        let live = true
        void callJson(STATUS_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }).then((r) => { if (live && r.ok) setCheck(r.value) })
        return () => { live = false }
      }, [name])
      return check
    }

    function AutofitBadge({ t, subject }) {
      const name = subject && subject.kind === 'bundle' && subject.pkg && subject.pkg.installed ? subject.pkg.name : null
      const check = useBackgroundCheck(name)
      if (!check || !check.verdict) return null
      const label = check.verdict === 'pass' ? t('badgePass') : check.verdict === 'fail' ? t('badgeFail') : fmt(t, 'badgeOther', { v: verdictLabel(t, check.verdict) })
      return h(React.Fragment, null, h(StyleTag), h('span', { className: `dsh-autofit-badge dsh-autofit-badge-${toneFor(check.verdict)}`, title: check.at }, label))
    }

    function BackgroundResult({ t, name }) {
      const check = useBackgroundCheck(name)
      if (!check) return null
      return h('div', { className: 'dsh-autofit-box', style: { marginTop: 8 } },
        h('strong', null, t('backgroundTitle')), ' ', h('span', { className: 'dsh-autofit-section-desc' }, fmt(t, 'backgroundAt', { at: String(check.at || '').replace('T', ' ').slice(0, 16) })),
        h(CheckSummary, { t, result: check }))
    }

    /* ------------------------------------------------------------------ "Install with autofix" jobs + dock */

    const JOB = { start: '/api/autofit/job/start', poll: '/api/autofit/job/poll', cancel: '/api/autofit/job/cancel', list: '/api/autofit/job/list', installed: '/api/autofit/job/installed' }
    const postJson = (url, body) => callJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })

    /** Module-level store shared by every mounted dock (overlay or inline tab fallback). */
    let dock = { jobs: [], focus: null, open: false, minimized: false, restored: false }
    const dockListeners = new Set()
    const emitDock = () => { for (const l of dockListeners) l() }
    function setDock(patch) { dock = { ...dock, ...patch }; emitDock() }
    function upsertJob(view, append) {
      const jobs = dock.jobs.slice()
      const i = jobs.findIndex((j) => j.id === view.id)
      const prev = i >= 0 ? jobs[i] : { events: [] }
      // A poll answers "events from `since` on" and says where the log now ends (`next`); keep only what is new to us,
      // so overlapping or repeated polls never duplicate lines.
      let events = view.events || prev.events
      if (append) {
        const have = prev.next || 0
        const fresh = view.events || []
        const skip = typeof view.next === 'number' ? Math.max(0, have - (view.next - fresh.length)) : 0
        events = prev.events.concat(fresh.slice(skip))
      }
      const next = { ...prev, ...view, events, next: Math.max(prev.next || 0, view.next || 0) }
      if (i >= 0) jobs[i] = next; else jobs.push(next)
      setDock({ jobs })
      if (prev.status && isBusy(prev) && !isBusy(next)) scheduleSettle(next)
      // The expanded job follows the work: when a queued job starts and the expanded one isn't running, switch to it.
      if (prev.status === 'queued' && next.status === 'running') {
        const cur = dock.jobs.find((j) => j.id === dock.focus)
        if (!cur || !(cur.status === 'running' || cur.status === 'installing')) setDock({ focus: next.id })
      }
      return next
    }

    // Auto-collapse: a job that installed folds away after a moment and the dock moves on to the next one that needs
    // attention; once nothing is running and nothing failed, the dock shrinks to the corner pill. Failures stay open.
    function scheduleSettle(job) {
      setTimeout(() => {
        const cur = dock.jobs.find((j) => j.id === job.id)
        if (!cur || isBusy(cur)) return
        const busy = dock.jobs.filter(isBusy)
        const failed = dock.jobs.filter((j) => j.status === 'failed')
        if (cur.status === 'installed' && dock.focus === cur.id) {
          const next = failed[failed.length - 1] || busy[busy.length - 1]
          setDock({ focus: next ? next.id : null })
        }
        if (!busy.length && !failed.length && !dock.minimized) collapseDock()
      }, 4000)
    }

    function dismissJob(id) {
      const jobs = dock.jobs.filter((j) => j.id !== id)
      setDock({ jobs, focus: dock.focus === id ? null : dock.focus, open: jobs.length ? dock.open : false })
    }
    function useDock() {
      const [, force] = useState(0)
      useEffect(() => { const l = () => force((v) => v + 1); dockListeners.add(l); return () => { dockListeners.delete(l) } }, [])
      return dock
    }

    /** A plugin-manager failure as one line: its code plus the line of the diagnostic (pnpm's output) that says why. */
    function installError(e) {
      if (!e) return null
      const lines = String(e.diagnostic || '').split('\n').map((l) => l.trim()).filter(Boolean)
      const why = lines.find((l) => /ERR_|error/i.test(l)) || lines[lines.length - 1]
      return [e.message || e.code, why].filter(Boolean).join(': ') || null
    }

    const installing = new Set()
    async function installReady(job, approved) {
      // An agent repair (status `review`) installs only from the user's click on its diff, never from polling.
      const allowed = job.status === 'ready' || (approved === true && job.status === 'review')
      if (installing.has(job.id) || !allowed || !job.result || !job.result.install) return
      installing.add(job.id)
      upsertJob({ id: job.id, status: 'installing' })
      const manager = pluginManagerRemote
      let application = null
      let error = null
      try {
        if (!manager || typeof manager.installBundle !== 'function') throw new Error('DSH plugin manager is not available on this page')
        const r = await installBundleCompat(manager, job.result.install)
        const v = r && r.value ? r.value : r
        if ((r && r.ok === false) || (v && (v.application === 'failed' || v.application === 'cancelled'))) {
          error = installError(r && r.error) || installError(v && v.error) || `install ${v && v.application}`
        } else application = (v && v.application) || 'applied'
      } catch (e) { error = e && e.message ? String(e.message) : String(e) }
      const res = await postJson(JOB.installed, { id: job.id, application, error })
      if (res.ok) upsertJob({ ...res.value, events: res.value.events }, true)
      else upsertJob({ id: job.id, status: error ? 'failed' : 'installed', installed: { application, error } })
    }

    let pollTimer = null
    function ensurePolling() {
      if (pollTimer) return
      let inFlight = false
      pollTimer = setInterval(async () => {
        if (inFlight) return  // a trial can keep the host slow; never let two ticks overlap
        inFlight = true
        try { await pollOnce() } finally { inFlight = false }
      }, 1500)
      async function pollOnce() {
        const live = dock.jobs.filter((j) => (j.status === 'queued' || j.status === 'running') && !String(j.id).startsWith('pending-'))
        for (const j of live) {
          const r = await postJson(JOB.poll, { id: j.id, since: j.next || 0 })
          if (r.ok) { const v = upsertJob(r.value, true); if (v.status === 'ready') void installReady(v) }
        }
        for (const j of dock.jobs) if (j.status === 'ready') void installReady(j)
        if (!dock.jobs.some((j) => j.status === 'queued' || j.status === 'running' || j.status === 'ready' || j.status === 'installing')) { clearInterval(pollTimer); pollTimer = null }
      }
    }

    // Motion is driven with the Web Animations API, not CSS keyframes: it runs wherever the element exists and does
    // not depend on the injected stylesheet. With "reduce motion" (Windows: Settings > Accessibility > Animation
    // effects off) nothing travels: the pill fades in and glows instead, so the hand-off is still visible.
    const reduceMotion = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false } }
    const canAnimate = (el) => !!(el && typeof el.animate === 'function')
    const rectOf = (el) => { try { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } } catch { return null } }
    const centre = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

    function whenPresent(selector, cb, tries = 40) {
      const el = document.querySelector(selector)
      if (el) { cb(el); return }
      if (tries > 0) requestAnimationFrame(() => whenPresent(selector, cb, tries - 1))
    }

    function pulsePill(pill) {
      if (!canAnimate(pill)) return
      if (reduceMotion()) {
        pill.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' })
        pill.animate([{ boxShadow: '0 0 0 0 rgba(47,111,228,0)' }, { boxShadow: '0 0 0 6px rgba(47,111,228,.35)' }, { boxShadow: '0 0 0 0 rgba(47,111,228,0)' }], { duration: 700, iterations: 2 })
        return
      }
      pill.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.14)' }, { transform: 'scale(.96)' }, { transform: 'scale(1)' }], { duration: 420, easing: 'ease-out' })
    }

    /** A dot leaves the button that was clicked and lands on the corner pill, which then bounces. */
    function flyToPill(from) {
      whenPresent('.dsh-autofit-pill', (pill) => {
        const to = rectOf(pill)
        if (!from || !to || reduceMotion() || typeof document.body.animate !== 'function') { pulsePill(pill); return }
        const a = centre(from)
        const b = centre(to)
        const dot = document.createElement('div')
        dot.className = 'dsh-autofit-flight'
        dot.setAttribute('aria-hidden', 'true')
        Object.assign(dot.style, { position: 'fixed', left: `${a.x - 9}px`, top: `${a.y - 9}px`, width: '18px', height: '18px', borderRadius: '50%',
          background: 'var(--dsw-alias-label-link, #2f6fe4)', boxShadow: '0 4px 14px rgba(47,111,228,.45)', zIndex: '2147483001', pointerEvents: 'none' })
        document.body.appendChild(dot)
        const dx = b.x - a.x
        const dy = b.y - a.y
        const lift = Math.min(160, Math.abs(dx) * 0.25 + 60)
        const anim = dot.animate([
          { transform: 'translate(0,0) scale(1)', opacity: 1 },
          { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - lift}px) scale(1.15)`, opacity: 1, offset: 0.45 },
          { transform: `translate(${dx}px, ${dy}px) scale(.55)`, opacity: 0.9 },
        ], { duration: 620, easing: 'cubic-bezier(.3,.7,.4,1)' })
        let fired = false
        const done = () => { if (fired) return; fired = true; dot.remove(); const p2 = document.querySelector('.dsh-autofit-pill'); if (p2) pulsePill(p2) }
        anim.onfinish = done
        anim.oncancel = done
        setTimeout(done, 1200)
      })
    }

    /** Fold the open dock into the pill: shrink toward the corner, then switch state. */
    function collapseDock() {
      const el = document.querySelector('.dsh-autofit-dock')
      if (!canAnimate(el) || el.style.position !== 'fixed') { setDock({ minimized: true }); return }
      const anim = reduceMotion()
        ? el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-in', fill: 'forwards' })
        : el.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(.35)', opacity: 0 }], { duration: 220, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' })
      let fired = false
      const done = () => { if (fired) return; fired = true; setDock({ minimized: true }); whenPresent('.dsh-autofit-pill', pulsePill) }
      anim.onfinish = done
      setTimeout(done, 400)
    }

    /** Start a job. From the catalog, detail or dialog the job lands in the corner pill (`pop` animates it);
     *  the dock's own retry/approve buttons pass { expand: true } and keep the dock open. */
    async function startAutofitJob(spec, allowBuilds, opts) {
      const expand = !!(opts && opts.expand)
      // The pill appears at the click, before the host answers: a placeholder row stands in until the job id arrives.
      const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      upsertJob({ id: tempId, spec, status: 'queued', events: [] })
      setDock({ open: true, minimized: !expand, pop: expand ? dock.pop : Date.now() })
      if (!expand) flyToPill(opts && opts.from)
      const r = await postJson(JOB.start, { spec, allowBuilds: allowBuilds || [] })
      setDock({ jobs: dock.jobs.filter((j) => j.id !== tempId), focus: dock.focus === tempId ? null : dock.focus })
      if (!r.ok) { upsertJob({ id: `error-${Date.now()}`, spec, status: 'failed', events: [{ type: 'done', outcome: 'error', reason: (r.error && r.error.message) || 'request failed' }] }); return }
      upsertJob(r.value)
      // Don't take the stage from a job that is running right now; the new one queues behind it, folded.
      const cur = dock.jobs.find((j) => j.id === dock.focus)
      if (!cur || !(cur.status === 'running' || cur.status === 'installing')) setDock({ focus: r.value.id })
      ensurePolling()
    }

    async function restoreJobs() {
      if (dock.restored) return
      dock.restored = true
      const r = await postJson(JOB.list, {})
      if (!r.ok || !Array.isArray(r.value)) return
      for (const v of r.value) upsertJob(v)
      const live = r.value.filter((v) => v.status === 'queued' || v.status === 'running' || v.status === 'ready' || v.status === 'review')
      if (live.length) { setDock({ open: true, minimized: true, focus: live[live.length - 1].id }); ensurePolling() }
    }

    function eventLine(t, e) {
      switch (e.type) {
        case 'stage':
          if (e.stage === 'trial') return { icon: '◌', text: t('dockStageTrial') }
          if (e.stage === 'unpack') return { icon: '⇣', text: t('dockStageUnpack') }
          if (e.stage === 'rules') return { icon: '⚙', text: fmt(t, 'dockStageRules', { n: e.round }), detail: (e.changes || []).map((c) => `${c.rule} · ${c.file} — ${c.detail}`).join('\n') }
          if (e.stage === 'agent') return { icon: '✦', text: fmt(t, 'dockStageAgent', { model: e.model || '' }) }
          return null
        case 'trial':
          if (e.stage === 'original') return { icon: e.verdict === 'pass' ? '✓' : '✗', text: fmt(t, 'dockTrialOriginal', { v: verdictLabel(t, e.verdict) }), detail: (e.codes || []).join(', ') }
          if (e.stage && e.stage.startsWith('rules')) return { icon: e.verdict === 'pass' ? '✓' : '✗', text: fmt(t, 'dockTrialRules', { v: verdictLabel(t, e.verdict) }), detail: (e.codes || []).join(', ') }
          return { icon: e.verdict === 'pass' ? '✓' : '✗', text: fmt(t, 'dockAgentTrial', { v: verdictLabel(t, e.verdict) }), detail: (e.codes || []).join(', ') }
        case 'trial-start': return { icon: '◌', text: t('dockAgentTrialStart') }
        case 'trial-refused': return { icon: '!', text: fmt(t, 'dockTrialRefused', { why: (e.reasons || []).join('; ') }) }
        case 'say': return { icon: '›', text: e.text, agent: true }
        case 'think': return null
        case 'tool': return e.name === 'run_trial' ? null : { icon: '·', text: `${e.name} ${e.args || ''}`, dim: true }
        case 'tool-result': return e.ok ? null : { icon: '!', text: `${e.name}: ${e.text}`, dim: true }
        case 'done':
          if (e.outcome === 'pass') return { icon: '✓', text: t('dockPass') }
          if (e.outcome === 'fixed' && e.review) return { icon: '⚠', text: fmt(t, 'dockFixedReview', { n: e.lines == null ? '?' : e.lines }) }
          if (e.outcome === 'fixed') return { icon: '✓', text: fmt(t, 'dockFixed', { by: e.by === 'agent' ? t('dockByAgent') : t('dockByRules') }) }
          if (e.outcome === 'needs-approval') return { icon: '⚠', text: fmt(t, 'dockApproval', { why: (e.needsApproval || []).map((a) => `${a.why} (${(a.packages || []).join(', ')})`).join('; ') }) }
          return { icon: '✗', text: fmt(t, 'dockUnfixed', { reason: e.reason || (e.unresolved || []).map((u) => u.hint).join('; ') || e.outcome }) }
        case 'installed': return e.error ? { icon: '✗', text: `${t('installFailed')}: ${e.error}` } : { icon: '✓', text: `${t('dockInstalled')} (${e.application || 'applied'})` }
        default: return null
      }
    }

    function statusText(t, job) {
      return { queued: t('dockQueued'), running: t('dockRunning'), ready: t('dockInstalling'), review: t('dockReview'), installing: t('dockInstalling'), installed: t('dockInstalled'), failed: t('dockFailed'), cancelled: t('dockCancelled') }[job.status] || job.status
    }

    const isBusy = (j) => j.status === 'queued' || j.status === 'running' || j.status === 'ready' || j.status === 'installing'
    const shortName = (spec) => String(spec).split('/').pop().slice(0, 40)

    // One dock per page. Several components may want to show it (the shell overlay on every host that has one, the
    // Autofit tab inline on hosts that don't); the first claimant owns it, and an overlay always wins over inline.
    let dockOwner = null
    function claimDock(me, inline) {
      if (!dockOwner || (dockOwner.inline && !inline)) { dockOwner = { me, inline }; emitDock() }
    }
    function releaseDock(me) { if (dockOwner && dockOwner.me === me) { dockOwner = null; emitDock() } }

    const DOCK_IDLE_MS = 5000

    function AutofitDock({ t, inline }) {
      const d = useDock()
      const me = useRef({}).current
      const logRef = useRef(null)
      // Idle collapse: once expanded, the dock folds back into the pill after 5 s without the pointer over it or any
      // input inside it. Hovering, scrolling the log, clicking or typing in it keeps it open.
      const lastTouch = useRef(Date.now())
      const hovering = useRef(false)
      const touch = () => { lastTouch.current = Date.now() }
      const expanded = d.open && !d.minimized && !inline
      const dockRef = useRef(null)
      // Grow out of the corner when the dock opens.
      useEffect(() => {
        const el = dockRef.current
        if (!expanded || !canAnimate(el)) return
        if (reduceMotion()) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' })
        else el.animate([{ transform: 'scale(.4)', opacity: 0 }, { transform: 'scale(1.02)', opacity: 1, offset: 0.7 }, { transform: 'scale(1)', opacity: 1 }], { duration: 240, easing: 'cubic-bezier(.2,.8,.3,1)' })
      }, [expanded])
      useEffect(() => {
        if (!expanded) return undefined
        lastTouch.current = Date.now()
        const timer = setInterval(() => {
          if (!hovering.current && Date.now() - lastTouch.current >= DOCK_IDLE_MS) collapseDock()
        }, 500)
        return () => clearInterval(timer)
      }, [expanded])
      useEffect(() => { claimDock(me, !!inline); void restoreJobs(); return () => releaseDock(me) }, [])
      // Owner may have gone away (tab closed while the overlay never existed): reclaim on the next render.
      useEffect(() => { if (!dockOwner) claimDock(me, !!inline) })
      const focus = d.jobs.find((j) => j.id === d.focus) || null
      // Follow the newest line, and land there again whenever the dock reopens: a review's diff is the log's last block.
      useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, [focus && focus.events && focus.events.length, d.focus, expanded, focus && focus.status])
      if (!dockOwner || dockOwner.me !== me) return null
      if (!d.open || !d.jobs.length) return null
      const base = inline ? { position: 'relative' } : { position: 'fixed', right: 16, bottom: 16, zIndex: 2147483000 }
      const busyN = d.jobs.filter(isBusy).length
      const okN = d.jobs.filter((j) => j.status === 'installed').length
      const badN = d.jobs.filter((j) => j.status === 'failed').length
      const reviewN = d.jobs.filter((j) => j.status === 'review').length
      const summary = [busyN ? fmt(t, 'dockCountBusy', { n: busyN }) : null, reviewN ? fmt(t, 'dockCountReview', { n: reviewN }) : null, okN ? fmt(t, 'dockCountInstalled', { n: okN }) : null, badN ? fmt(t, 'dockCountFailed', { n: badN }) : null].filter(Boolean).join(' · ')
      if (d.minimized) {
        const one = d.jobs.length === 1 ? d.jobs[0] : null
        return h('button', { type: 'button', className: `dsh-autofit-pill${badN && !busyN ? ' is-alert' : ''}`, style: base, title: t('dockExpand'), onClick: () => setDock({ minimized: false }) },
          h(ShieldCheckIcon, { size: 16 }), busyN ? h('span', { className: 'dsh-autofit-spinner', 'aria-hidden': 'true' }) : null,
          h('span', null, one ? `${statusText(t, one)} · ${shortName(one.spec)}` : summary))
      }
      return h('div', { className: 'dsh-autofit-dock', style: base, role: 'dialog', 'aria-label': t('dockTitle'), ref: dockRef,
        onMouseEnter: () => { hovering.current = true; touch() }, onMouseLeave: () => { hovering.current = false; touch() },
        onPointerDown: touch, onKeyDown: touch, onWheel: touch, onFocus: touch },
        h('div', { className: 'dsh-autofit-dock-head' },
          h(ShieldCheckIcon, { size: 16 }),
          h('div', { className: 'dsh-autofit-dock-title' }, h('strong', null, t('dockTitle')), h('code', null, summary)),
          h('button', { type: 'button', className: 'dsh-autofit-icon-btn', title: t('dockMinimize'), 'aria-label': t('dockMinimize'), onClick: () => collapseDock() }, '–'),
          h('button', { type: 'button', className: 'dsh-autofit-icon-btn', title: t('dockClose'), 'aria-label': t('dockClose'), onClick: () => (busyN ? collapseDock() : setDock({ open: false })) }, '×')),
        h('div', { className: 'dsh-autofit-dock-jobs' },
          d.jobs.map((job) => h(DockJob, { key: job.id, t, job, open: job.id === d.focus, logRef: job.id === d.focus ? logRef : null }))))
    }

    /** The agent's edits, as a unified diff with added and removed lines coloured. */
    function DiffView({ t, diff }) {
      return h('div', { className: 'dsh-autofit-dock-review' },
        h('div', { className: 'dsh-autofit-dock-detail' }, t('dockReviewHint')),
        h('pre', { className: 'dsh-autofit-diff' }, String(diff || '').split('\n').map((l, i) =>
          h('span', { key: i, className: l.startsWith('@@') ? 'is-hunk' : l.startsWith('+') && !l.startsWith('+++') ? 'is-add' : l.startsWith('-') && !l.startsWith('---') ? 'is-del' : null }, l + '\n'))))
    }

    function DockJob({ t, job, open, logRef }) {
      const busy = isBusy(job)
      const tone = job.status === 'installed' ? 'success' : job.status === 'failed' ? 'error' : job.status === 'cancelled' ? 'neutral' : 'warn'
      const row = h('button', { type: 'button', className: `dsh-autofit-job-row${open ? ' is-open' : ''}`, 'aria-expanded': open,
        onClick: () => setDock({ focus: open ? null : job.id }) },
        busy ? h('span', { className: 'dsh-autofit-spinner', 'aria-hidden': 'true' }) : h('span', { className: 'dsh-autofit-dock-icon' }, job.status === 'installed' ? '✓' : job.status === 'failed' ? '✗' : '–'),
        h('span', { className: 'dsh-autofit-job-name', title: String(job.spec) }, shortName(job.spec)),
        h('span', { className: `dsh-autofit-badge dsh-autofit-badge-${tone}` }, statusText(t, job)),
        h('span', { className: 'dsh-autofit-job-chev', 'aria-hidden': 'true' }, open ? '▾' : '▸'))
      if (!open) return h('div', { className: 'dsh-autofit-job' }, row)
      const lines = (job.events || []).map((e) => eventLine(t, e)).filter(Boolean)
      const lastDone = [...(job.events || [])].reverse().find((e) => e.type === 'done')
      const approval = lastDone && lastDone.outcome === 'needs-approval' ? (lastDone.needsApproval || []).find((a) => a.kind === 'allow-builds') : null
      const review = job.status === 'review' && job.result
      return h('div', { className: 'dsh-autofit-job is-open' }, row,
        h('div', { className: 'dsh-autofit-dock-log', ref: logRef },
          lines.map((l, i) => h('div', { key: i, className: `dsh-autofit-dock-line${l.dim ? ' is-dim' : ''}${l.agent ? ' is-agent' : ''}` },
            h('span', { className: 'dsh-autofit-dock-icon' }, l.icon), h('span', null, l.text, l.detail ? h('span', { className: 'dsh-autofit-dock-detail' }, l.detail) : null))),
          busy ? h('div', { className: 'dsh-autofit-dock-line is-dim' }, h('span', { className: 'dsh-autofit-spinner', 'aria-hidden': 'true' }), h('span', null, statusText(t, job))) : null,
          review ? h(DiffView, { t, diff: job.result.diff }) : null),
        h('div', { className: 'dsh-autofit-dock-foot' },
          h('span', { style: { flex: 1 } }),
          job.status === 'queued' || job.status === 'running'
            ? h('button', { type: 'button', className: 'dsh-autofit-btn', onClick: () => void postJson(JOB.cancel, { id: job.id }).then((r) => r.ok && upsertJob(r.value, true)) }, t('dockCancel')) : null,
          approval ? h('button', { type: 'button', className: 'dsh-autofit-btn dsh-autofit-btn-primary', onClick: () => void startAutofitJob(job.spec, approval.packages, { expand: true }) }, t('dockApprove')) : null,
          review ? h('button', { type: 'button', className: 'dsh-autofit-btn', onClick: () => void postJson(JOB.cancel, { id: job.id }).then((r) => r.ok && upsertJob(r.value, true)) }, t('dockDecline')) : null,
          review ? h('button', { type: 'button', className: 'dsh-autofit-btn dsh-autofit-btn-primary', onClick: () => void installReady(job, true) }, t('dockInstallReviewed')) : null,
          !busy && !approval && !review && job.status !== 'installed' ? h('button', { type: 'button', className: 'dsh-autofit-btn', onClick: () => void startAutofitJob(job.spec, null, { expand: true }) }, t('dockRetry')) : null,
          !busy ? h('button', { type: 'button', className: 'dsh-autofit-btn', onClick: () => dismissJob(job.id) }, t('dockDismiss')) : null))
    }

    /* ------------------------------------------------------------------ plugin */

    return {
      inject: ['slots', 'locale', 'connection', 'remote'],
      apply(ctx) {
        pluginCtx = ctx
        // Optional dependency: a hard inject would keep the whole client inactive on hosts without a plugin
        // manager (DSH 0.1.5); a nested inject activates only when the namespace exists.
        ctx.inject(['remote.pluginManager'], (sub) => {
          pluginManagerRemote = sub.remote.pluginManager
          sub.effect(() => () => { pluginManagerRemote = null }, 'dsh-autofit: plugin manager remote')
        })
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

        const tt = ctx.locale.bind(LOCALE_NS)

        // The bundle's own page (Plugins → Autofit Installer): the only Plugins-page entry DSH 0.1.7–0.2.0 offer,
        // since plugins.tab and plugins.add.actions arrive in 0.2.1.
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-autofit', locale: LOCALE_NS },
            ({ t, view }) => (view === 'summary' ? null : h(AutofitTab, { t, ctx: pluginCtx }))),
        )

        ctx.slots.inject('plugins.tab', () =>
          ctx.slots.register({ name: 'plugins.tab', id: 'dsh-autofit', label: () => tt('tabLabel'), order: 200, locale: LOCALE_NS }, AutofitTab),
        )

        // DSH 0.1.5–0.2.0 have no Plugins-page tabs; their plugin UI lives under Settings → Plugins.
        ctx.slots.inject('settings.plugins.tab', () =>
          ctx.slots.register({ name: 'settings.plugins.tab', id: 'dsh-autofit', label: () => tt('tabLabel'), order: 200, locale: LOCALE_NS }, AutofitTab),
        )

        ctx.slots.inject('plugins.detail.badge', () =>
          ctx.slots.register({ name: 'plugins.detail.badge', id: 'dsh-autofit-badge', order: 100, locale: LOCALE_NS }, AutofitBadge),
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
