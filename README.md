# GreenCode — AV3

Plataforma analítica e API pública/interna para gestão de logística reversa de equipamentos eletrônicos, desenvolvida com **Node.js, TypeScript, Fastify, Prisma ORM, PostgreSQL, simple-statistics, BullMQ/Redis e node-cron**.

Esta terceira etapa evolui o monólito transacional da AV2 para uma plataforma de inteligência de negócios e integração com o ecossistema externo, sustentada por três pilares:

1. **Camada analítica e preditiva** organizada em serviços independentes, com execução síncrona, recorrente em segundo plano e assíncrona sob demanda, persistindo resultados imutáveis no PostgreSQL para consulta histórica.
2. **API pública documentada (OpenAPI/Swagger)** segregada em `/api/v1/public`, autenticada por chaves de API únicas (`X-API-Key`) com escopos granulares por contrato comercial, versionamento semântico explícito e limites de taxa (`@fastify/rate-limit`) por parceiro.
3. **Orquestração assíncrona com filas (BullMQ + Redis, com fallback em memória + node-cron)** para geração de relatórios analíticos pesados em `JSON` ou `CSV`, utilizando o padrão `202 Accepted` + polling de status + download.

---

## Executar

Pré-requisitos: **Node.js 22.12 ou superior**, **PostgreSQL 17** e, opcionalmente, **Redis 7** (para fila distribuída BullMQ). O `compose.yaml` disponibiliza PostgreSQL e Redis via Docker; o sistema também funciona sem Docker/Redis utilizando um PostgreSQL local e a fila em memória embutida.

Entre na pasta `AV3-Greencode` e copie a configuração:

```powershell
# Windows 10+ / PowerShell
Copy-Item .env.example .env
```

```sh
# Linux Ubuntu 24.04.03+ e derivados
cp .env.example .env
```

Defina `JWT_SECRET` no `.env` (mínimo de 32 bytes). Para gerar uma chave segura:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Os próximos comandos são idênticos em Windows e Linux:

```sh
npm ci
npm run db:generate
docker compose up -d --wait
npm run db:migrate
npm run db:seed
npm run dev
```

Caso utilize PostgreSQL local sem Redis, remova ou deixe `REDIS_URL` vazio no `.env` e execute os comandos a partir de `npm ci` (sem o `docker compose`).

- **API Interna (v1):** <http://localhost:3333/api/v1/internal> (também disponível em `/api` por retrocompatibilidade com a AV2)
- **API Pública (v1):** <http://localhost:3333/api/v1/public>
- **Swagger UI:** <http://localhost:3333/docs/>
- **OpenAPI JSON:** <http://localhost:3333/docs/json>
- **Saúde, banco e fila:** <http://localhost:3333/health>

Para compilar e executar em produção (servidor HTTP e, quando `WORKER_EMBUTIDO=false`, worker BullMQ dedicado):

```sh
npm run build
npm start
# Em outro terminal/processo quando utilizar workers separados com Redis:
npm run worker
```

`Ctrl+C` (`SIGINT`) ou `SIGTERM` inicia o encerramento controlado (graceful shutdown): o servidor recusa novas conexões, aguarda as requisições e jobs em andamento, encerra o agendador/worker e desconecta o Prisma e o Redis dentro do limite de 30 segundos.

### Configuração

| Variável | Finalidade |
| --- | --- |
| `DATABASE_URL` | Conexão PostgreSQL usada pelo servidor, worker, Prisma CLI e seed |
| `HOST` | Interface de escuta HTTP; padrão `127.0.0.1` |
| `PORT` | Porta HTTP; padrão `3333` |
| `JWT_SECRET` | Chave de assinatura dos tokens JWT internos, com pelo menos 32 bytes |
| `JWT_EXPIRES_IN` | Validade do JWT; padrão `30m` |
| `CORS_ORIGINS` | Origens permitidas separadas por vírgula |
| `SEED_PASSWORD` | Senha inicial das quatro contas internas de demonstração |
| `REDIS_URL` | Conexão Redis (`redis://...` ou `rediss://...`). Quando ausente, ativa fila em memória e `node-cron` |
| `WORKER_EMBUTIDO` | `true` (padrão) processa a fila no processo HTTP; `false` delega a processos `npm run worker` |
| `WORKER_CONCORRENCIA` | Número de relatórios assíncronos processados simultaneamente por worker (1 a 32; padrão `2`) |
| `FILA_TENTATIVAS` | Máximo de tentativas por job com falha recuperável (1 a 20; padrão `4`) |
| `FILA_BACKOFF_MS` | Atraso base do backoff exponencial entre tentativas em milissegundos (padrão `5000`) |
| `ANALISES_CRON` | Expressão cron do ciclo analítico recorrente (padrão `0 3 * * *`) ou `desativado` |
| `ANALISES_FUSO` | Fuso horário IANA do agendamento recorrente (padrão `America/Sao_Paulo`) |
| `LOGIN_POR_MINUTO` | Limite de tentativas de login por IP por minuto (padrão `10`) |

