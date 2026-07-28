import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog } from './entities/audit-log.entity';

export interface AuditEntry {
  actorUserId: number | null;
  /** 'quota.update', 'contract.sign', 'neighborhood.transfer', 'remote_code.reveal'... */
  action: string;
  entityType: string;
  entityId?: number | string | null;
  accountId?: number | null;
  neighborhoodId?: number | null;
  oldValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
}

/**
 * Auditoría append-only. La regla: registrar NUNCA puede romper la operación
 * que se está auditando — si el INSERT falla, se grita en el log y la request
 * sigue. Lo que sí es innegociable es INTENTARLO en toda acción sensible:
 * cupos, contratos, transferencias, roles, claim de equipos, reveal de códigos.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly audits: Repository<AuditLog>,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.audits.save(
        this.audits.create({
          actorUserId: entry.actorUserId,
          action: entry.action,
          entityType: entry.entityType,
          entityId:
            entry.entityId === undefined || entry.entityId === null
              ? null
              : String(entry.entityId),
          accountId: entry.accountId ?? null,
          neighborhoodId: entry.neighborhoodId ?? null,
          oldValue: entry.oldValue ?? null,
          newValue: entry.newValue ?? null,
          metadata: entry.metadata ?? null,
          ipAddress: entry.ipAddress ?? null,
        }),
      );
    } catch (error) {
      this.logger.error(
        `No se pudo registrar la auditoría de ${entry.action} sobre ` +
          `${entry.entityType} ${entry.entityId ?? ''}: ${String(error)}`,
      );
    }
  }
}
