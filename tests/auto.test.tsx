// Modo automático (AC1), seletor de modelo (AC3), histórico (AC4), skill embutida (AC5) e trava de idioma no fluxo (AC6),
// com o mundo abaixo do plugin simulado: disco, sessão, caixa do prompt, loja e modelo.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const GOOD = '<prompt_pro>Objetivo: corrigir a acentuação apontada.\nPronto quando: a linha estiver corrigida e você mostrar o trecho.</prompt_pro>'
const BARE = '<prompt_pro>Objetivo: corrigir a funcao. Pronto quando: nao houver erro.</prompt_pro>'
const IMPROVED = 'Objetivo: corrigir a acentuação apontada.\nPronto quando: a linha estiver corrigida e você mostrar o trecho.'
const DRAFT = 'corrige aquele erro de acento que você achou'
const DRAFT_2 = 'arruma aquele arquivo que você citou'
const COMPOSER = { kind: 'composer' } as const
const RUN = { command: 'prompt-pro', origin: COMPOSER, presentation: { isFullscreen: true, columns: 120 } } as const
const PANE = { component: 'Pane', requestId: 'prompt-pro', viewport: { columns: 120, rows: 40 } } as const

type World = {
  replies: string[]
  calls: number
  models: { model: string; effort: string }[]
  system: string[]
  reads: string[]
  /** Caminhos de leitura que falham (a skill global ausente, por exemplo). */
  missing: (path: string) => boolean
  filled: string[]
  opened: number
  /** Prompts que chegaram ao fundo, isto é, que o mod deixou passar. */
  entered: string[]
  /** A loja do mod (`$.store`), lida e escrita pelos hooks abaixo. */
  store: Map<string, unknown>
  /** Faz `session.messages` rejeitar (falha depois do drop). */
  failMessages: boolean
}

const fresh = (replies: string[], missing: (path: string) => boolean = () => false): World => ({
  replies,
  calls: 0,
  models: [],
  system: [],
  reads: [],
  missing,
  filled: [],
  opened: 0,
  entered: [],
  store: new Map(),
  failMessages: false,
})