### Dados de exemplo

O seed transacional e idempotente (`npm run db:seed`) cria:

- Quatro contas internas (`admin`, `operador`, `gestor` e `auditor`) com a senha definida em `SEED_PASSWORD`.
- Duas organizações (`Circular Tecnologia Ltda.` com contrato ativo e `Cooperativa em cadastro` sem contrato).
- Quatro lotes da organização Circular com equipamentos distribuídos ao longo de diferentes anos de fabricação, estados físicos, etapas de triagem/destinação e valores de recuperação apurados.
- Uma chave de API de demonstração vinculada à `Circular Tecnologia Ltda.` com todos os escopos habilitados e limite de 120 requisições/minuto:
  ```text
  gc_live_c0ffee26_11223344556677889900aabbccddeeff0011223344556677
  ```

---

## Utilizar as APIs

### 1. API Interna e Administrativa (`/api/v1/internal` e `/api`)

Autentique-se via `POST /api/v1/internal/auth/login` e informe o token em `Authorization: Bearer SEU_TOKEN`.

| Método | Caminho | Finalidade | Permissão |
| --- | --- | --- | --- |
| POST | `/auth/login` | Autenticar e emitir JWT (com rate limit por IP) | Público |
| GET | `/auth/me` | Consultar conta autenticada e versão | Todos |
| PATCH | `/auth/senha` | Alterar a própria senha e revogar tokens anteriores | Todos |
| GET, POST | `/usuarios` | Listar e criar contas internas | Administrador |
| PATCH | `/usuarios/:id` | Alterar papel ou ativação e revogar tokens | Administrador |
| GET, POST | `/chaves-api` | Listar e emitir chaves de API únicas para parceiros | Administrador |
| PATCH | `/chaves-api/:id` | Alterar escopos/limite de taxa ou revogar chave | Administrador |
| GET, POST, PATCH | `/organizacoes...`, `/contratos...` | Gestão de organizações e contratos | Admin / Operador |
| GET, POST, PATCH | `/lotes...`, `/equipamentos...` | Recebimento, triagem, movimentação e destinação | Admin / Gestor |
| GET | `/relatorios/...`, `/auditoria` | Relatórios transacionais e trilha de auditoria | Admin / Auditor |
| GET | `/analitico/eficiencia` | Calcular e persistir eficiência operacional de triagem | Admin / Auditor |
| GET | `/analitico/rentabilidade` | Calcular e persistir rentabilidade por tipo/marca/modelo/estado | Admin / Auditor |
| GET | `/analitico/vida-util` | Projetar vida útil remanescente (OLS) e persistir previsões | Admin / Auditor |
| GET | `/analitico/relatorios` | Consultar histórico de relatórios analíticos persistidos | Admin / Auditor |
| GET | `/analitico/relatorios/:id` | Obter relatório analítico histórico completo | Admin / Auditor |
| POST, GET | `/analitico/tarefas` | Enfileirar e listar relatórios analíticos assíncronos | Admin / Auditor |
| GET | `/analitico/tarefas/:id` | Consultar status da tarefa assíncrona (polling) | Admin / Auditor |
| GET | `/analitico/tarefas/:id/download` | Baixar relatório concluído em `JSON` ou `CSV` | Admin / Auditor |

### 2. API Pública para Parceiros (`/api/v1/public`)

Projetada para integração direta com sistemas de gestão de ativos, cooperativas e ferramentas de auditoria externa. Todas as requisições exigem o cabeçalho `X-API-Key` e operam estritamente isoladas na organização vinculada à chave:

```http
X-API-Key: gc_live_c0ffee26_11223344556677889900aabbccddeeff0011223344556677
X-API-Version: 1.0.0
```

