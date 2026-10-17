# Canvas vs. mod: o que dá e o que não dá

Comparação tela por tela entre o canvas (https://claude.ai/artifact/EJobVufCKs7JAvR63J6GmL) e o mod no app desktop, depois da rodada de 17/10. "Limite da API" cita o tipo do `claude-code` que impede; o resto é implementação.

## Limites reais da API (não dá para igualar)

| O canvas tem | Por que não dá | Onde está na API |
| --- | --- | --- |
| Botão de enviar laranja com seta, campo com borda laranja | O app desenha o campo e o botão dele; só escolhemos o texto do botão | `InputProps`: só `key`, `label`, `placeholder`, `value`, `submitLabel`, `autoFocus`, `onInput`, `onSubmit` |
| Ícones dentro de botões (Arquivos, Membros, Anexar) | Um `Button` aceita só texto e `Text`; o ícone fica ao lado | `ButtonProps.label`: "any other element is refused" |
| Abas Grupos/Contatos laranjas com contador dentro | O app desenha o botão nativo dele; só existe `primary` ou `secondary`. O contador fica ao lado do botão | `ButtonProps.variant` |
| Linhas de 1 px entre as seções | Um `Box` tem uma borda para os quatro lados; a linha é um texto `─` | `BoxProps.borderStyle` (sem borda por lado) |
| Raio de canto exato, sombras | Só `borderStyle="round"`; não há raio nem sombra | `BoxProps` |
| Fonte IBM Plex | Não há fonte; só `mono`, `size` e `weight` | `TextProps` |
| A linha inteira do grupo clicável | O `Button` não pode conter `Box`; o clique fica no nome, e a linha acende ao passar o mouse | `ButtonProps.label` |
| Foto no terminal e no desktop do mesmo jeito | `Image` só existe no terminal; no desktop uso `Svg` | `Elements.desktop` (sem `Image`) |
| Tamanhos em pixels | Largura e altura de `Box` são células de texto; só o `Svg` usa pixels | `Space`, `BoxProps.width` |

## O que mudei para ficar como o canvas

- **Cabeçalho:** foto, nome e "@login · perfil" em duas linhas; contador laranja ao lado de Grupos e Contatos.
- **Chat em grupo:** cabeçalho com ícone #, nome e "N membros", botão Membros com ícone; mensagens com avatar, nome colorido, hora em mono e balões cinza; as suas à direita, sem avatar, em balão laranja.
- **Conversa direta:** avatar e "ativo há … · conversa direta" no cabeçalho, aviso "só vocês dois veem esta conversa", balões sem nome e a hora embaixo.
- **Rodapé:** linha separadora, campo na largura toda (sem a caixa extra em volta), dica dividida em "enter envia" e "só nesta sessão por enquanto".
- **Grupos:** busca, ícone # em quadrado, nome, prévia da última mensagem, hora e "N membros" ou contador de novas; rótulo NOVO GRUPO em caixa alta acima do campo.
- **Contatos:** busca, MAIS RECENTES PRIMEIRO, avatar, nome, "@login · ativo há …", contador e botão Conversar.
- **Membros e perfil:** linhas com avatar; perfil centralizado com cartão Nome / Usuário / GitHub.
- **Vazios:** ícone, título e uma linha em cada tela vazia.

## Ainda não feito (é de fases seguintes do MVP, não limite)

- Anexar, Compartilhar contexto, Passar tarefa, cartões de contexto e de arquivo, "via Claude", tela de Arquivos.
- Adicionar membro e Sair do grupo (dependem dos repositórios no GitHub, fase 3).
- Indicador de não lidas real (vem do polling, fase 3).
