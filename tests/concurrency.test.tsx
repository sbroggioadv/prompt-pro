// #3 / #11: Cancelar, respostas fora de ordem, Refazer concorrente, painel fechado e espião de envio,
// com o modelo respondendo por promessas que o teste resolve quando quer.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const RUN = { command: 'prompt-pro', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const
const PANE = { component: 'Pane', requestId: 'prompt-pro', viewport: { columns: 120, rows: 40 } } as const
const out = (tag: string) => `<prompt_pro>Objetivo: corrigir o acento ${tag}.\nPronto quando: a linha estiver corrigida.</prompt_pro>`

type Pending = { resolve: (text: string) => void }
type World = { pending: Pending[]; filled: string[]; submitted: string[]; holdReads: boolean; heldReads: (() => void)[]; hold: Set<string>; held: (() => void)[]; box: string }

const world = (on: On): World => {
  const w: World = { pending: [], filled: [], submitted: [], holdReads: false, heldReads: [], hold: new Set(), held: [], box: '' }
  mock.env(on, { HOME: '/home/u' })
  mock.store(on)
  on('fs.read', async ($, e) => {
    const answer = { value: e.path.includes('/skill/') ? 'REGRAS' : '' }
    if (!w.holdReads) return answer
    return new Promise(resolve => w.heldReads.push(() => resolve(answer)))
  })
  on('fs.exists', async () => ({ value: true }))
  on('session.root', async () => ({ value: '/repo' }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  /** Responde já, ou segura a resposta até o teste soltar (w.hold tem o nome do evento). */
  const later = <T,>(name: string, answer: T): Promise<T> | T =>
    w.hold.has(name) ? new Promise<T>(resolve => w.held.push(() => resolve(answer))) : answer
  on('session.messages', async () => later('session.messages', { value: [] }))
  on('prompt.read', async () => later('prompt.read', { value: { text: w.box, cursor: 0 } }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.close', async () => ({ value: undefined }))
  on('command.run', async () => ({}))
  on('prompt.fill', async ($, e) => {
    w.filled.push(e.text)
    return { isFilled: true }
  })
  // espião explícito: nada pode ser enviado pelo mod
  on('prompt.submit', async ($, e) => {
    w.submitted.push(e.text)
    return { drop: 'teste' }
  })
  on('model.complete', () =>
    new Promise(resolve => {
      w.pending.push({
        resolve: text =>
          resolve({ value: { isAnswered: true as const, text, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
      })
    }),
  )
  return w
}

test('Cancelar durante a chamada: a resposta que chega depois não aparece', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await $.command.run({ ...RUN, args: 'corrige aquele erro de acento que você achou' })
  await clock.advance(10)
  expect(w.pending).toHaveLength(1)
  const ui = await $.ui.mount({ plugin: 'prompt-pro', surface: 'terminal', ...PANE, props: { bodyColumns: 120 } as never })
  await ui.press({ key: 'cancel' })
  w.pending[0]?.resolve(out('A'))
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: 'Objetivo: corrigir o acento A' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Cancelado.' })).toBeDefined()
  expect(await ui.find({ key: 'apply' })).toBeUndefined()
})

test('respostas fora de ordem: a do pedido antigo não sobrescreve a do novo', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await $.command.run({ ...RUN, args: 'corrige aquele erro de acento A' })
  await clock.advance(10)
  await $.command.run({ ...RUN, args: 'corrige aquele erro de acento B' })
  await clock.advance(10)
  expect(w.pending).toHaveLength(2)
  w.pending[1]?.resolve(out('B'))
  await clock.settle()
  w.pending[0]?.resolve(out('A'))
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'prompt-pro', surface: 'terminal', ...PANE, props: { bodyColumns: 120 } as never })
  expect(await ui.find({ type: 'Text', text: 'Objetivo: corrigir o acento B' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Objetivo: corrigir o acento A' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Prompt melhorado \(v1\/1\) · \d+ caracteres$/ })).toBeDefined()
})

test('Refazer em curso e pedido novo: só o pedido novo publica', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await $.command.run({ ...RUN, args: 'corrige aquele erro de acento A' })
  await clock.advance(10)
  w.pending[0]?.resolve(out('A1'))
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'prompt-pro', surface: 'terminal', ...PANE, props: { bodyColumns: 120 } as never })
  await ui.press({ key: 'redo' })
  await clock.advance(10)
  expect(w.pending).toHaveLength(2)
  await $.command.run({ ...RUN, args: 'corrige aquele erro de acento B' })
  await clock.advance(10)
  w.pending[2]?.resolve(out('B'))
  await clock.settle()
  w.pending[1]?.resolve(out('A2'))
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: 'Objetivo: corrigir o acento B' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Objetivo: corrigir o acento A2' })).toBeUndefined()
})

/** Outro plugin fecha o painel: o evento ui.close passa pelo hook do prompt-pro como o fechar da pessoa. */
const CLOSER = {
  name: 'closer',
  register(on: On) {
    on('command.run', { command: 'fecha' }, async $ => {
      await $.ui.close({ id: 'prompt-pro' })
      return {}
    })
  },
}

test('painel fechado: a resposta tardia não reabre estado nem preenche a caixa', { plugins: [CLOSER] }, async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await $.command.run({ ...RUN, args: 'corrige aquele erro de acento que você achou' })
  await clock.advance(10)
  await $.command.run({ ...RUN, command: 'fecha', args: '' })
  w.pending[0]?.resolve(out('A'))
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'prompt-pro', surface: 'terminal', ...PANE, props: { bodyColumns: 120 } as never })
  expect(await ui.find({ type: 'Text', text: 'Nada em curso' })).toBeDefined()
  expect(w.filled).toEqual([])
})