O cabeçalho opcional `X-API-Version` valida a compatibilidade semântica (aceita `1`, `1.0` ou `1.0.0` na rota `/api/v1/public` e retorna `400 VERSAO_API_NAO_SUPORTADA` para versões incompatíveis). Todas as respostas públicas incluem `X-API-Version: 1.0.0`.

| Método | Caminho (`/api/v1/public`) | Finalidade | Escopo exigido |
| --- | --- | --- | --- |
| GET | `/equipamentos` | Listar equipamentos da organização do parceiro | `RASTREABILIDADE_LEITURA` ou `LOTES_*` |
| GET | `/equipamentos/:id` | Consultar rastreabilidade e depreciação por UUID | `RASTREABILIDADE_LEITURA` ou `LOTES_*` |
| GET | `/rastreabilidade/:codigo` | Consultar rastreabilidade pelo código de barras interno | `RASTREABILIDADE_LEITURA` ou `LOTES_*` |
| GET | `/lotes`, `/lotes/:id` | Listar e consultar lotes e peso total do parceiro | `LOTES_LEITURA` ou `LOTES_ESCRITA` |
| POST | `/lotes` | Submeter novo lote com equipamentos atomicamente | `LOTES_ESCRITA` |
| POST | `/lotes/:id/equipamentos` | Adicionar equipamentos a lote ainda em `RECEBIDO` | `LOTES_ESCRITA` |
| GET | `/analitico/eficiencia` | Gerar análise de eficiência operacional do parceiro | `RELATORIOS_ANALITICOS` |
| GET | `/analitico/rentabilidade` | Gerar análise de rentabilidade dos equipamentos do parceiro | `RELATORIOS_ANALITICOS` |
| GET | `/analitico/vida-util` | Gerar projeção preditiva de vida útil remanescente | `RELATORIOS_ANALITICOS` |
| GET | `/analitico/relatorios`, `/analitico/relatorios/:id` | Consultar histórico de relatórios analíticos do parceiro | `RELATORIOS_ANALITICOS` |
| POST | `/relatorios/tarefas` | Solicitar relatório preditivo/analítico assíncrono (`202 Accepted`) | `RELATORIOS_ANALITICOS` |
| GET | `/relatorios/tarefas`, `/relatorios/tarefas/:id` | Listar tarefas e consultar status por polling | `RELATORIOS_ANALITICOS` |
| GET | `/relatorios/tarefas/:id/download` | Baixar arquivo `.csv` ou `.json` quando `CONCLUIDA` | `RELATORIOS_ANALITICOS` |

---

## Relatório Técnico — Decisões Arquiteturais

### 1. Escolha da biblioteca estatística e modelagem dos algoritmos analíticos

Para a camada analítica, adotou-se a biblioteca **`simple-statistics`** em conjunto com a aritmética decimal exata do **`Prisma.Decimal`**, rejeitando a inclusão de `mathjs` ou motores externos em Python/R pelos seguintes motivos:

