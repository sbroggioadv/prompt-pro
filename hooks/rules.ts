// Leitura das regras de escrita: a skill embutida no pacote (padrão) ou uma pasta configurada (substituta).
import type { RuleDoc, Rules } from './core'

/** Nome com que a origem embutida aparece no painel. */
export const EMBEDDED_ORIGIN = 'skill embutida'

/** Arquivos lidos de uma pasta de regras, na ordem em que entram no pedido ao modelo. */
export const RULE_FILES = ['SKILL.md', 'references/canonical-blocks.md'] as const

export type RulesRead = (path: string) => Promise<string>
export type RulesResult = Rules | { missing: string }

/** Pasta das regras: a configurada (já resolvida) ou `skill/` dentro do pacote. */
export const rulesDirectory = (configured: string, pluginRoot: string): string =>
  configured !== '' ? configured : `${pluginRoot.replace(/\/$/, '')}/skill`

/** Lê os arquivos inteiros; o primeiro que faltar devolve o caminho dele (fail-closed). */
export const loadRules = async (
  read: RulesRead,
  digest: (text: string) => Promise<string>,
  dir: string,
  origin: string,
): Promise<RulesResult> => {
  const docs: RuleDoc[] = []
  for (const name of RULE_FILES) {
    try {
      docs.push({ name, text: await read(`${dir}/${name}`) })
    } catch {
      return { missing: `${dir}/${name}` }
    }
  }
  return { origin, docs, sha: await digest(docs.map(d => d.text).join('\n')) }
}
