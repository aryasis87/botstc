import { Global, Module } from '@nestjs/common';
import { ProfileModule } from '../profile/profile.module';
import { PreflightService } from './preflight.service';

/**
 * Modul lintas-fitur untuk "keselamatan" pra-eksekusi. @Global agar
 * PreflightService bisa disuntik ke service mode mana pun tanpa tiap modul
 * mode perlu meng-import ulang.
 */
@Global()
@Module({
  imports: [ProfileModule],
  providers: [PreflightService],
  exports: [PreflightService],
})
export class SafetyModule {}