- **Aderência ao escopo e leveza operacional:** `simple-statistics` é implementada em JavaScript puro, sem dependências transitivas nativas, com tipagem estática para TypeScript e algoritmos determinísticos de complexidade linear ou $O(n \log n)$ para média (`mean`), mediana (`median`), desvio-padrão amostral com correção de Bessel (`sampleStandardDeviation`), quantis (`quantile` para P90) e regressão linear por Mínimos Quadrados Ordinários (`linearRegression`, `linearRegressionLine` e coeficiente de determinação `rSquared`). `mathjs` adicionaria um motor de álgebra simbólica e parser de expressões desnecessário ao domínio, aumentando a superfície de memória do processo Node.js.
- **Eficiência operacional (`ServicoEficienciaOperacional`):** reconstrói a linha do tempo de cada lote a partir de `Lote.dataEntrada` e dos eventos imutáveis de `Movimentacao` (`destino = EM_TRIAGEM` e `destino = AGUARDANDO_DESMONTE`), decompondo o ciclo em **tempo de espera em fila** e **tempo efetivo de execução de triagem**. Agrega os indicadores em três dimensões (`GERAL`, por `OPERADOR` responsável pela conclusão da triagem e por `MES` de entrada para capturar sazonalidade) e identifica automaticamente em `resumo.gargaloEtapa` se o gargalo reside na recepção ou na bancada de triagem.
- **Rentabilidade (`ServicoRentabilidadeEquipamento`):** combina o valor financeiro efetivamente apurado na destinação (`Equipamento.valorRecuperado`) com um modelo paramétrico de estimativa (`RegrasEquipamento.estimarValorRecuperacao`) para ativos ainda em processamento, ponderando massa em quilogramas, cotação base por categoria tecnológica, fator de integridade física e depreciação anual. Os resultados são pré-agregados em quatro níveis (`TIPO`, `TIPO_ESTADO`, `TIPO_MARCA_MODELO` e `TIPO_MARCA_MODELO_ESTADO`) mantendo valores monetários em `Decimal(14,2)` e `Decimal(16,2)`.
- **Vida útil remanescente preditiva (`ServicoVidaUtilPreditiva`):** codifica os sete estados físicos em uma escala ordinal de severidade de degradação $y \in \{0, 1, \dots, 6\}$ (`NOVO = 0` até `INSERVIVEL = 6`) e extrai observações históricas $(x_i, y_i)$, onde $x_i$ é a idade do equipamento em anos na data de entrada e em cada evento de mudança de estado físico (`TipoMovimentacao.ESTADO_FISICO`). Para cada `TipoEquipamento`, ajusta a reta de Mínimos Quadrados Ordinários (OLS):
  $$\hat{y}(x) = \beta_0 + \beta_1 x, \quad \beta_1 = \frac{\sum_{i=1}^{n}(x_i - \bar{x})(y_i - \bar{y})}{\sum_{i=1}^{n}(x_i - \bar{x})^2}, \quad \beta_0 = \bar{y} - \beta_1 \bar{x}$$
  O tempo estimado de vida útil restante para cada equipamento ativo com severidade atual $y_{\text{atual}}$ e idade $x_{\text{atual}}$ é projetado pelo cruzamento com o limiar `INSERVIVEL` ($y = 6$):
  $$T_{\text{remanescente}} = \max\left(0,\; \frac{6 - \max(y_{\text{atual}},\, \beta_0 + \beta_1 x_{\text{atual}})}{\beta_1}\right)$$
  Quando uma categoria ainda possui menos de duas idades distintas ou inclinação não positiva ($\beta_1 \le 0{,}05$), o modelo marca `confiavel = false` e aplica um fallback físico conservador de $0{,}6$ categoria/ano (equivalente à taxa de depreciação de 10% ao ano estabelecida na AV1), garantindo que o relatório nunca produza divisões por zero ou vidas úteis infinitas.

### 2. Modelagem relacional para persistência histórica dos resultados analíticos

Em vez de sobrescrever contadores ou armazenar apenas um blob JSON opaco, os resultados analíticos foram modelados em seis novas tabelas normalizadas no PostgreSQL (`prisma/migrations/202611210001_analises_api_publica/migration.sql`):

- **`RelatorioAnalitico`:** cabeçalho imutável de cada execução (`tipo`, `origem` `AGENDADA | API_INTERNA | API_PUBLICA`, `organizacaoId` opcional para diferenciar análises globais das análises isoladas por cliente, `parametros`, `resumo`, `versaoModelo`, `amostras`, `duracaoMs`, `geradoEm` e referência ao solicitante).
- **`IndicadorEficiencia`:** linhas tipadas por `(relatorioId, dimensao, chave)` com médias de espera, triagem, total, mediana, desvio-padrão e percentil 90.
- **`IndicadorRentabilidade`:** linhas indexadas por `(relatorioId, nivel, valorMedio)` com `Decimal(14,2)` para média, mediana e desvio-padrão e `Decimal(16,2)` para soma total.
- **`ModeloVidaUtil` e `PrevisaoVidaUtil`:** armazenam separadamente os coeficientes estimados por tipo ($\beta_0$, $\beta_1$, $R^2$, idade crítica prevista e flag de confiabilidade) e a previsão individualizada por equipamento ativo (`idadeAtualAnos`, `vidaRemanescenteAnos` e `dataPrevistaInservivel`), com índice composto `(equipamentoId, dataPrevistaInservivel)` para permitir auditoria futura comparando a data prevista de falha com a data real em que o ativo atingir `INSERVIVEL`.
- **`TarefaAnalitica`:** registra o ciclo de vida das solicitações assíncronas (`PENDENTE → PROCESSANDO → CONCLUIDA | FALHOU`), formato solicitado (`JSON` ou `CSV`), número de tentativas, último erro e chave estrangeira para o `RelatorioAnalitico` produzido.

