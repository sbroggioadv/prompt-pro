// Uma rodada de melhoria, com o mundo injetado (modelo, disco, relógio): testável sem o engine.
import type { PromptProJob, PromptProVersion } from '../types'
import { appendDoubts, buildRequest, extractPaths, planFor, resolvePath, validateOutput } from './core'
import type { Request, Rules, Validation } from './core'

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

export type CompleteResult =
  | { isAnswered: true; text: string; usage: Usage }
  | { isAnswered: false; reason: 'api-error' | 'empty-reply' | 'aborted'; status?: number | null; error?: string; usage: Usage }

export type FlowDeps = {
  complete: (req: Request) => Promise<CompleteResult>
  exists: (absolutePath: string) => Promise<boolean>
  now: () => Promise<number>
  /** Falso quando a execução foi cancelada ou substituída: o fluxo para sem publicar nada. */
  isCurrent?: () => boolean
}

export type FlowSettings = { model: string; effort: string; nonce: string; home: string }

export type FlowOutcome =
  | { ok: true; version: PromptProVersion }
  | { ok: false; message: string; aborted: boolean }

export const ATTEMPTS = 2

const failure = (r: Extract<CompleteResult, { isAnswered: false }>): string => {
  if (r.reason === 'aborted') return 'Chamada cancelada ou sem resposta dentro do prazo.'
  if (r.reason === 'empty-reply') return 'O modelo respondeu sem texto.'
  return `Erro da API${r.status != null ? ` (${r.status})` : ''}${r.error ? `: ${r.error}` : ''}.`
}

const STALE: FlowOutcome = { ok: false, message: 'Execução substituída ou cancelada.', aborted: true }

/**
 * Pede a melhoria e valida os bloqueios em código (envelope, corpo, log de conversão, idioma).
 * Problema na saída → 1 nova tentativa com os motivos; persistindo, a versão aparece com os avisos e
 * Aplicar bloqueado. Caminho inexistente vira dúvida (sem bloquear).
 */
export const runImprove = async (deps: FlowDeps, rules: Rules, job: PromptProJob, s: FlowSettings): Promise<FlowOutcome> => {
  const isCurrent = deps.isCurrent ?? (() => true)
  const started = await deps.now()
  const plan = planFor(job.draft)
  const source = [job.draft, job.context.lastAssistant, job.context.lastUser].join('\n')
  const usage = { input: 0, output: 0, cacheRead: 0 }
  let reasons: string[] = []
  let v: Validation | undefined

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const req = buildRequest({ rules, draft: job.draft, context: job.context, lang: job.lang, nonce: s.nonce, plan, retryReasons: reasons })
    const r = await deps.complete(req)
    if (!isCurrent()) return STALE
    usage.input += r.usage.input_tokens
    usage.output += r.usage.output_tokens
    usage.cacheRead += r.usage.cache_read_input_tokens ?? 0
    if (!r.isAnswered) return { ok: false, message: failure(r), aborted: r.reason === 'aborted' }
    v = validateOutput({ text: r.text, lang: job.lang, source })
    if (v.problems.length === 0) break
    reasons = v.problems
  }
  if (v === undefined) return { ok: false, message: 'Sem resposta do modelo.', aborted: false }

  const warnings: string[] = []
  const canApply = v.problems.length === 0
  if (v.problems.some(x => x.startsWith('idioma:'))) warnings.push('Idioma divergente.')
  if (!canApply) warnings.push(`A saída não cumpriu o contrato depois de ${ATTEMPTS} tentativas: ${v.problems.join('; ')}. Aplicar bloqueado; use Refazer ou Manter.`)

  const missing: string[] = []
  for (const p of extractPaths(v.body)) {
    const isThere = await deps.exists(resolvePath(p, job.context.root, s.home)).catch(() => false)
    if (!isCurrent()) return STALE
    if (!isThere) missing.push(p)
  }
  if (missing.length > 0) warnings.push(`${missing.length} caminho(s) não encontrado(s) em disco: foram para as dúvidas.`)

  const ended = await deps.now()
  if (!isCurrent()) return STALE
  return {
    ok: true,
    version: {
      text: appendDoubts(v.body, missing),
      warnings,
      canApply,
      model: s.model,
      effort: s.effort,
      ms: ended - started,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      rulesSha: rules.sha,
    },
  }
}
