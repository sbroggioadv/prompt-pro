// Camada fina: comando, modo automático, painel e chamadas ao engine. A lógica está em core.ts, flow.ts e rules.ts.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PromptProHistoryEntry, PromptProJob, PromptProPanel, PromptProVersion } from '../types'
import {
  EFFORT_LEVELS,
  HISTORY_MAX,
  MAX_VERSIONS,
  buildContext,
  classifyDraft,
  countChars,
  cycle,
  detectLanguage,
  historyLine,
  modelChoices,
  modelLabel,
  nonceFrom,
  parseAuto,
  parseConfig,
  parsePrefs,
  resolvePath,
  shortSha,
  shouldHold,
} from './core'
import type { Config, Effort } from './core'
import { runImprove } from './flow'
import type { FlowOutcome } from './flow'
import { EMBEDDED_ORIGIN, loadRules, rulesDirectory } from './rules'
import type { RulesResult } from './rules'

const PANE = 'prompt-pro'
const TITLE = 'Prompt profissional'
const REFERENCE = 'Guia Opus 5.5'
const TIMEOUT_MS = 90_000
const MAX_TOKENS = 8_000
const WIDE_AT = 100
const HOLD_REASON = 'prompt-pro: prompt segurado para ser melhorado. Escolha Aplicar, Refazer ou Manter original no painel.'

const IDLE: PromptProPanel = {
  status: 'idle',
  original: '',
  versions: [],
  index: 0,
  message: '',
  job: null,
  ready: false,
  auto: false,
  model: '',
  effort: 'medium',
  sessionModel: '',
  history: [],
  viewing: null,
}
const panel = atom({ plugin: 'prompt-pro', key: 'panel' } as const, IDLE)

/** Zera o painel e guarda o que vale a sessão inteira: preferências, modelo detectado e histórico. */
const cleared = (p: PromptProPanel): PromptProPanel => ({
  ...IDLE,
  ready: p.ready,
  auto: p.auto,
  model: p.model,
  effort: p.effort,
  sessionModel: p.sessionModel,
  history: p.history,
})

/** Uma execução: id próprio e o AbortController que o Cancelar dispara. */
type Run = { id: number; controller: AbortController }

/** A execução vigente; qualquer outra que termine depois não publica nada (#3). Some num reload. */
let current: Run | undefined
let nextId = 1
/** Geração do pedido: muda a cada invalidação; um pedido em preparação confere a sua antes de seguir (#2). */
let generation = 0
/**
 * Textos que o painel devolveu à caixa (Aplicar ou Manter): o Enter seguinte de cada um envia sem segurar de
 * novo, uma vez. Sem isso o Enter reabriria o painel para sempre. Some num reload (então segura mais uma vez).
 */
const released = new Set<string>()

const isLive = (run: Run): boolean => current?.id === run.id && !run.controller.signal.aborted

/** Invalida a execução em curso: Cancelar, fechar o painel, Aplicar, Manter ou novo pedido. */
const invalidate = (): number => {
  current?.controller.abort()
  current = undefined
  generation += 1
  return generation
}

const homeOf = async ($: EngineInterface): Promise<string> => (await $.env.get('HOME')) ?? ''

/** Preferências: o que a pessoa escolheu antes (`$.store`) ou, na primeira vez, a configuração do mod. */
const ensureSettings = async ($: EngineInterface, cfg: Config): Promise<PromptProPanel> => {
  const now = await read($, panel)
  if (now.ready) return now
  const prefs = parsePrefs(await $.store.get('prefs'), { model: cfg.model, effort: cfg.effort })
  const auto = parseAuto(await $.store.get('auto'), cfg.auto)
  const sessionModel = String((await $.session.model()) ?? '')
  await update($, panel, (p): PromptProPanel => (p.ready ? p : { ...p, ready: true, auto, model: prefs.model, effort: prefs.effort, sessionModel }))
  return read($, panel)
}

