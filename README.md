# prompt-pro

Mod do Claude Code que melhora o rascunho do seu prompt antes de ele ser enviado. Você escreve do jeito que vem à cabeça; o mod reescreve com objetivo claro, caminhos exatos, critério de pronto e dúvidas marcadas, e mostra **o original e o melhorado lado a lado**. Você escolhe: **Aplicar**, **Refazer** ou **Manter original**. Nada é enviado sozinho.

As regras de escrita vêm da skill `opus-5-5-converter` (guia de prompt para o Claude Opus 5.5), que já vem **embutida no mod**: não precisa instalar mais nada.

## O que faz

- **Modo automático.** Com o AUTO ligado, o Enter de um prompt que merece melhoria fica retido ("segurado para melhorar"), o painel abre e o texto só segue depois da sua escolha. Com o AUTO desligado (padrão), o Enter envia normalmente e o mod só age quando você chama `/prompt-pro`.
- **Painel em quadros.** Cabeçalho com a referência (Guia Opus 5.5) e o estado (Revisão), quadro "Prompt original" e quadro "Prompt melhorado", cada um com a contagem de caracteres, e os botões Aplicar, Refazer e Manter original.
- **Modelo e esforço à escolha.** O painel mostra o modelo da sessão e deixa escolher o modelo do polimento (`opus`, `sonnet`, `haiku` ou o modelo da sessão) e o esforço (`low` a `max`), por exemplo `sonnet (low)`. A escolha fica guardada entre sessões.
- **Histórico da sessão.** Lista cada polimento (hora, modelo, esforço, tamanho original → melhorado). Dá para navegar e aplicar ou manter qualquer um.
- **Comando manual.** `/prompt-pro <rascunho>` funciona com o AUTO ligado ou desligado. Sem texto, usa o que está na caixa; caixa vazia abre o painel para você ligar o AUTO ou escolher o modelo.
- **Passa intacto.** Comandos (`/`, `!`, `*`, `@`), perguntas curtas e claras e prompts com anexo seguem direto, sem chamar o modelo.
- **Trava de idioma.** A saída vem no idioma do rascunho, em português do Brasil com acentuação. Alfabeto fora do latino ou falta de acento: uma nova tentativa automática; se persistir, o Aplicar fica bloqueado (Refazer e Manter continuam).

## Exemplo

Rascunho:

```
corrige aquele erro de acento que você achou
```

Melhorado (com o contexto da sessão):

```
Objetivo: corrigir a acentuação apontada na sua última resposta.
Contexto: em src/utils/format.ts, linha 42, "funcao" deve ser "função".
Pronto quando: a linha 42 estiver corrigida e você mostrar o trecho alterado.
Dúvida: corrijo só essa ocorrência ou todas as palavras sem acento do arquivo?
```

O que o rascunho deixou em aberto vira `Dúvida:`; o mod não inventa requisito nem caminho.

## Instalação

Num terminal, com o Claude Code:

```bash
claude plugin marketplace add sbroggioadv/prompt-pro
claude plugin install prompt-pro@prompt-pro
```

Depois de instalar, abra uma sessão nova (ou rode `/reload-plugins`) e teste com `/prompt-pro corrige o erro daquele arquivo`.

## Como usar

1. **Manual:** `/prompt-pro <rascunho>`. O painel abre e mostra o resultado.
2. **Automático:** ligue o AUTO no cabeçalho do painel (botão "AUTO desligado") ou em `auto` nas configurações do mod. A partir daí, Enter num prompt não trivial abre o painel.
3. No painel:
   - **Aplicar** põe o texto melhorado na caixa do prompt. Você revisa e aperta Enter para enviar.
   - **Manter original** devolve o seu rascunho à caixa.
   - **Refazer** pede uma nova versão (use `‹ versão` e `versão ›` para comparar as versões da mesma rodada).
   - **modelo ›** e **esforço ›** trocam o modelo e o esforço do polimento.
   - **‹ anterior** e **próximo ›** percorrem o histórico; **voltar ao atual** retorna ao polimento corrente.
4. **Enter depois de Aplicar ou Manter envia direto**: o texto devolvido tem uma passagem livre, uma vez, para o Enter não reabrir o painel em laço.

## Configurações

| Opção | Padrão | O que faz |
|---|---|---|
| `auto` | desligado | Liga o modo automático na primeira vez. O botão do painel prevalece depois e fica guardado. |
| `model` | vazio (modelo da sessão) | Modelo inicial do polimento: alias (`opus`, `sonnet`, `haiku`) ou id completo. |
| `effort` | `medium` | Esforço inicial: `low`, `medium`, `high`, `xhigh` ou `max`. |
| `rulesDir` | vazio (skill embutida) | Pasta com `SKILL.md` e `references/canonical-blocks.md` para usar no lugar da skill embutida. `~` vira a sua pasta. Se a pasta não tiver os arquivos, nada é melhorado. |

## O que é enviado ao modelo

Cada polimento faz **uma chamada ao modelo da sua própria sessão do Claude Code** (a mesma conta e o mesmo provedor que você já usa). O pedido leva:

- o seu **rascunho**;
- o **contexto recente da sessão**: o texto da última resposta do assistente (cortado), o seu último prompt antes deste, os caminhos de arquivos que as ferramentas usaram nas mensagens recentes e a raiz do projeto;
- as **regras de escrita** (a skill embutida, ou a da pasta `rulesDir`).

O mod não faz outra chamada de rede, não tem telemetria e não grava nada além das suas preferências (AUTO, modelo e esforço) no armazenamento do próprio mod. O contexto da sessão entra delimitado e declarado como dado: instruções escritas dentro dele não são obedecidas. Mesmo assim, **leia o resultado no painel antes de Aplicar**: é a barreira final.

## Limites

- O texto enviado ao modelo manda ele pedir `CONFIRMO` (a palavra, digitada por você) antes de ações irreversíveis que o seu rascunho mencione, como apagar, `push` ou reset.
- A skill embutida cita uma skill irmã (`fable-converter`) que não vem neste pacote; a referência é só texto e não afeta o funcionamento.
- O Enter só é retido quando vem do teclado do terminal. Prompts de outros caminhos (SDK, ponte remota, tarefas agendadas, outros plugins) passam sem alteração.
- Cada Enter retido gasta uma chamada de modelo e alguns segundos. Por isso o AUTO nasce desligado e perguntas curtas e claras passam direto.
- A passagem livre depois de Aplicar ou Manter some se o mod for recarregado; nesse caso o próximo Enter abre o painel mais uma vez.
- A trava de acentuação é uma heurística de lista de palavras e terminações: pega as faltas comuns, não é um revisor ortográfico.
- Idiomas tratados: português do Brasil e inglês. O histórico vale só para a sessão atual.
- Exige uma versão do Claude Code com mods e o evento `prompt.submit`.

## Desenvolvimento

```bash
claude plugin validate .
claude plugin test .
```

Os testes rodam sem rede, com modelo, disco, relógio e loja simulados.

## Licença

[MIT](LICENSE), Copyright (c) 2026 Luis Sbroggio. O arquivo `skill/references/canonical-blocks.md` contém um trecho de terceiro sob Apache 2.0; veja [NOTICE](NOTICE) e [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt).