Triggers `BEFORE UPDATE OR DELETE` no PostgreSQL (`relatorio_analitico_imutavel` e correlatos) garantem no nível do SGBD que relatórios analíticos históricos, uma vez gerados, jamais sejam adulterados ou apagados, preservando a rastreabilidade científica para calibração futura dos modelos.

### 3. Segregação da API pública, segurança de chaves de API e rate limiting

- **Segregação de rotas e versionamento:** os endpoints de parceiros ficam isolados sob `/api/v1/public`, enquanto as operações administrativas e de operação interna residem em `/api/v1/internal` (mantendo o alias `/api` para compatibilidade integral com clientes e testes da AV2). A versão semântica é explícita tanto na URL (`/v1/`) quanto no cabeçalho HTTP `X-API-Version`.
- **Criptografia e autenticação de chaves (`ChaveApiCripto`):** cada parceiro recebe uma chave no formato `gc_live_<prefixo_8_hex>_<segredo_48_hex>` gerada com 192 bits de entropia criptográfica (`node:crypto.randomBytes`). O segredo completo é retornado **apenas no `201 Created`**; o banco persiste unicamente o `prefixo` indexado (`UNIQUE`) e o hash `SHA-256` (`hashSegredo`). Na autenticação, a busca utiliza o índice B-Tree do `prefixo` em $O(\log n)$ e compara o hash com `crypto.timingSafeEqual`, eliminando ataques de temporização (timing attacks) e vazamento de credenciais em dumps de banco ou logs (o logger Fastify redige `req.headers.authorization` e `req.headers["x-api-key"]`).
- **Isolamento multi-tenant e escopos:** toda `ChaveApi` pertence a uma `Organizacao` e possui um array de `EscopoChaveApi` (`RASTREABILIDADE_LEITURA`, `LOTES_LEITURA`, `LOTES_ESCRITA`, `RELATORIOS_ANALITICOS`). Os serviços de domínio filtram todas as consultas e escritas pelo `parceiro.organizacaoId` derivado da chave autenticada — um parceiro jamais consegue ler lotes, equipamentos, relatórios ou tarefas de outra organização, nem informar um `organizacaoId` arbitrário no payload. Além disso, as tabelas `Movimentacao` e `Auditoria` possuem constraints `CHECK` de exclusividade (`("responsavelId" IS NOT NULL) <> ("chaveApiId" IS NOT NULL)`), registrando na trilha imutável qual chave de API executou cada operação externa.
- **Rate limiting por cliente (`@fastify/rate-limit`):** cada chave de API possui sua própria cota `limitePorMinuto` configurável contratualmente no banco de dados (1 a 10.000 req/min). O plugin `@fastify/rate-limit` utiliza `request.parceiro.id` como discriminador de janela deslizante, impedindo que um parceiro ruidoso esgote a cota dos demais e respondendo `429 LIMITE_REQUISICOES_EXCEDIDO` no formato padronizado de erro da aplicação. O endpoint de login interno também aplica rate limit por IP.

### 4. Orquestração assíncrona e política de retry para tarefas com falha

Para evitar timeouts HTTP em relatórios analíticos sobre grandes volumes de equipamentos, implementou-se a abstração `FilaAnalitica` (`src/infrastructure/FilaAnalitica.ts`) com duas estratégias intercambiáveis por configuração:

- **Produção distribuída (`FilaBullMqAnalitica`):** utiliza **BullMQ + Redis** (`ioredis`), registrando o identificador UUID da `TarefaAnalitica` como `jobId` no Redis para garantir idempotência de enfileiramento e configurando o agendador recorrente via `Queue.upsertJobScheduler`.
- **Desenvolvimento e testes autocontidos (`FilaMemoriaAnalitica`):** quando `REDIS_URL` não está configurada, utiliza uma fila assíncrona em memória com controle de concorrência, backoff exponencial e agendamento recorrente via **`node-cron`**, permitindo validar todo o fluxo assíncrono em qualquer máquina Windows ou Linux sem dependências externas além do PostgreSQL.
- **Política de retry e classificação de falhas:** jobs analíticos são configurados com até `FILA_TENTATIVAS` execuções (padrão `4`) e **backoff exponencial** de base `FILA_BACKOFF_MS` (padrão `5000 ms`, resultando em esperas de $5\text{s}, 10\text{s}, 20\text{s}$ entre tentativas):
  $$t_{\text{espera}}(k) = t_{\text{base}} \cdot 2^{k - 1}$$
  O processador diferencia **falhas transitórias/recuperáveis** (indisponibilidade momentânea de conexão, conflitos de serialização `40001` no PostgreSQL ou erros HTTP `>= 500`) de **erros determinísticos de domínio** (`ErroAplicacao` com status `4xx`, como parâmetros inválidos ou organização inexistente). Falhas transitórias retornam a tarefa ao estado `PENDENTE`, incrementam o contador `tentativas` e disparam o retry com backoff; erros `4xx` lançam `UnrecoverableError` do BullMQ e encerram imediatamente a tarefa como `FALHOU` na primeira tentativa, evitando desperdício de CPU e conexões de banco em operações que jamais teriam sucesso.

