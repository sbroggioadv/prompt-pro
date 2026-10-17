// Regras embutidas (AC5) e preferências (AC3/AC4), em lógica pura.
import { describe, expect, test } from 'claude-code/testing'

import { countChars, cycle, formatTime, historyLine, modelChoices, modelLabel, parseAuto, parsePrefs, shouldHold } from '../hooks/core'
import { EMBEDDED_ORIGIN, loadRules, rulesDirectory } from '../hooks/rules'

const sha = async (text: string): Promise<string> => `len${text.length}`

describe('regras: pasta e leitura', () => {
  test('sem pasta configurada, as regras são skill/ dentro do pacote', () => {
    expect(rulesDirectory('', '/plugins/prompt-pro')).toBe('/plugins/prompt-pro/skill')
    expect(rulesDirectory('', '/plugins/prompt-pro/')).toBe('/plugins/prompt-pro/skill')
    expect(rulesDirectory('/minhas', '/plugins/prompt-pro')).toBe('/minhas')
  })

  test('lê os dois arquivos inteiros, na ordem, só do caminho pedido', async () => {
    const reads: string[] = []
    const r = await loadRules(async p => (reads.push(p), `texto de ${p}`), sha, '/pkg/skill', EMBEDDED_ORIGIN)
    if ('missing' in r) throw new Error(r.missing)
    expect(reads).toEqual(['/pkg/skill/SKILL.md', '/pkg/skill/references/canonical-blocks.md'])
    expect(r.docs.map(d => d.name)).toEqual(['SKILL.md', 'references/canonical-blocks.md'])
    expect(r.origin).toBe('skill embutida')
    expect(r.sha).toMatch(/^len\d+$/)
  })

  test('arquivo ausente devolve o caminho dele, sem regra parcial', async () => {
    const r = await loadRules(
      async p => {
        if (p.endsWith('canonical-blocks.md')) throw new Error('ENOENT')
        return 'x'
      },
      sha,
      '/pkg/skill',
      EMBEDDED_ORIGIN,
    )
    expect(r).toEqual({ missing: '/pkg/skill/references/canonical-blocks.md' })
  })
})

describe('preferências e histórico', () => {
  const base = { model: '', effort: 'medium' } as const

  test('parsePrefs aceita o válido e volta ao padrão no resto', () => {
    expect(parsePrefs({ model: ' sonnet ', effort: 'low' }, base)).toEqual({ model: 'sonnet', effort: 'low' })
    expect(parsePrefs({ model: 3, effort: 'turbo' }, base)).toEqual(base)
    expect(parsePrefs(undefined, base)).toEqual(base)
    expect(parsePrefs('texto', base)).toEqual(base)
    expect(parseAuto(true, false)).toBe(true)
    expect(parseAuto('sim', false)).toBe(false)
    expect(parseAuto(undefined, true)).toBe(true)
  })

  test('cycle anda pela lista, volta ao começo e cai no primeiro se o valor sumiu', () => {
    expect(cycle(['a', 'b', 'c'], 'a')).toBe('b')
    expect(cycle(['a', 'b', 'c'], 'c')).toBe('a')
    expect(cycle(['a', 'b', 'c'], 'z')).toBe('a')
    expect(cycle(['a', 'b', 'c'], 'a', -1)).toBe('c')
  })

  test('modelChoices começa pela sessão e inclui o modelo configurado, se for outro', () => {
    expect(modelChoices('')).toEqual(['', 'opus', 'sonnet', 'haiku'])
    expect(modelChoices('opus')).toEqual(['', 'opus', 'sonnet', 'haiku'])
    expect(modelChoices('claude-x-1')).toEqual(['', 'opus', 'sonnet', 'haiku', 'claude-x-1'])
  })

  test('modelLabel mostra "modelo (esforço)"; vazio mostra o modelo da sessão', () => {
    expect(modelLabel({ model: 'sonnet', effort: 'low' }, 'claude-opus-5-5')).toBe('sonnet (low)')
    expect(modelLabel({ model: '', effort: 'medium' }, 'claude-opus-5-5')).toBe('claude-opus-5-5 (medium)')
    expect(modelLabel({ model: '', effort: 'medium' }, '')).toBe('sessão (medium)')
  })

  test('historyLine: hora, modelo, esforço e tamanho original → melhorado', () => {
    const at = new Date(2026, 9, 17, 14, 5).getTime()
    expect(formatTime(at)).toBe('14:05')
    expect(historyLine({ at, model: 'sonnet', effort: 'low', original: 'abc', improved: 'abcdef', canApply: true })).toBe('14:05 · sonnet (low) · 3 → 6 caracteres')
    expect(historyLine({ at, model: 'sonnet', effort: 'low', original: 'abc', improved: 'a', canApply: false })).toBe('14:05 · sonnet (low) · 3 → 1 caracteres · bloqueado')
    expect(countChars('ação')).toBe(4)
  })
})

describe('shouldHold', () => {
  const composer = { origin: { kind: 'composer' } }
  const draft = 'corrige aquele erro de acento que você achou'

  test('segura só o que a pessoa digitou e o D7 manda melhorar', () => {
    expect(shouldHold({ ...composer, text: draft }, new Set())).toBe(true)
    expect(shouldHold({ ...composer, text: '/status' }, new Set())).toBe(false)
    expect(shouldHold({ ...composer, text: 'Bom dia' }, new Set())).toBe(false)
    expect(shouldHold({ origin: { kind: 'plugin' }, text: draft }, new Set())).toBe(false)
    expect(shouldHold({ ...composer, text: draft, command: {} }, new Set())).toBe(false)
    expect(shouldHold({ ...composer, text: draft, isMeta: true }, new Set())).toBe(false)
    expect(shouldHold({ ...composer, text: draft, attachments: [{}] }, new Set())).toBe(false)
  })

  test('texto devolvido pelo painel não é segurado de novo', () => {
    expect(shouldHold({ ...composer, text: `  ${draft}\n` }, new Set([draft]))).toBe(false)
  })
})