test('C: pedido novo que passa intacto (/prompt-pro /help) invalida a melhoria em curso (sequência do Codex)', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await $.command.run({ ...RUN, args: 'corrige aquele erro de acento A' })
  await clock.advance(10)
  expect(w.pending).toHaveLength(1)
  await $.command.run({ ...RUN, args: '/help' })
  expect(w.filled).toEqual(['/help'])
  w.pending[0]?.resolve(out('A'))
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'prompt-pro', surface: 'terminal', ...PANE, props: { bodyColumns: 120 } as never })
  expect(await ui.find({ type: 'Text', text: 'Objetivo: corrigir o acento A' })).toBeUndefined()
  expect(await ui.find({ key: 'apply' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Nada em curso' })).toBeDefined()
})

test('C: pergunta clara que passa intacta também invalida a melhoria em curso', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await $.command.run({ ...RUN, args: 'corrige aquele erro de acento A' })
  await clock.advance(10)
  await $.command.run({ ...RUN, args: 'qual versão do node está instalada aqui?' })
  w.pending[0]?.resolve(out('A'))
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'prompt-pro', surface: 'terminal', ...PANE, props: { bodyColumns: 120 } as never })
  expect(await ui.find({ key: 'apply' })).toBeUndefined()
})

test('H: Aplicar, Refazer, ‹ ›, Cancelar e Manter só preenchem a caixa; o espião de prompt.submit não registra nenhum envio', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await $.command.run({ ...RUN, args: 'corrige aquele erro de acento que você achou' })
  await clock.advance(10)
  w.pending[0]?.resolve(out('A'))
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'prompt-pro', surface: 'terminal', ...PANE, props: { bodyColumns: 120 } as never })
  await ui.press({ key: 'redo' })
  await clock.advance(10)
  await ui.press({ key: 'cancel' })
  await ui.press({ key: 'redo' })
  await clock.advance(10)
  w.pending[2]?.resolve(out('B'))
  await clock.settle()
  await ui.press({ key: 'prev' })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'keep' })
  expect(w.filled.at(-1)).toBe('corrige aquele erro de acento que você achou')
  await ui.unmount()
  await $.command.run({ ...RUN, args: 'corrige aquele erro de acento que você achou' })
  await clock.advance(10)
  w.pending[3]?.resolve(out('C'))
  await clock.settle()
  const ui2 = await $.ui.mount({ plugin: 'prompt-pro', surface: 'terminal', ...PANE, props: { bodyColumns: 120 } as never })
  await ui2.press({ key: 'apply' })
  expect(w.filled.at(-1)).toContain('Objetivo: corrigir o acento C')
  expect(w.submitted).toEqual([])
})

test('2: leitura das regras ainda pendente quando chega /prompt-pro /help: o pedido antigo não inicia nem publica (caso do Codex)', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  w.holdReads = true
  const first = $.command.run({ ...RUN, args: 'corrige aquele erro de acento A' })
  await clock.settle()
  expect(w.heldReads.length).toBeGreaterThan(0)
  w.holdReads = false
  await $.command.run({ ...RUN, args: '/help' })
  for (const release of w.heldReads.splice(0)) release()
  await first
  await clock.advance(10)
  expect(w.pending).toHaveLength(0)
  const ui = await $.ui.mount({ plugin: 'prompt-pro', surface: 'terminal', ...PANE, props: { bodyColumns: 120 } as never })
  expect(await ui.find({ key: 'apply' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Nada em curso' })).toBeDefined()
  expect(w.filled).toEqual(['/help'])
})

for (const [name, args] of [['session.messages', 'corrige aquele erro de acento A'], ['prompt.read', '']] as const) {
  test(`2: ${name} ainda pendente quando chega /prompt-pro /help: o pedido antigo não inicia nem publica`, async ($, on) => {
    const w = world(on)
    const clock = mock.clock(on)
    w.box = 'corrige aquele erro de acento A'
    w.hold.add(name)
    const first = $.command.run({ ...RUN, args })
    await clock.settle()
    expect(w.held.length).toBeGreaterThan(0)
    w.hold.clear()
    await $.command.run({ ...RUN, args: '/help' })
    for (const release of w.held.splice(0)) release()
    await first
    await clock.advance(10)
    expect(w.pending).toHaveLength(0)
    const ui = await $.ui.mount({ plugin: 'prompt-pro', surface: 'terminal', ...PANE, props: { bodyColumns: 120 } as never })
    expect(await ui.find({ key: 'apply' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Nada em curso' })).toBeDefined()
    expect(w.filled).toEqual(['/help'])
  })
}
