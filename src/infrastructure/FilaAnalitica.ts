import { Queue, UnrecoverableError, Worker } from "bullmq";
import { Redis } from "ioredis";
import cron, { type ScheduledTask } from "node-cron";
import type { OrigemAnalise, TipoAnalise } from "@prisma/client";
import type { ConfiguracaoFila } from "../config.js";
import type { AtorAuditoria } from "../domain/autorizacao.js";
import type { FiltroAnalise } from "../domain/dados.js";
import { ErroAplicacao } from "../domain/erros.js";
import type { ServicoAnalitico } from "../application/analitico/ServicosAnaliticos.js";
import type { BancoDados } from "./BancoDados.js";

export interface DadosJobRelatorio {
  kind: "RELATORIO_ASSINCRONO";
  tarefaId: string;
  tipo: TipoAnalise;
  filtro: FiltroAnalise;
  origem: OrigemAnalise;
  ator?: AtorAuditoria;
}

export interface DadosJobRecorrente {
  kind: "CICLO_RECORRENTE";
  organizacaoId?: string;
}

export type DadosJobAnalitico = DadosJobRelatorio | DadosJobRecorrente;

export interface FilaAnalitica {
  readonly modo: "bullmq-redis" | "memoria";
  iniciar(): Promise<void>;
  enfileirarRelatorio(job: Omit<DadosJobRelatorio, "kind">): Promise<void>;
  executarRecorrenteAgora(): Promise<void>;
  saude(): Promise<{ modo: "bullmq-redis" | "memoria"; status: "conectado" | "ativo" }>;
  fechar(): Promise<void>;
}

const NOME_FILA = "greencode-analitico";
const ID_AGENDADOR = "ciclo-analitico-recorrente";

function erroRecuperavel(erro: unknown): boolean {
  if (erro instanceof ErroAplicacao) return erro.status >= 500;
  return true;
}

async function processarRelatorio(
  banco: BancoDados,
  analitico: ServicoAnalitico,
  dados: DadosJobRelatorio,
  tentativa: number,
  maxTentativas: number,
) {
  await banco.repositorios.analitico.atualizarTarefa(dados.tarefaId, {
    status: "PROCESSANDO", tentativas: tentativa, iniciadaEm: new Date(), ultimoErro: null,
  });
  try {
    const relatorio = await analitico.executarPorTipo(dados.tipo, dados.filtro, dados.origem, dados.ator);
    await banco.repositorios.analitico.atualizarTarefa(dados.tarefaId, {
      status: "CONCLUIDA", tentativas: tentativa, relatorioId: relatorio.id,
      concluidaEm: new Date(), ultimoErro: null,
    });
    return { relatorioId: relatorio.id };
  } catch (erro) {
    const mensagem = (erro instanceof Error ? erro.message : String(erro)).slice(0, 1000);
    const recuperavel = erroRecuperavel(erro);
    const esgotou = !recuperavel || tentativa >= maxTentativas;
    await banco.repositorios.analitico.atualizarTarefa(dados.tarefaId, {
      status: esgotou ? "FALHOU" : "PENDENTE",
      tentativas: tentativa, ultimoErro: mensagem,
      concluidaEm: esgotou ? new Date() : null,
    });
    if (!recuperavel) throw new UnrecoverableError(mensagem);
    throw erro;
  }
}

export class FilaBullMqAnalitica implements FilaAnalitica {
  readonly modo = "bullmq-redis" as const;
  private conexaoFila?: Redis;
  private conexaoWorker?: Redis;
  private fila?: Queue<DadosJobAnalitico>;
  private worker?: Worker<DadosJobAnalitico>;

  constructor(
    private readonly config: ConfiguracaoFila,
    private readonly banco: BancoDados,
    private readonly analitico: ServicoAnalitico,
  ) {}

  async iniciar(): Promise<void> {
    const opcoesRedis = { maxRetriesPerRequest: null, enableReadyCheck: true, connectTimeout: 5000 };
    this.conexaoFila = new Redis(this.config.redisUrl!, opcoesRedis);
    await this.conexaoFila.ping();
    this.fila = new Queue<DadosJobAnalitico>(NOME_FILA, {
      connection: this.conexaoFila,
      defaultJobOptions: {
        attempts: this.config.tentativas,
        backoff: { type: "exponential", delay: this.config.backoffMs },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 1000 },
      },
    });

    if (this.config.cronAnalises) {
      await this.fila.upsertJobScheduler(
        ID_AGENDADOR,
        { pattern: this.config.cronAnalises, tz: this.config.fusoHorario },
        { name: "ciclo-analitico", data: { kind: "CICLO_RECORRENTE" } },
      );
    }

