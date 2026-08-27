import { Module } from '@nestjs/common';
import { AgentAlphaService } from './agentalpha.service';
import { AgentAlphaController } from './agentalpha.controller';
import { AuthModule } from '../auth/auth.module';

// SupabaseModule @Global() — tak perlu diimpor.
@Module({
  imports: [AuthModule],
  providers: [AgentAlphaService],
  controllers: [AgentAlphaController],
  exports: [AgentAlphaService],
})
export class AgentAlphaModule {}
