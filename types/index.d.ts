/** Idioma em que o prompt melhorado tem de sair, detectado no rascunho. */
export type PromptProLang = 'pt-BR' | 'en'

/** O que a sessão oferece para resolver referências do rascunho (D4). */
export type PromptProContext = {
  /** Texto da última resposta do assistente, já cortado. */
  lastAssistant: string
  /** Último prompt da pessoa antes do comando, já cortado. */
  lastUser: string
  /** Caminhos usados por ferramentas nas mensagens recentes, mais recentes primeiro. */
  paths: string[]
  /** Raiz do projeto da sessão. */
  root: string
}

/** Um pedido de melhoria: o rascunho e o contexto capturado quando o comando rodou. */
export type PromptProJob = {
  draft: string
  context: PromptProContext
  lang: PromptProLang
}

/** Uma versão gerada do prompt melhorado. */
export type PromptProVersion = {
  text: string
  /** Avisos mostrados no painel (idioma, caminho, injeção, delimitador). */
  warnings: string[]
  /** Falso quando o Aplicar fica bloqueado (idioma divergente, ação de risco não pedida). */
  canApply: boolean
  model: string
  effort: string
  ms: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /** sha256 curto das regras lidas. */
  rulesSha: string
}

export type PromptProStatus = 'idle' | 'loading' | 'ready' | 'error'

/** Um polimento concluído da sessão, guardado inteiro para o histórico do painel. */
export type PromptProHistoryEntry = {
  /** Hora em que terminou (ms). */
  at: number
  model: string
  effort: string
  original: string
  improved: string
  canApply: boolean
}

/** Tudo o que o painel desenha. */
export type PromptProPanel = {
  status: PromptProStatus
  original: string
  versions: PromptProVersion[]
  index: number
  message: string
  job: PromptProJob | null
  /** Preferências carregadas de `$.store` (ou da configuração). Falso até o primeiro uso. */
  ready: boolean
  /** Modo automático: Enter segura o prompt e abre o painel. */
  auto: boolean
  /** Modelo do polimento ("" = o da sessão) e esforço escolhidos. */
  model: string
  effort: string
  /** Modelo da sessão, detectado por `$.session.model()`. */
  sessionModel: string
  /** Polimentos da sessão, do mais antigo ao mais recente. */
  history: PromptProHistoryEntry[]
  /** Entrada do histórico em exibição; null mostra o polimento corrente. */
  viewing: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-pro': { panel: PromptProPanel }
  }
}
