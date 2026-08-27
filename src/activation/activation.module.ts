import { Module } from '@nestjs/common';
import { ActivationController } from './activation.controller';
import { ActivationService } from './activation.service';
import { ActivationAutoService } from './activation-auto.service';

@Module({
  controllers: [ActivationController],
  providers: [ActivationService, ActivationAutoService],
})
export class ActivationModule {}