const world = (on: On, w: World, store: Record<string, unknown> = {}): void => {
  mock.env(on, { HOME: '/home/u' })
  for (const [k, v] of Object.entries(store)) w.store.set(k, v)
  on('store.get', async ($, e) => ({ value: w.store.get(e.key) }))
  on('store.set', async ($, e) => {
    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('fs.read', async ($, e) => {
    w.reads.push(e.path)
    if (w.missing(e.path)) throw new Error('ENOENT')
    return { value: e.path.includes('/skill/') ? 'REGRAS DO PACOTE' : 'REGRAS CONFIGURADAS' }
  })
  on('fs.exists', async () => ({ value: true }))
  on('session.root', async () => ({ value: '/repo' }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('session.messages', async () => {
    if (w.failMessages) throw new Error('falha de teste')
    return { value: [{ role: 'assistant' as const, text: 'linha 42 tem "funcao"', toolUses: [] }] }
  })
  on('prompt.read', async () => ({ value: { text: '', cursor: 0 } }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.open', async () => {
    w.opened += 1
    return { value: { isPlaced: true } }
  })
  on('ui.close', async () => ({ value: undefined }))
  on('command.run', async () => ({}))
  on('prompt.fill', async ($, e) => {
    w.filled.push(e.text)
    return { isFilled: true }
  })
  // o fundo do prompt.submit: o que chega aqui o mod deixou passar
  on('prompt.submit', async ($, e) => {
    w.entered.push(e.text)
    return { text: e.text }
  })
  on('model.complete', async ($, e) => {
    w.models.push({ model: e.model ?? '', effort: String(e.effort ?? '') })
    w.system.push(e.system ?? '')
    const text = w.replies[Math.min(w.calls, w.replies.length - 1)] ?? ''
    w.calls += 1
    return { value: { isAnswered: true as const, text, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
}

type Submit = { text: string; origin?: unknown; attachments?: unknown[] }
/** Enter na caixa: o engine carimba `composer`; o kit deixa passar o carimbo pelo cast. */
const enter = ($: { prompt: { submit: (i: never) => Promise<unknown> } }, input: Submit): Promise<unknown> =>
  $.prompt.submit({ origin: COMPOSER, wait: false, ...input } as never)
const dropped = (r: unknown): boolean => typeof r === 'object' && r !== null && 'drop' in r

// ---------------------------------------------------------------- AC1: modo automático

test('AC1: AUTO ligado segura o Enter, abre o painel e chama o modelo; nada é enviado', async ($, on) => {
  const w = fresh([GOOD])
  world(on, w, { auto: true })
  const clock = mock.clock(on)
  const r = await enter($, { text: DRAFT })
  expect(dropped(r)).toBe(true)
  expect(w.entered).toEqual([])
  await clock.advance(10)
  expect(w.opened).toBe(1)
  expect(w.calls).toBe(1)
  // a caixa ficou vazia depois do drop: o rascunho volta para ela
  expect(w.filled).toEqual([DRAFT])
  expect(w.entered).toEqual([])
})

test('AC1 falha depois do drop: o rascunho volta para a caixa', async ($, on) => {
  const w = fresh([GOOD])
  w.failMessages = true
  world(on, w, { auto: true })
  const clock = mock.clock(on)
  expect(dropped(await enter($, { text: DRAFT }))).toBe(true)
  await clock.advance(10)
  expect(w.opened).toBe(0)
  expect(w.calls).toBe(0)
  expect(w.filled).toEqual([DRAFT])
})

test('AC1: AUTO desligado (padrão) deixa o Enter passar e não chama o modelo', async ($, on) => {
  const w = fresh([GOOD])
  world(on, w)
  const clock = mock.clock(on)
  const r = await enter($, { text: DRAFT })
  expect(dropped(r)).toBe(false)
  await clock.advance(10)
  expect(w.entered).toEqual([DRAFT])
  expect(w.calls).toBe(0)
  expect(w.opened).toBe(0)
})

test('AC1: userConfig.auto liga o modo na primeira vez', { options: { auto: true } }, async ($, on) => {
  const w = fresh([GOOD])
  world(on, w)
  const clock = mock.clock(on)
  expect(dropped(await enter($, { text: DRAFT }))).toBe(true)
  await clock.advance(10)
  expect(w.calls).toBe(1)
})

test('AC1: passa intacto com AUTO ligado: comandos, triviais, anexos e o que não veio do Enter', async ($, on) => {
  const w = fresh([GOOD])
  world(on, w, { auto: true })
  const clock = mock.clock(on)
  for (const text of ['/status open', '!ls -la', '*help', '@dev corrige isso', 'Bom dia', 'qual versão do node está instalada aqui?']) {
    expect(dropped(await enter($, { text })), text).toBe(false)
  }
  expect(dropped(await enter($, { text: DRAFT, attachments: [{ type: 'image', id: 'a' }] }))).toBe(false)
  expect(dropped(await enter($, { text: DRAFT, origin: { kind: 'sdk' } }))).toBe(false)
  await clock.advance(10)
  expect(w.calls).toBe(0)
  expect(w.opened).toBe(0)
  expect(w.entered).toHaveLength(8)
})

test('AC1 laço: depois de Aplicar, o Enter seguinte envia sem segurar, uma vez só', async ($, on) => {
  const w = fresh([GOOD])
  world(on, w, { auto: true })
  const clock = mock.clock(on)
  await enter($, { text: DRAFT })
  await clock.advance(10)
  const ui = await $.ui.mount({ plugin: 'prompt-pro', surface: 'terminal', ...PANE, props: { bodyColumns: 120 } as never })
  await ui.press({ key: 'apply' })
  expect(w.filled.at(-1)).toBe(IMPROVED)
  // a pessoa aperta Enter no texto devolvido: passa
  expect(dropped(await enter($, { text: IMPROVED }))).toBe(false)
  expect(w.entered).toEqual([IMPROVED])
  // a passagem livre foi usada: o mesmo texto de novo é segurado
  expect(dropped(await enter($, { text: IMPROVED }))).toBe(true)
})

test('AC1 laço: depois de Manter original, o Enter seguinte envia sem segurar', async ($, on) => {
  const w = fresh([GOOD])
  world(on, w, { auto: true })
  const clock = mock.clock(on)
  await enter($, { text: DRAFT })
  await clock.advance(10)
  const ui = await $.ui.mount({ plugin: 'prompt-pro', surface: 'terminal', ...PANE, props: { bodyColumns: 120 } as never })
  await ui.press({ key: 'keep' })
  expect(w.filled.at(-1)).toBe(DRAFT)
  expect(dropped(await enter($, { text: DRAFT }))).toBe(false)
  expect(w.entered).toEqual([DRAFT])
  expect(dropped(await enter($, { text: DRAFT }))).toBe(true)
})

test('AC1 laço: outro texto, mesmo depois de Aplicar, continua sendo segurado', async ($, on) => {
  const w = fresh([GOOD])
  world(on, w, { auto: true })
  const clock = mock.clock(on)
  await enter($, { text: DRAFT })
  await clock.advance(10)
  const ui = await $.ui.mount({ plugin: 'prompt-pro', surface: 'terminal', ...PANE, props: { bodyColumns: 120 } as never })
  await ui.press({ key: 'apply' })
  expect(dropped(await enter($, { text: DRAFT_2 }))).toBe(true)
})

test('AC1: sem regras legíveis o prompt não é segurado', async ($, on) => {
  const w = fresh([GOOD], () => true)
  world(on, w, { auto: true })
  const clock = mock.clock(on)
  expect(dropped(await enter($, { text: DRAFT }))).toBe(false)
  await clock.advance(10)
  expect(w.entered).toEqual([DRAFT])
  expect(w.calls).toBe(0)
})

test('AC1: o cabeçalho do painel alterna o AUTO e a escolha fica guardada', async ($, on) => {
  const w = fresh([GOOD])
  world(on, w)
  const clock = mock.clock(on)
  await $.command.run({ ...RUN, args: DRAFT })
  await clock.advance(10)
  const ui = await $.ui.mount({ plugin: 'prompt-pro', surface: 'terminal', ...PANE, props: { bodyColumns: 120 } as never })
  expect((await ui.find({ key: 'auto' }))?.text).toBe('AUTO desligado')
  await ui.press({ key: 'auto' })
  expect((await ui.find({ key: 'auto' }))?.text).toBe('AUTO ligado')
  expect(w.store.get('auto')).toBe(true)
  await ui.press({ key: 'auto' })
  expect(w.store.get('auto')).toBe(false)
})

// ---------------------------------------------------------------- AC2 + AC7: quadros e PT-BR

test('AC2/AC7: quadros com contagem de caracteres e botões em português', async ($, on) => {
  const w = fresh([GOOD])
  world(on, w)
  const clock = mock.clock(on)
  await $.command.run({ ...RUN, args: DRAFT })
  await clock.advance(10)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'prompt-pro', surface, ...PANE, props: { bodyColumns: 120 } as never })
    expect(await ui.find({ type: 'Text', text: 'Guia Opus 5.5' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '· Revisão' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: `Prompt original · ${[...DRAFT].length} caracteres` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: `Prompt melhorado (v1/1) · ${[...IMPROVED].length} caracteres` })).toBeDefined()
    for (const [key, label] of [['apply', 'Aplicar'], ['redo', 'Refazer'], ['keep', 'Manter original']] as const) expect((await ui.find({ key }))?.text, label).toBe(label)
    await ui.unmount()
  }
})

// ---------------------------------------------------------------- AC3: modelo e esforço

test('AC3: mostra o modelo da sessão; a escolha de modelo e esforço vale no Refazer e é gravada', async ($, on) => {
  const w = fresh([GOOD])
  world(on, w)
  const clock = mock.clock(on)
  await $.command.run({ ...RUN, args: DRAFT })
  await clock.advance(10)
  expect(w.models[0]).toEqual({ model: 'claude-opus-5-5', effort: 'medium' })
  const ui = await $.ui.mount({ plugin: 'prompt-pro', surface: 'terminal', ...PANE, props: { bodyColumns: 120 } as never })
  expect(await ui.find({ type: 'Text', text: 'Sessão: claude-opus-5-5' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Polir com: claude-opus-5-5 (medium)' })).toBeDefined()
  await ui.press({ key: 'model' }) // sessão → opus
  await ui.press({ key: 'model' }) // opus → sonnet
  await ui.press({ key: 'effort' }) // medium → high
  await ui.press({ key: 'effort' }) // high → xhigh
  await ui.press({ key: 'effort' }) // xhigh → max
  await ui.press({ key: 'effort' }) // max → low
  expect(await ui.find({ type: 'Text', text: 'Polir com: sonnet (low)' })).toBeDefined()
  expect(w.store.get('prefs')).toEqual({ model: 'sonnet', effort: 'low' })
  await ui.press({ key: 'redo' })
  await clock.advance(10)
  expect(w.models[1]).toEqual({ model: 'sonnet', effort: 'low' })
})

test('AC3: a escolha guardada de um uso anterior vale no uso seguinte', async ($, on) => {
  const w = fresh([GOOD])
  world(on, w, { prefs: { model: 'haiku', effort: 'high' } })
  const clock = mock.clock(on)
  await $.command.run({ ...RUN, args: DRAFT })
  await clock.advance(10)
  expect(w.models[0]).toEqual({ model: 'haiku', effort: 'high' })
  const ui = await $.ui.mount({ plugin: 'prompt-pro', surface: 'terminal', ...PANE, props: { bodyColumns: 120 } as never })
  expect(await ui.find({ type: 'Text', text: 'Polir com: haiku (high)' })).toBeDefined()
})

test('AC3: valor inválido na loja volta ao padrão da configuração', { options: { model: 'opus', effort: 'low' } }, async ($, on) => {
  const w = fresh([GOOD])
  world(on, w, { prefs: { model: 7, effort: 'turbo' }, auto: 'sim' })
  const clock = mock.clock(on)
  await $.command.run({ ...RUN, args: DRAFT })
  await clock.advance(10)
  expect(w.models[0]).toEqual({ model: 'opus', effort: 'low' })
  expect(dropped(await enter($, { text: DRAFT_2 }))).toBe(false)
})

// ---------------------------------------------------------------- AC4: histórico

test('AC4: o histórico cresce a cada polimento e se navega no painel', async ($, on) => {
  const w = fresh([GOOD])
  world(on, w)
  const clock = mock.clock(on)
  await $.command.run({ ...RUN, args: DRAFT })
  await clock.advance(10)
  await $.command.run({ ...RUN, args: DRAFT_2 })
  await clock.advance(10)
  const ui = await $.ui.mount({ plugin: 'prompt-pro', surface: 'terminal', ...PANE, props: { bodyColumns: 120 } as never })
  expect(await ui.find({ type: 'Text', text: 'Histórico da sessão (2)' })).toBeDefined()
  const line = (n: number): RegExp => new RegExp(`^[ ›] \\d\\d:\\d\\d · claude-opus-5-5 \\(medium\\) · ${n} → ${[...IMPROVED].length} caracteres$`)
  expect(await ui.find({ type: 'Text', text: line([...DRAFT].length) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: line([...DRAFT_2].length) })).toBeDefined()
  // navegar: ‹ mostra o último, ‹ de novo o anterior; o painel passa a exibir o texto dele
  await ui.press({ key: 'hist-prev' })
  expect((await ui.find({ type: 'Text', text: /^› / }))?.text).toMatch(new RegExp(`${[...DRAFT_2].length} → `))
  await ui.press({ key: 'hist-prev' })
  expect((await ui.find({ type: 'Text', text: /^› / }))?.text).toMatch(new RegExp(`${[...DRAFT].length} → `))
  expect(await ui.find({ type: 'Text', text: DRAFT })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '· Histórico' })).toBeDefined()
  // Manter, vendo o histórico, devolve o original daquele polimento
  await ui.press({ key: 'keep' })
  expect(w.filled.at(-1)).toBe(DRAFT)
})

test('AC4: voltar ao atual e o histórico sobrevivem ao fechar o painel', async ($, on) => {
  const w = fresh([GOOD])
  world(on, w)
  const clock = mock.clock(on)
  await $.command.run({ ...RUN, args: DRAFT })
  await clock.advance(10)
  const ui = await $.ui.mount({ plugin: 'prompt-pro', surface: 'terminal', ...PANE, props: { bodyColumns: 120 } as never })
  await ui.press({ key: 'hist-prev' })
  await ui.press({ key: 'hist-back' })
  expect(await ui.find({ type: 'Text', text: '· Revisão' })).toBeDefined()
  await ui.press({ key: 'keep' }) // fecha o painel
  await ui.unmount()
  await $.command.run({ ...RUN, args: DRAFT_2 })
  await clock.advance(10)
  const again = await $.ui.mount({ plugin: 'prompt-pro', surface: 'terminal', ...PANE, props: { bodyColumns: 120 } as never })
  expect(await again.find({ type: 'Text', text: 'Histórico da sessão (2)' })).toBeDefined()
})

// ---------------------------------------------------------------- AC5: skill embutida

test('AC5: sem a skill global, as regras vêm do pacote (skill/)', async ($, on) => {
  const w = fresh([GOOD], path => path.includes('/.claude/skills/'))
  world(on, w)
  const clock = mock.clock(on)
  await $.command.run({ ...RUN, args: DRAFT })
  await clock.advance(10)
  expect(w.calls).toBe(1)
  expect(w.system[0]).toContain('REGRAS DO PACOTE')
  expect(w.reads.some(p => p.endsWith('/skill/SKILL.md'))).toBe(true)
  expect(w.reads.some(p => p.endsWith('/skill/references/canonical-blocks.md'))).toBe(true)
  expect(w.reads.some(p => p.includes('/.claude/skills/'))).toBe(false)
})

test('AC5: rulesDir configurada substitui a embutida', { options: { rulesDir: '~/minhas-regras' } }, async ($, on) => {
  const w = fresh([GOOD])
  world(on, w)
  const clock = mock.clock(on)
  await $.command.run({ ...RUN, args: DRAFT })
  await clock.advance(10)
  expect(w.system[0]).toContain('REGRAS CONFIGURADAS')
  expect(w.reads).toContain('/home/u/minhas-regras/SKILL.md')
  expect(w.reads.some(p => p.includes('/skill/'))).toBe(false)
})

test('AC5: rulesDir configurada que não existe falha fechado, sem cair em regra nenhuma', { options: { rulesDir: '/nao/existe' } }, async ($, on) => {
  const w = fresh([GOOD], path => path.startsWith('/nao/existe'))
  world(on, w)
  const clock = mock.clock(on)
  await $.command.run({ ...RUN, args: DRAFT })
  await clock.advance(10)
  expect(w.calls).toBe(0)
  expect(w.filled).toEqual([DRAFT])
})

// ---------------------------------------------------------------- AC6: idioma no fluxo automático

test('AC6: no modo automático, sem acento duas vezes = Aplicar bloqueado e 1 nova tentativa', async ($, on) => {
  const w = fresh([BARE, BARE])
  world(on, w, { auto: true })
  const clock = mock.clock(on)
  await enter($, { text: 'corrige aquele erro de acento que voce achou' })
  await clock.advance(10)
  expect(w.calls).toBe(2)
  const ui = await $.ui.mount({ plugin: 'prompt-pro', surface: 'terminal', ...PANE, props: { bodyColumns: 120 } as never })
  expect(await ui.find({ key: 'apply' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Aplicar bloqueado nesta versão.' })).toBeDefined()
  expect(await ui.find({ key: 'keep' })).toBeDefined()
})