### 5. Plano de evolução arquitetural para centenas ou milhares de parceiros

À medida que o ecossistema do GreenCode escalar para milhares de organizações parceiras e milhões de equipamentos rastreados, a arquitetura atual já prepara a transição gradual sem reescrita do domínio:

1. **Separação horizontal entre nós de API e nós de Workers:** basta definir `WORKER_EMBUTIDO=false` nas instâncias HTTP do Fastify e escalar múltiplos contêineres executando `npm run worker` conectados ao mesmo cluster Redis e PostgreSQL, isolando completamente a latência das requisições REST do consumo de CPU das regressões estatísticas e exportações CSV.
2. **Rate limiting distribuído e API Gateway:** conectar o `@fastify/rate-limit` à instância Redis compartilhada (ou posicionar um API Gateway como Kong/Envoy na borda) para que o limite por minuto de cada `ChaveApi` seja contabilizado globalmente entre múltiplas réplicas HTTP atrás de um balanceador de carga.
3. **Réplicas de leitura e Materialized Views analíticas:** direcionar o `ServicoAnalitico` para uma réplica de leitura do PostgreSQL (ou para tabelas particionadas por `dataEntrada` e Materialized Views atualizadas incrementalmente), evitando que varreduras históricas olap concorram com locks `Serializable` das transações OLTP de recebimento e triagem.
4. **Armazenamento de objetos e entrega por Webhooks assinados:** para relatórios CSV de dezenas de megabytes, substituir a montagem sob demanda no download pelo upload do artefato gerado pelo worker para armazenamento compatível com S3 (com URL pré-assinada de curta duração) e adicionar suporte opcional a `webhookUrl` na solicitação da tarefa, notificando o parceiro via `POST` assinado com HMAC-SHA256 assim que a tarefa atingir `CONCLUIDA`.

---

## Estrutura

```text
src/
  http/controllers/          Rotas internas (/api/v1/internal e /api) e públicas (/api/v1/public)
  http/schemas.ts            Contratos JSON Schema (TypeBox) e documentação OpenAPI 3
  application/               Serviços transacionais, gestão de chaves de API e orquestração de tarefas
  application/analitico/     Serviços independentes de eficiência, rentabilidade e vida útil (OLS)
  domain/                    Regras de negócio, autorização por papel/escopo e estimadores
  infrastructure/            Repositórios Prisma, fila BullMQ/memória, hashing scrypt e SHA-256
  app.ts                     Composição do servidor Fastify, plugins, hooks e segregação de rotas
  server.ts                  Inicialização HTTP e graceful shutdown
  worker.ts                  Processo worker BullMQ dedicado para escalabilidade horizontal
prisma/
  schema.prisma              Modelo relacional completo (transacional + chaves de API + analítico)
  migrations/                Migrações SQL versionadas, constraints CHECK e triggers de imutabilidade
  dadosExemplo.ts            Massa de demonstração idempotente com chave de API de parceiro
  seed.ts                    Comando de carga inicial
test/                        Suíte automatizada de regras, API interna, API pública, fila e análises
```

## Verificações

```sh
npm run check
npx prisma validate
npm test
npm run build
```

`npm test` inicia um **PostgreSQL 17 temporário real** (`embedded-postgres`), aplica todas as migrações SQL (AV2 + AV3), executa o seed idempotente e valida toda a suíte (regras de domínio, jornada transacional completa, regressão linear OLS, eficiência operacional, rentabilidade, agendamento recorrente, chaves de API, escopos, isolamento entre organizações, rate limiting, fila assíncrona com polling, download CSV/JSON e política de retry com backoff).
