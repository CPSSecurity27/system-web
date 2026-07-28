import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Account } from '../accounts/entities/account.entity';
import { Neighborhood } from '../neighborhoods/entities/neighborhood.entity';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { ServiceContract } from './entities/service-contract.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ServiceContract, Account, Neighborhood])],
  controllers: [ContractsController],
  providers: [ContractsService],
  exports: [ContractsService],
})
export class ContractsModule {}
