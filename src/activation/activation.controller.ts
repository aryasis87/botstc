import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ActivationService } from './activation.service';

/** Portal publik aktivasi Mode REAL — TANPA guard (diakses sebelum login). */
@Controller('activation')
export class ActivationController {
  constructor(private readonly svc: ActivationService) {}

  /** Validasi live ID akun untuk portal aktivasi (publik, tanpa guard). */
  @Get('check-id')
  async checkId(@Query('id') id?: string) {
    return this.svc.checkId(String(id ?? ''));
  }

  @Post('request')
  @HttpCode(200)
  async request(@Body() body: { app?: string; name?: string; stockityId?: string; proof?: string; feature?: string }) {
    return this.svc.request(
      body?.app === 'koala' ? 'koala' : 'stc',
      body?.feature === 'aisignal' ? 'aisignal' : body?.feature === 'blitz5s' ? 'blitz5s' : body?.feature === 'agentalpha' ? 'agentalpha' : 'real',
      String(body?.name ?? '').trim(),
      String(body?.stockityId ?? '').trim(),
      String(body?.proof ?? ''),
    );
  }
}
