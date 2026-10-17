import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const ROOT = '/repo'
const GOOD = '<prompt_pro>Objetivo: corrigir a acentuação apontada.\nPronto quando: a linha estiver corrigida e você mostrar o trecho.</prompt_pro>'
const BARE = '<prompt_pro>Objetivo: corrigir a funcao. Pronto quando: nao houver erro.</prompt_pro>'

type World = { replies: string[]; rules: boolean; filled: string[]; calls: number; system: string[] }

/** O mundo abaixo do plugin: disco, sessão, caixa do prompt e modelo simulados. */
const world = (on: On, w: World): void => {
  mock.env(on, { HOME: '/home/u' })
  mock.store(on)
  on('fs.read', async ($, e) => {
    if (!w.rules) throw new Error('ENOENT')
    if (e.path.endsWith('/skill/SKILL.md')) return { value: 'REGRAS DA SKILL' }
    if (e.path.endsWith('/skill/references/canonical-blocks.md')) return { value: 'BLOCOS' }
    throw new Error('ENOENT')
  })
  on('fs.exists', async () => ({ value: true }))
  on('session.root', async () => ({ value: ROOT }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('session.messages', async () => ({ value: [{ role: 'assistant' as const, text: 'linha 42 tem "funcao"', toolUses: [] }] }))
  on('prompt.read', async () => ({ value: { text: '', cursor: 0 } }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.close', async () => ({ value: undefined }))
  on('command.run', async () => ({}))
  on('prompt.fill', async ($, e) => {
    w.filled.push(e.text)
    return { isFilled: true }
  })
  on('model.complete', async ($, e) => {
    w.system.push(e.system ?? '')
    const text = w.replies[Math.min(w.calls, w.replies.length - 1)] ?? ''
    w.calls += 1
    return { value: { isAnswered: true as const, text, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
}

const fresh = (replies: string[], rules = true): World => ({ replies, rules, filled: [], calls: 0, system: [] })
const RUN = { command: 'prompt-pro', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const
const PANE = { component: 'Pane', requestId: 'prompt-pro', viewport: { columns: 120, rows: 40 } } as const

test('E1: rascunho claro não chama o modelo e volta para a caixa', async ($, on) => {
  const w = fresh([GOOD])
  world(on, w)
  const clock = mock.clock(on)
  await $.command.run({ ...RUN, args: 'qual versão do node está instalada aqui?' })
  await clock.advance(10)
  expect(w.calls).toBe(0)
  expect(w.filled).toEqual(['qual versão do node está instalada aqui?'])
})

test('regras ausentes: fail-closed, sem chamada de modelo', async ($, on) => {
  const w = fresh([GOOD], false)
  world(on, w)
  const clock = mock.clock(on)
  await $.command.run({ ...RUN, args: 'corrige aquele erro de acento que você achou' })
  await clock.advance(10)
  expect(w.calls).toBe(0)
  expect(w.filled).toEqual(['corrige aquele erro de acento que você achou'])
})

test('D8: painel com Aplicar, Refazer e Manter; Aplicar põe o texto na caixa sem enviar', async ($, on) => {
  const w = fresh([GOOD])
  world(on, w)
  const clock = mock.clock(on)
  await $.command.run({ ...RUN, args: 'corrige aquele erro de acento que você achou' })
  await clock.advance(10)
  expect(w.calls).toBe(1)
  expect(w.system[0]).toContain('REGRAS DA SKILL')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'prompt-pro', surface, ...PANE, props: { bodyColumns: 120 } as never })
    expect(await ui.find({ type: 'Text', text: 'Objetivo: corrigir a acentuação' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^corrige aquele erro/ }))?.text).toBe('corrige aquele erro de acento que você achou')
    expect(await ui.find({ key: 'apply' })).toBeDefined()
    expect(await ui.find({ key: 'redo' })).toBeDefined()
    expect(await ui.find({ key: 'keep' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /esforço medium .* regras [0-9a-f]{8}$/ })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ plugin: 'prompt-pro', surface: 'terminal', ...PANE, props: { bodyColumns: 120 } as never })
  await ui.press({ key: 'redo' })
  await clock.advance(10)
  expect(w.calls).toBe(2)
  expect(await ui.find({ type: 'Text', text: /^Prompt melhorado \(v2\/2\) · \d+ caracteres$/ })).toBeDefined()
  await ui.press({ key: 'apply' })
  expect(w.filled.at(-1)).toContain('Objetivo: corrigir a acentuação')
})

test('D5: sem acento duas vezes = aviso e Aplicar fora do painel; Manter devolve o original', async ($, on) => {
  const w = fresh([BARE, BARE])
  world(on, w)
  const clock = mock.clock(on)
  await $.command.run({ ...RUN, args: 'corrige aquele erro de acento que voce achou' })
  await clock.advance(10)
  expect(w.calls).toBe(2)
  const ui = await $.ui.mount({ plugin: 'prompt-pro', surface: 'terminal', ...PANE, props: { bodyColumns: 80 } as never })
  expect(await ui.find({ key: 'apply' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Aplicar bloqueado' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Idioma divergente' })).toBeDefined()
  await ui.press({ key: 'keep' })
  expect(w.filled.at(-1)).toBe('corrige aquele erro de acento que voce achou')
})