    if (this.config.workerEmbutido) {
      this.conexaoWorker = new Redis(this.config.redisUrl!, opcoesRedis);
      await this.conexaoWorker.ping();
      this.worker = new Worker<DadosJobAnalitico>(
        NOME_FILA,
        async job => {
          if (job.data.kind === "CICLO_RECORRENTE") {
            await this.analitico.executarCicloAgendado(job.data.organizacaoId);
            return { cicloConcluido: true };
          }
          const tentativa = job.attemptsStarted || (job.attemptsMade + 1);
          const maxTentativas = job.opts.attempts ?? this.config.tentativas;
          return processarRelatorio(this.banco, this.analitico, job.data, tentativa, maxTentativas);
        },
        { connection: this.conexaoWorker, concurrency: this.config.concorrencia },
      );
      await this.worker.waitUntilReady();
    }
  }

  async enfileirarRelatorio(job: Omit<DadosJobRelatorio, "kind">): Promise<void> {
    if (!this.fila) throw new ErroAplicacao(503, "FILA_INDISPONIVEL", "A fila de processamento não está pronta.");
    await this.fila.add("gerar-relatorio", { kind: "RELATORIO_ASSINCRONO", ...job }, { jobId: job.tarefaId });
  }

  async executarRecorrenteAgora(): Promise<void> {
    await this.analitico.executarCicloAgendado();
  }

  async saude(): Promise<{ modo: "bullmq-redis"; status: "conectado" }> {
    if (!this.conexaoFila) throw new ErroAplicacao(503, "FILA_INDISPONIVEL", "Fila Redis desconectada.");
    await this.conexaoFila.ping();
    return { modo: "bullmq-redis", status: "conectado" };
  }

  async fechar(): Promise<void> {
    await this.worker?.close();
    await this.fila?.close();
    await this.conexaoWorker?.quit().catch(() => this.conexaoWorker?.disconnect());
    await this.conexaoFila?.quit().catch(() => this.conexaoFila?.disconnect());
  }
}

export class FilaMemoriaAnalitica implements FilaAnalitica {
  readonly modo = "memoria" as const;
  private readonly pendentes: DadosJobRelatorio[] = [];
  private readonly temporizadores = new Set<NodeJS.Timeout>();
  private readonly emExecucao = new Set<Promise<void>>();
  private agendamento?: ScheduledTask;
  private ativos = 0;
  private encerrando = false;

  constructor(
    private readonly config: ConfiguracaoFila,
    private readonly banco: BancoDados,
    private readonly analitico: ServicoAnalitico,
  ) {}

  async iniciar(): Promise<void> {
    if (this.config.cronAnalises) {
      this.agendamento = cron.schedule(
        this.config.cronAnalises,
        () => { void this.executarRecorrenteAgora(); },
        { timezone: this.config.fusoHorario, noOverlap: true },
      );
    }
  }

  async enfileirarRelatorio(job: Omit<DadosJobRelatorio, "kind">): Promise<void> {
    if (this.encerrando) throw new ErroAplicacao(503, "FILA_INDISPONIVEL", "A fila está em processo de encerramento.");
    this.pendentes.push({ kind: "RELATORIO_ASSINCRONO", ...job });
    this.drenar();
  }

  async executarRecorrenteAgora(): Promise<void> {
    if (this.encerrando) return;
    const promessa = this.analitico.executarCicloAgendado().then(() => undefined, () => undefined);
    this.rastrear(promessa);
    await promessa;
  }

  async saude(): Promise<{ modo: "memoria"; status: "ativo" }> {
    return { modo: "memoria", status: "ativo" };
  }

  async fechar(): Promise<void> {
    this.encerrando = true;
    await this.agendamento?.stop();
    await this.agendamento?.destroy();
    for (const timer of this.temporizadores) clearTimeout(timer);
    this.temporizadores.clear();
    this.pendentes.length = 0;
    await Promise.allSettled([...this.emExecucao]);
  }

  private rastrear(promessa: Promise<void>) {
    this.emExecucao.add(promessa);
    void promessa.finally(() => this.emExecucao.delete(promessa));
  }

  private drenar() {
    if (this.encerrando || !this.config.workerEmbutido) return;
    while (this.ativos < this.config.concorrencia && this.pendentes.length > 0) {
      const proximo = this.pendentes.shift()!;
      this.ativos++;
      const execucao = this.executarComRetry(proximo, 1).finally(() => {
        this.ativos--;
        this.drenar();
      });
      this.rastrear(execucao);
    }
  }

  private async executarComRetry(job: DadosJobRelatorio, tentativa: number): Promise<void> {
    try {
      await processarRelatorio(this.banco, this.analitico, job, tentativa, this.config.tentativas);
    } catch (erro) {
      if (this.encerrando || erro instanceof UnrecoverableError || tentativa >= this.config.tentativas) return;
      const atraso = this.config.backoffMs * (2 ** (tentativa - 1));
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          this.temporizadores.delete(timer);
          resolve();
        }, atraso);
        this.temporizadores.add(timer);
      });
      if (!this.encerrando) await this.executarComRetry(job, tentativa + 1);
    }
  }
}

export function criarFilaAnalitica(config: ConfiguracaoFila, banco: BancoDados, analitico: ServicoAnalitico): FilaAnalitica {
  return config.redisUrl
    ? new FilaBullMqAnalitica(config, banco, analitico)
    : new FilaMemoriaAnalitica(config, banco, analitico);
}
