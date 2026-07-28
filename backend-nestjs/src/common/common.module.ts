import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StaffAssignment } from '../accounts/entities/staff-assignment.entity';
import { Neighborhood } from '../neighborhoods/entities/neighborhood.entity';
import { AuditService } from './audit.service';
import { CryptoService } from './crypto.service';
import { AuditLog } from './entities/audit-log.entity';
import { ScopeService } from './scope.service';

/**
 * Global: ScopeService lo necesita casi todo controlador (QUÉ puede ver este
 * usuario), CryptoService es el único lugar donde se cifran los códigos RF, y
 * AuditService registra toda acción sensible.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([Neighborhood, StaffAssignment, AuditLog]),
  ],
  providers: [ScopeService, CryptoService, AuditService],
  exports: [ScopeService, CryptoService, AuditService],
})
export class CommonModule {}