/** As regras de escrita: a skill embutida no pacote, ou a pasta configurada no lugar dela. */
const readRules = async ($: EngineInterface, cfg: Config): Promise<RulesResult> => {
  const configured = cfg.rulesDir !== '' ? resolvePath(cfg.rulesDir, await $.session.root(), await homeOf($)) : ''
  return loadRules(
    path => $.fs.read(path),
    async text => shortSha(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
    rulesDirectory(configured, $.plugin.root),
    configured !== '' ? configured : EMBEDDED_ORIGIN,
  )
}

const newNonce = (): string => nonceFrom(crypto.getRandomValues(new Uint8Array(8)))

/** Grava no painel só se a execução ainda for a vigente. */
const publish = async ($: EngineInterface, run: Run, change: (p: PromptProPanel) => PromptProPanel): Promise<void> => {
  if (!isLive(run)) return
  await update($, panel, (p): PromptProPanel => (isLive(run) ? change(p) : p))
}

/** Roda uma melhoria e grava o resultado no painel. Nunca envia nada. */
const execute = async ($: EngineInterface, cfg: Config, job: PromptProJob, run: Run, model: string, effort: Effort): Promise<void> => {
  const rules = await readRules($, cfg)
  if ('missing' in rules) {
    await publish($, run, p => ({ ...p, status: p.versions.length > 0 ? 'ready' : 'error', message: `Regras não encontradas: ${rules.missing}. Nada foi melhorado.` }))
    return
  }
  let outcome: FlowOutcome
  try {
    outcome = await runImprove(
      {
        complete: req =>
          $.model.complete({ model, system: req.system, prompt: req.prompt, maxTokens: MAX_TOKENS, effort, timeoutMs: TIMEOUT_MS }, { signal: run.controller.signal }),
        exists: path => $.fs.exists(path),
        now: () => $.clock.now(),
        isCurrent: () => isLive(run),
      },
      rules,
      job,
      { model, effort, nonce: newNonce(), home: await homeOf($) },
    )
  } catch (err) {
    // só um pedido que o engine se recusa a mandar rejeita (modelo bloqueado, teto inválido)
    outcome = { ok: false, message: `O engine recusou o pedido: ${err instanceof Error ? err.message : String(err)}`, aborted: false }
  }
  const result = outcome
  const at = await $.clock.now()
  await publish($, run, p => {
    if (!result.ok) return { ...p, status: p.versions.length > 0 ? 'ready' : 'error', message: result.message }
    const versions = [...p.versions, result.version].slice(-MAX_VERSIONS)
    const entry: PromptProHistoryEntry = {
      at,
      model,
      effort,
      original: job.draft,
      improved: result.version.text,
      canApply: result.version.canApply,
    }
    return { ...p, status: 'ready', versions, index: versions.length - 1, message: '', viewing: null, history: [...p.history, entry].slice(-HISTORY_MAX) }
  })
  if (current?.id === run.id) current = undefined
}

/** Dispara a melhoria fora do despacho do comando ou do botão (timer próprio), com o modelo e o esforço escolhidos. */
const start = async ($: EngineInterface, cfg: Config, job: PromptProJob): Promise<Run> => {
  invalidate()
  const run: Run = { id: nextId++, controller: new AbortController() }
  current = run
  const sessionModel = String((await $.session.model()) ?? '')
  const chosen = await read($, panel)
  const model = chosen.model !== '' ? chosen.model : sessionModel
  const effort = EFFORT_LEVELS.find(x => x === chosen.effort) ?? 'medium'
  await update($, panel, (p): PromptProPanel => ({ ...p, status: 'loading', original: job.draft, job, message: '', viewing: null, sessionModel }))
  $.clock.after(1, () => {
    void execute($, cfg, job, run, model, effort).catch(async (err: unknown) => {
      await publish($, run, p => ({ ...p, status: 'error', message: `Falha inesperada: ${err instanceof Error ? err.message : String(err)}` }))
    })
  })
  return run
}

const closePanel = async ($: EngineInterface): Promise<void> => {
  invalidate()
  await update($, panel, cleared)
  await $.ui.close({ id: PANE }).catch(() => undefined)
}

/** Põe o texto na caixa do prompt; o Enter continua sendo da pessoa. Nunca chama envio. */
const fillBox = async ($: EngineInterface, text: string): Promise<boolean> => {
  const r = await $.prompt.fill({ text, mode: 'replace' })
  if (!r.isFilled) {
    const why = r.refusal === 'dialog' ? 'um diálogo está aberto' : r.refusal === 'no_composer' ? 'não há caixa de prompt' : 'motivo desconhecido'
    $.ui.toast(`prompt-pro: a caixa do prompt não aceitou o texto (${why}).`)
  }
  return r.isFilled
}

/** Devolve o texto à caixa e libera o próximo Enter dele; só então o painel fecha. */
const giveBack = async ($: EngineInterface, text: string): Promise<void> => {
  if (!(await fillBox($, text))) return
  released.add(text.trim())
  await closePanel($)
}

/**
 * Lê o contexto, cria o pedido, dispara a melhoria e abre o painel. `restore`: no modo automático o Enter
 * levou o texto da caixa; se ela estiver vazia depois de abrir o painel, o rascunho volta para lá.
 */
const launch = async ($: EngineInterface, cfg: Config, draft: string, mine: number, restore: boolean): Promise<void> => {
  const stale = (): boolean => generation !== mine
  const messages = await $.session.messages()
  const root = await $.session.root()
  if (stale()) return
  const job: PromptProJob = { draft, context: buildContext(Array.isArray(messages) ? messages : [], root), lang: detectLanguage(draft) }
  released.clear()
  await update($, panel, (p): PromptProPanel => ({ ...cleared(p), original: draft }))
  if (stale()) return
  const run = await start($, cfg, job)
  const started = generation
  if (!isLive(run)) return
  await $.ui.open({ id: PANE, title: TITLE })
  if (restore && generation === started) {
    const box = await $.prompt.read()
    if (box.text.trim() === '' && generation === started) await fillBox($, draft)
  }
}

const metaLine = (v: PromptProVersion, i: number, n: number): string =>
  `v${i + 1}/${n} · ${v.model} · esforço ${v.effort} · ${(v.ms / 1000).toFixed(1)} s · ` +
  `${v.inputTokens} entrada / ${v.outputTokens} saída / ${v.cacheReadTokens} do cache · regras ${v.rulesSha}`

export const register: Register = (on, options) => {
  const cfg = parseConfig(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'prompt-pro',
      description: 'Melhora um rascunho de prompt com a skill do Opus 5.5 (painel; nunca envia sozinho)',
      argumentHint: '<rascunho>',
    })
    return next(e)
  })

  // a pessoa fechou o painel: a execução em curso não publica mais nada
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      invalidate()
      await update($, panel, cleared)
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // nunca impede a pessoa de fechar o painel

  // Modo automático: o Enter de um prompt que o D7 manda melhorar fica retido e abre o painel. Falhar aqui
  // deixa o prompt passar (o engine ignora hook quebrado): melhorar é conveniência, nunca trava o envio.
  on('prompt.submit', async ($, e, next) => {
    const state = await ensureSettings($, cfg)
    const free = e.origin.kind === 'composer' && released.delete(e.text.trim())
    if (free || !state.auto || !shouldHold(e, released)) return next(e)
    const rules = await readRules($, cfg)
    if ('missing' in rules) {
      $.ui.toast(`prompt-pro: regras não encontradas em ${rules.missing}. O prompt foi enviado sem melhoria.`)
      return next(e)
    }
    const mine = invalidate()
    const draft = e.text.trim()
    $.clock.after(1, () => {
      // se abrir o painel falhar depois do drop, o rascunho volta à caixa: nada se perde em silêncio
      void launch($, cfg, draft, mine, true).catch(async () => {
        $.ui.toast('prompt-pro: não foi possível abrir o painel. O rascunho voltou para a caixa.')
        await fillBox($, draft).catch(() => false)
      })
    })
    return { drop: HOLD_REASON }
  }).catch(($, e, next) => next(e)) // fail-open: se este hook falhar, o prompt segue

  on('command.run', { command: 'prompt-pro' }, async ($, e) => {
    // todo pedido novo substitui o anterior antes de qualquer retorno antecipado; a geração é
    // reservada antes do primeiro await e conferida depois de cada leitura assíncrona (#2)
    const mine = invalidate()
    const stale = (): boolean => generation !== mine
    await ensureSettings($, cfg)
    await update($, panel, cleared)
    // sem texto: tenta a caixa do prompt; após um comando ela costuma estar vazia
    const draft = e.args.trim() !== '' ? e.args.trim() : (await $.prompt.read()).text.trim()
    if (stale()) return {}
    const kind = classifyDraft(draft)
    if (kind === 'empty') {
      // painel ocioso: é por ele que se liga o modo automático e se escolhe o modelo
      await $.ui.open({ id: PANE, title: TITLE })
      return {}
    }
    if (kind === 'command') {
      await fillBox($, draft)
      $.ui.toast('prompt-pro: comandos passam intactos. O texto voltou para a caixa.')
      return {}
    }
    if (kind === 'clear') {
      await fillBox($, draft)
      $.ui.toast('prompt-pro: mantido, a pergunta já está clara. Ela voltou para a caixa.')
      return {}
    }
    const rules = await readRules($, cfg)
    if (stale()) return {}
    if ('missing' in rules) {
      await fillBox($, draft)
      $.ui.toast(`prompt-pro: regras não encontradas em ${rules.missing}. Nada foi melhorado; o rascunho voltou para a caixa.`)
      return {}
    }
    await launch($, cfg, draft, mine, false)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const p = await ensureSettings($, cfg)
    const columns = e.props.bodyColumns ?? 80
    const wide = columns >= WIDE_AT
    const half = Math.max(20, Math.floor((columns - 2) / 2))
    const v: PromptProVersion | undefined = p.versions[p.index]
    const past: PromptProHistoryEntry | undefined = p.viewing !== null ? p.history[p.viewing] : undefined
    const isLoading = p.status === 'loading'

    const shownOriginal = past ? past.original : p.original
    const shownText = past ? past.improved : v?.text
    const canApply = past ? past.canApply : v?.canApply === true

    const apply = async (): Promise<void> => {
      const now = await read($, panel)
      const old = now.viewing !== null ? now.history[now.viewing] : undefined
      const cur = now.versions[now.index]
      if (old) {
        if (old.canApply) await giveBack($, old.improved)
        return
      }
      if (now.status === 'loading' || cur === undefined || !cur.canApply) return
      await giveBack($, cur.text)
    }
    const keep = async (): Promise<void> => {
      const now = await read($, panel)
      const old = now.viewing !== null ? now.history[now.viewing] : undefined
      await giveBack($, old ? old.original : now.original)
    }
    const redo = async (): Promise<void> => {
      const job = (await read($, panel)).job
      if (job === null) {
        $.ui.toast('prompt-pro: o pedido original se perdeu num reload; rode /prompt-pro de novo.')
        return
      }
      await start($, cfg, job)
    }
    const cancel = async (): Promise<void> => {
      invalidate()
      await update($, panel, (cur): PromptProPanel => ({ ...cur, status: cur.versions.length > 0 ? 'ready' : 'idle', message: 'Cancelado.' }))
    }
    const go = (delta: number) => async (): Promise<void> => {
      await update($, panel, (cur): PromptProPanel => ({ ...cur, index: Math.min(cur.versions.length - 1, Math.max(0, cur.index + delta)) }))
    }
    const toggleAuto = async (): Promise<void> => {
      const auto = !(await read($, panel)).auto
      await $.store.set('auto', auto)
      await update($, panel, (cur): PromptProPanel => ({ ...cur, auto }))
    }
    const choose = (field: 'model' | 'effort') => async (): Promise<void> => {
      const cur = await read($, panel)
      const model = field === 'model' ? cycle(modelChoices(cfg.model), cur.model) : cur.model
      const effort = field === 'effort' ? cycle(EFFORT_LEVELS, parsePrefs({ effort: cur.effort }, { model, effort: 'medium' }).effort) : cur.effort
      await $.store.set('prefs', { model, effort })
      await update($, panel, (c): PromptProPanel => ({ ...c, model, effort }))
    }
    const browse = (delta: -1 | 1) => async (): Promise<void> => {
      await update($, panel, (cur): PromptProPanel => {
        const last = cur.history.length - 1
        if (last < 0) return cur
        if (cur.viewing === null) return delta < 0 ? { ...cur, viewing: last } : cur
        const to = cur.viewing + delta
        return { ...cur, viewing: to < 0 ? 0 : to > last ? null : to }
      })
    }
    const back = async (): Promise<void> => {
      await update($, panel, (cur): PromptProPanel => ({ ...cur, viewing: null }))
    }

    const state = past
      ? 'Histórico'
      : isLoading
        ? 'Melhorando…'
        : p.status === 'error'
          ? 'Erro'
          : p.versions.length > 0
            ? 'Revisão'
            : 'Pronto'
    const hint = past
      ? 'Você está vendo um polimento anterior. Aplicar ou Manter devolvem o texto dele à caixa; nada é enviado sozinho.'
      : isLoading
        ? 'Melhorando o rascunho…'
        : p.status === 'error'
          ? 'Não foi possível melhorar.'
          : p.status === 'idle' && p.versions.length === 0
            ? 'Nada em curso. Use /prompt-pro <rascunho>, ou ligue o modo automático.'
            : 'Revise e escolha: Aplicar põe o texto na caixa do prompt; nada é enviado sozinho.'

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold>{REFERENCE}</Text>
          <Text dimColor>{`· ${state}`}</Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button key="auto" variant={p.auto ? 'primary' : undefined} hotkey="t" label={p.auto ? 'AUTO ligado' : 'AUTO desligado'} onPress={() => void toggleAuto()} />
          <Text dimColor>{`Sessão: ${p.sessionModel !== '' ? p.sessionModel : '(desconhecido)'}`}</Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          <Text>{`Polir com: ${modelLabel({ model: p.model, effort: parsePrefs({ effort: p.effort }, { model: '', effort: 'medium' }).effort }, p.sessionModel)}`}</Text>
          <Button key="model" plain label="modelo ›" onPress={() => void choose('model')()} />
          <Button key="effort" plain label="esforço ›" onPress={() => void choose('effort')()} />
        </Box>
        <Text dimColor>{hint}</Text>
        {p.message !== '' && <Text color="warning">{p.message}</Text>}
        <Box flexDirection={wide ? 'row' : 'column'} marginTop={1}>
          <Box key="col-original" flexDirection="column" width={wide ? half : undefined} borderStyle="round" paddingX={1}>
            <Text bold>{`Prompt original · ${countChars(shownOriginal)} caracteres`}</Text>
            <Text>{shownOriginal || '(vazio)'}</Text>
          </Box>
          <Box key="col-improved" flexDirection="column" width={wide ? half : undefined} borderStyle="round" paddingX={1}>
            <Text bold>
              {shownText !== undefined
                ? `Prompt melhorado${past ? '' : ` (v${p.index + 1}/${p.versions.length})`} · ${countChars(shownText)} caracteres`
                : 'Prompt melhorado'}
            </Text>
            <Text>{shownText !== undefined ? shownText : isLoading ? '…' : '(ainda não há versão)'}</Text>
          </Box>
        </Box>
        {!past && v?.warnings.map(w => <Text color="warning">{`! ${w}`}</Text>)}
        {!past && v && <Text dimColor>{metaLine(v, p.index, p.versions.length)}</Text>}
        {shownText !== undefined && !canApply && <Text color="error">Aplicar bloqueado nesta versão.</Text>}
        <Box flexDirection="row" gap={1} marginTop={1}>
          {shownText !== undefined && canApply && !isLoading && <Button key="apply" variant="primary" hotkey="a" label="Aplicar" onPress={() => void apply()} />}
          {!past && p.job !== null && !isLoading && <Button key="redo" hotkey="r" label="Refazer" onPress={() => void redo()} />}
          {!isLoading && <Button key="keep" hotkey="m" label="Manter original" onPress={() => void keep()} />}
          {isLoading && <Button key="cancel" hotkey="c" label="Cancelar" onPress={() => void cancel()} />}
          {!past && p.versions.length > 1 && <Button key="prev" plain label="‹ versão" onPress={() => void go(-1)()} />}
          {!past && p.versions.length > 1 && <Button key="next" plain label="versão ›" onPress={() => void go(1)()} />}
        </Box>
        {p.history.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="row" gap={1}>
              <Text bold>{`Histórico da sessão (${p.history.length})`}</Text>
              <Button key="hist-prev" plain label="‹ anterior" onPress={() => void browse(-1)()} />
              <Button key="hist-next" plain label="próximo ›" onPress={() => void browse(1)()} />
              {past && <Button key="hist-back" plain label="voltar ao atual" onPress={() => void back()} />}
            </Box>
            {p.history.map((item, i) => (
              <Text key={`h${i}`} dimColor={p.viewing !== i}>{`${p.viewing === i ? '›' : ' '} ${historyLine(item)}`}</Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
